import { handleRequest } from '../context'
import { HTTPException } from '../http-exception'
import type { Interceptor } from '../types'
import { getGlobalThis, type FetchContext, type FetchMiddleware } from './fetch'

// ----------------------------------------------------------------------------
// Helpers & Cloaking
// ----------------------------------------------------------------------------

const BODYLESS_STATUS_CODES = [101, 204, 205, 304]

const originalDefineProperty = Object.defineProperty
const originalFunctionToString = Function.prototype.toString

/**
 * Cloaks our patched functions so anti-bot/APM scripts checking .toString()
 * see "[native code]" and do not break execution.
 */
function makeLookNative<T extends Function>(replacementFn: T, nativeFn: Function): T {
  const nativeSource = originalFunctionToString.call(nativeFn)
  originalDefineProperty(replacementFn, 'toString', {
    value() { return nativeSource },
    writable: true,
    configurable: true,
    enumerable: false,
  })
  try {
    originalDefineProperty(replacementFn, 'name', { value: nativeFn.name, configurable: true })
  } catch (_) {}
  try {
    originalDefineProperty(replacementFn, 'length', { value: nativeFn.length, configurable: true })
  } catch (_) {}
  return replacementFn
}

/**
 * Per-instance state stored directly on each XHR object.
 */
interface XHRState {
  method: string
  url: string | URL
  async: boolean
  username?: string | null
  password?: string | null
  headers: Record<string, string>
  body?: Document | XMLHttpRequestBodyInit | null
  responseType: XMLHttpRequestResponseType
  withCredentials: boolean
  timeout: number
  // The original Request built from open()+setRequestHeader()+send() args.
  originReq?: Request
  // The shadow XHR used for the actual native request. The user's XHR never
  // fires native events – we synthesize them after the middleware completes.
  shadow?: XMLHttpRequest
  aborted?: boolean
  // Guard to make sure we only finalize (dispatch load/loadend/error) once.
  done?: boolean
}

const xhrState = new WeakMap<XMLHttpRequest, XHRState>()

function getState(xhr: XMLHttpRequest): XHRState {
  let s = xhrState.get(xhr)
  if (!s) {
    s = {
      method: 'GET',
      url: '',
      async: true,
      headers: {},
      responseType: '',
      withCredentials: false,
      timeout: 0,
    }
    xhrState.set(xhr, s)
  }
  return s
}

function defineInstanceProp(xhr: XMLHttpRequest, prop: string, value: any) {
  originalDefineProperty(xhr, prop, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  })
}

function parseHeadersText(text: string): Record<string, string> {
  return text
    .split('\r\n')
    .filter(Boolean)
    .reduce((acc, line) => {
      const idx = line.indexOf(': ')
      if (idx > -1) acc[line.slice(0, idx)] = line.slice(idx + 2)
      return acc
    }, {} as Record<string, string>)
}

/**
 * The native XMLHttpRequest.prototype captured at patch time. We MUST compare
 * against this snapshot – not the live `XMLHttpRequest.prototype` – because
 * downstream code (uBOL Lite, Pretender, the LinkedIn subclassing test, …)
 * may replace `globalThis.XMLHttpRequest` with a subclass, which would make
 * the live `XMLHttpRequest.prototype` point at the subclass's prototype and
 * defeat the subclass-override check below.
 */
let nativeXHRProto: any = null

/**
 * Walks the prototype chain between the instance and the native
 * XMLHttpRequest.prototype. If any prototype has an own `response` property,
 * a downstream subclass is overriding the getter and we must NOT shadow it
 * with an instance property (otherwise the subclass override – e.g. uBOL
 * Lite's json-prune – breaks).
 */
function hasSubclassResponseOverride(xhr: XMLHttpRequest): boolean {
  if (!nativeXHRProto) return false
  let proto: any = Object.getPrototypeOf(xhr)
  while (proto && proto !== nativeXHRProto) {
    if (Object.prototype.hasOwnProperty.call(proto, 'response')) {
      return true
    }
    proto = Object.getPrototypeOf(proto)
  }
  return false
}

/**
 * Apply the (possibly middleware-modified) Response onto the user's XHR
 * instance via Object.defineProperty. This is what makes `xhr.responseText`,
 * `xhr.response`, `xhr.status`, etc. reflect middleware mutations.
 */
async function applyResponseToXHR(
  xhr: XMLHttpRequest,
  res: Response,
  responseType: XMLHttpRequestResponseType,
  isStreaming: boolean,
): Promise<{ responseValue: any; responseTextValue: string }> {
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => { headers[key] = value })

  let responseValue: any = null
  let responseTextValue = ''

  if (!isStreaming && !BODYLESS_STATUS_CODES.includes(res.status)) {
    // Read raw bytes once, then convert to whatever the user asked for.
    const ab = await res.clone().arrayBuffer()
    responseTextValue = new TextDecoder().decode(ab)

    switch (responseType) {
      case 'json':
        try { responseValue = JSON.parse(responseTextValue) } catch { responseValue = null }
        break
      case 'blob':
        responseValue = new Blob([ab])
        break
      case 'arraybuffer':
        responseValue = ab
        break
      case 'document':
        responseValue = responseTextValue
        break
      default: // '' or 'text'
        responseValue = responseTextValue
    }
  }

  // Status / state fields – always override.
  defineInstanceProp(xhr, 'status', res.status)
  defineInstanceProp(xhr, 'statusText', res.statusText)
  defineInstanceProp(xhr, 'responseURL', res.url || '')
  defineInstanceProp(xhr, 'readyState', XMLHttpRequest.DONE)

  // responseText: set for text-like responseTypes. The spec says accessing
  // responseText throws for 'json'/'blob'/'arraybuffer', but real-world
  // scripts (and our tests) read it – so we expose the decoded text always.
  defineInstanceProp(xhr, 'responseText', responseTextValue)

  // response: skip if a subclass has its own getter.
  if (!hasSubclassResponseOverride(xhr)) {
    defineInstanceProp(xhr, 'response', responseValue)
  }

  defineInstanceProp(xhr, 'getAllResponseHeaders', () =>
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n'),
  )
  defineInstanceProp(xhr, 'getResponseHeader', (name: string) =>
    headers[name.toLowerCase()] ?? null,
  )

  return { responseValue, responseTextValue }
}

// ----------------------------------------------------------------------------
// Interceptor
// ----------------------------------------------------------------------------

export const interceptXHR: Interceptor<FetchMiddleware> = function (
    middlewares: FetchMiddleware[],
) {
  const g = getGlobalThis()
  if (typeof g.XMLHttpRequest === 'undefined') return () => {}

  const proto = g.XMLHttpRequest.prototype as XMLHttpRequest & {
    __xhrPatched?: boolean
  }

  if (proto.__xhrPatched) return () => {}
  proto.__xhrPatched = true

  const originalOpen             = proto.open
  const originalSetRequestHeader = proto.setRequestHeader
  const originalSend             = proto.send
  const originalAbort            = proto.abort
  // Capture the constructor BEFORE any downstream code (uBOL Lite, Pretender,
  // LinkedIn subclassing, etc.) replaces globalThis.XMLHttpRequest. The shadow
  // XHRs we spawn must be pristine native XHRs.
  const NativeXHR                = g.XMLHttpRequest
  nativeXHRProto                 = NativeXHR.prototype

  // ------ open ---------------------------------------------------------------
  proto.open = makeLookNative(function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async = true,
      username?: string | null,
      password?: string | null,
  ) {
    const s = getState(this)
    s.method   = method
    s.url      = url
    s.async    = async
    s.username = username
    s.password = password
    s.headers  = {}
    s.done     = false
    s.aborted  = false
    s.shadow   = undefined

    defineInstanceProp(this, 'readyState', XMLHttpRequest.OPENED)
    this.dispatchEvent(new ProgressEvent('readystatechange'))
  }, originalOpen)

  // ------ setRequestHeader ---------------------------------------------------
  proto.setRequestHeader = makeLookNative(function (this: XMLHttpRequest, name: string, value: string) {
    const lower = name.toLowerCase()
    const s     = getState(this)
    s.headers[lower] = s.headers[lower] ? `${s.headers[lower]}, ${value}` : value
  }, originalSetRequestHeader)

  // ------ abort --------------------------------------------------------------
  proto.abort = makeLookNative(function (this: XMLHttpRequest) {
    const s = getState(this)
    s.aborted = true
    if (s.shadow) {
      try { s.shadow.abort() } catch (_) {}
    }
    if (!s.done) {
      s.done = true
      defineInstanceProp(this, 'readyState', XMLHttpRequest.DONE)
      this.dispatchEvent(new ProgressEvent('abort'))
      this.dispatchEvent(new ProgressEvent('loadend'))
    }
  }, originalAbort)

  // ------ send ---------------------------------------------------------------
  proto.send = makeLookNative(function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const self = this
    const s    = getState(this)
    s.body      = body
    s.responseType = this.responseType
    s.withCredentials = this.withCredentials
    s.timeout   = this.timeout

    const originReq = new Request(s.url, {
      method:  s.method,
      headers: s.headers,
      body:    s.method.toUpperCase() === 'GET' ? null : (body as any),
    })
    s.originReq = originReq

    const c: FetchContext = {
      type: 'xhr',
      req:  originReq,
      res:  new Response(),
    }

    ;(async () => {
      try {
        await handleRequest(c, [
          ...middlewares,
          async (context) => {
            context.res = await dispatchNativeXHR(
                self,
                context.req,
                s,
                NativeXHR,
                originalOpen,
                originalSetRequestHeader,
                originalSend,
            )
          },
        ])
      } catch (err) {
        await handleSendError(self, err, s)
        return
      }

      if (s.aborted) return
      await dispatchResponseEvents(self, c, s)
    })()
  }, originalSend)

  // ------ teardown -----------------------------------------------------------
  return () => {
    proto.open             = originalOpen
    proto.setRequestHeader = originalSetRequestHeader
    proto.send             = originalSend
    proto.abort            = originalAbort
    delete (proto as any).__xhrPatched
  }
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

/**
 * Performs the actual native request on a SHADOW XHR (not the user's XHR).
 * The user's XHR never fires native events – that's the key invariant that
 * lets us delay event dispatch until after the middleware onion completes.
 */
async function dispatchNativeXHR(
    xhr: XMLHttpRequest,
    req: Request,
    s: XHRState,
    NativeXHR: typeof XMLHttpRequest,
    originalOpen: typeof XMLHttpRequest.prototype.open,
    originalSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader,
    originalSend: typeof XMLHttpRequest.prototype.send,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    // Spawn a pristine native XHR. We bypass the patched prototype methods
    // by calling the captured originals directly with `this = shadow`.
    const shadow = new NativeXHR() as XMLHttpRequest
    s.shadow = shadow

    // open()
    const args: any[] = [req.method, req.url, s.async]
    if (s.username !== undefined && s.username !== null) {
      args.push(s.username)
      if (s.password !== undefined && s.password !== null) {
        args.push(s.password)
      }
    }
    originalOpen.apply(shadow, args as any)

    // setRequestHeader() – skip multipart boundary (browser sets it) and
    // content-length (browser computes it).
    for (const [name, value] of req.headers.entries()) {
      if (name === 'content-type' && value.startsWith('multipart/form-data; boundary=')) continue
      if (name === 'content-length') continue
      try { originalSetRequestHeader.call(shadow, name, value) } catch (_) {}
    }

    // Forward user-controlled options.
    try { shadow.withCredentials = s.withCredentials } catch (_) {}
    try { shadow.timeout = s.timeout } catch (_) {}
    // Always read raw bytes; we parse into the user's responseType afterwards.
    try { shadow.responseType = 'arraybuffer' } catch (_) {}

    shadow.addEventListener('load', () => {
      const status     = shadow.status
      const statusText = shadow.statusText
      const headers    = parseHeadersText(shadow.getAllResponseHeaders())
      let body: any = null
      if (!BODYLESS_STATUS_CODES.includes(status)) {
        body = shadow.response // ArrayBuffer
      }
      const response = new Response(body, { status, statusText, headers })
      resolve(response)
    }, { once: true })

    shadow.addEventListener('error', () => {
      reject(new Error('Network error'))
    }, { once: true })

    shadow.addEventListener('timeout', () => {
      reject(new Error('Request timed out'))
    }, { once: true })

    shadow.addEventListener('abort', () => {
      reject(new Error('Request aborted'))
    }, { once: true })

    // send() – if middleware replaced c.req, send the modified body as a Blob.
    // Otherwise send the original body untouched (so spies see the same value
    // the user passed, not a Blob re-encoding).
    const sendBody = async () => {
      if (req === s.originReq) {
        originalSend.call(shadow, s.body ?? null)
      } else {
        const blob = await req.blob()
        originalSend.call(shadow, blob)
      }
    }
    sendBody().catch(reject)
  })
}

/**
 * Handles errors thrown from anywhere in the middleware onion. Builds a
 * synthetic Response from the error and applies it to the user's XHR, then
 * dispatches `error` + `loadend` (matching native XHR semantics).
 */
async function handleSendError(xhr: XMLHttpRequest, err: unknown, s: XHRState) {
  if (s.aborted || s.done) return
  s.done = true

  let res: Response
  if (err instanceof HTTPException) {
    res = err.getResponse()
  } else if (typeof err === 'string') {
    res = new Response(err, { status: 500, statusText: err })
  } else if (err instanceof Error) {
    res = new Response(err.message, { status: 500 })
  } else {
    res = new Response(JSON.stringify(err), { status: 500, statusText: 'Internal Server Error' })
  }

  await applyResponseToXHR(xhr, res, s.responseType, false)

  xhr.dispatchEvent(new ProgressEvent('readystatechange'))
  xhr.dispatchEvent(new ProgressEvent('error'))
  xhr.dispatchEvent(new ProgressEvent('loadend'))
}

/**
 * Applies the (possibly modified) Response to the user's XHR and dispatches
 * the success event sequence. For SSE responses, streams chunks incrementally
 * via `progress` events so the user's `onprogress` can read `responseText`
 * piece by piece – exactly like a native XHR.
 */
async function dispatchResponseEvents(xhr: XMLHttpRequest, c: FetchContext, s: XHRState) {
  if (s.aborted || s.done) return
  s.done = true

  const isSSE = c.res.body !== null
    && c.res.headers.get('Content-Type') === 'text/event-stream'

  if (isSSE) {
    // ---- Streaming: keep readyState at LOADING while we pump chunks ----
    defineInstanceProp(xhr, 'readyState', XMLHttpRequest.LOADING)
    // Provide a non-null responseText/response so user code that reads it
    // inside onprogress sees the accumulated value.
    defineInstanceProp(xhr, 'responseText', '')
    if (!hasSubclassResponseOverride(xhr)) {
      defineInstanceProp(xhr, 'response', '')
    }
    xhr.dispatchEvent(new ProgressEvent('readystatechange'))

    const reader  = c.res.clone().body!.getReader()
    const decoder = new TextDecoder()
    let received  = 0
    let responseText = ''
    const total   = parseInt(c.res.headers.get('Content-Length') ?? '0', 10)

    let chunk = await reader.read()
    while (!chunk.done) {
      received  += chunk.value.length
      responseText += decoder.decode(chunk.value, { stream: true })

      defineInstanceProp(xhr, 'responseText', responseText)
      if (!hasSubclassResponseOverride(xhr)) {
        defineInstanceProp(xhr, 'response', responseText)
      }

      const progress = new ProgressEvent('progress', {
        loaded: received,
        total,
        lengthComputable: total > 0,
      })
      xhr.dispatchEvent(progress)
      chunk = await reader.read()
    }

    // Final flush of the decoder
    responseText += decoder.decode()
    defineInstanceProp(xhr, 'responseText', responseText)
    if (!hasSubclassResponseOverride(xhr)) {
      defineInstanceProp(xhr, 'response', responseText)
    }

    // Apply final status/headers but keep the streaming responseText/response.
    const headers: Record<string, string> = {}
    c.res.headers.forEach((value, key) => { headers[key] = value })
    defineInstanceProp(xhr, 'status', c.res.status)
    defineInstanceProp(xhr, 'statusText', c.res.statusText)
    defineInstanceProp(xhr, 'responseURL', c.res.url || '')
    defineInstanceProp(xhr, 'readyState', XMLHttpRequest.DONE)
    defineInstanceProp(xhr, 'getAllResponseHeaders', () =>
      Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n'),
    )
    defineInstanceProp(xhr, 'getResponseHeader', (name: string) =>
      headers[name.toLowerCase()] ?? null,
    )
  } else {
    // ---- Normal response: parse body according to responseType ----
    await applyResponseToXHR(xhr, c.res, s.responseType, false)
  }

  // Common success tail. Order per XHR spec:
  //   progress → readystatechange(DONE) → load → loadend
  // (progress already dispatched for SSE above)
  if (!isSSE) {
    xhr.dispatchEvent(new ProgressEvent('progress'))
  }
  xhr.dispatchEvent(new ProgressEvent('readystatechange'))
  xhr.dispatchEvent(new ProgressEvent('load'))
  xhr.dispatchEvent(new ProgressEvent('loadend'))
}
