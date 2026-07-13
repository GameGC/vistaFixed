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
  nativeOpenCalled?: boolean
}

const xhrState = new WeakMap<XMLHttpRequest, XHRState>()

function getState(xhr: XMLHttpRequest): XHRState {
  let s = xhrState.get(xhr)
  if (!s) {
    s = { method: 'GET', url: '', async: true, headers: {} }
    xhrState.set(xhr, s)
  }
  return s
}

// ----------------------------------------------------------------------------
// Response helpers (unchanged)
// ----------------------------------------------------------------------------

async function responseToXHR(
    response: Response,
    responseType: XMLHttpRequestResponseType,
): Promise<XMLHttpRequest & { __responseText?: string }> {
  const xhr = new (getGlobalThis().XMLHttpRequest)() as XMLHttpRequest & {
    __responseText?: string
  }

  let responseValue: any
  const cloned = response.clone()

  const isStreaming = ['text/event-stream', 'application/octet-stream'].includes(
      response.headers.get('Content-Type') ?? '',
  )

  if (isStreaming) {
    responseValue = cloned.body
  } else {
    switch (responseType) {
      case 'json':        responseValue = await cloned.json();        break
      case 'blob':        responseValue = await cloned.blob();        break
      case 'arraybuffer': responseValue = await cloned.arrayBuffer(); break
      default:            responseValue = await cloned.text()
    }
  }

  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })

  Object.defineProperties(xhr, {
    status:      { value: response.status },
    statusText:  { value: response.statusText },
    responseURL: { value: response.url },
    readyState:  { value: isStreaming ? XMLHttpRequest.LOADING : XMLHttpRequest.DONE },
    response:    { value: responseValue },
    responseType: { value: responseType },
    responseText: {
      value: responseType === 'text' || responseType === '' ? responseValue : null,
    },
    getAllResponseHeaders: {
      value: () =>
          Object.entries(headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\r\n'),
    },
    getResponseHeader: {
      value: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  })

  return xhr
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

function buildResponseFromXHR(xhr: XMLHttpRequest): Response {
  const status     = xhr.status
  const statusText = xhr.statusText
  const headers    = parseHeadersText(xhr.getAllResponseHeaders())
  const rt         = xhr.responseType

  let body: any = null
  if (!BODYLESS_STATUS_CODES.includes(status)) {
    if (rt === '' || rt === 'text') {
      body = xhr.responseText
    } else if (rt === 'json') {
      body = JSON.stringify(xhr.response)
    } else {
      body = xhr.response
    }
  }

  return new Response(body, { status, statusText, headers })
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
    s.nativeOpenCalled = false // Reset native opened flag
  }, originalOpen)

  // ------ setRequestHeader ---------------------------------------------------

  proto.setRequestHeader = makeLookNative(function (this: XMLHttpRequest, name: string, value: string) {
    const lower = name.toLowerCase()
    const s     = getState(this)
    s.headers[lower] = s.headers[lower] ? `${s.headers[lower]}, ${value}` : value

    // CRITICAL FIX: If a 3rd party tracker injects tracing headers during send(),
    // the native XHR is already "opened" internally. We must forward them immediately,
    // or they get swallowed and the 3rd party script crashes.
    if (s.nativeOpenCalled) {
      originalSetRequestHeader.call(this, name, value)
    }
  }, originalSetRequestHeader)

  // ------ send ---------------------------------------------------------------

  proto.send = makeLookNative(function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const self = this
    const s    = getState(this)
    s.body     = body

    const originReq = new Request(s.url, {
      method:  s.method,
      headers: s.headers,
      body:    s.method.toUpperCase() === 'GET' ? null : (body as any),
    })

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
            context.res = await dispatchNativeXHR(self, context.req, s, originalOpen, originalSetRequestHeader, originalSend)
          },
        ])
      } catch (err) {
        await handleSendError(self, err)
        return
      }

      await dispatchResponseEvents(self, c)
    })()
  }, originalSend)

  // ------ teardown -----------------------------------------------------------

  return () => {
    proto.open             = originalOpen
    proto.setRequestHeader = originalSetRequestHeader
    proto.send             = originalSend
    delete (proto as any).__xhrPatched
  }
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

async function dispatchNativeXHR(
    xhr: XMLHttpRequest,
    req: Request,
    s: XHRState,
    originalOpen: typeof XMLHttpRequest.prototype.open,
    originalSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader,
    originalSend: typeof XMLHttpRequest.prototype.send,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    // Mark as opened so any late setRequestHeader calls from 3rd party scripts flush through
    s.nativeOpenCalled = true

    // Dynamically build args to avoid forcing "null" literals on strict backend parsers
    const args: any[] = [req.method, req.url, s.async]
    if (s.username !== undefined && s.username !== null) {
      args.push(s.username)
      if (s.password !== undefined && s.password !== null) {
        args.push(s.password)
      }
    }

    originalOpen.apply(xhr, args as any)

    for (const [name, value] of req.headers.entries()) {
      if (name === 'content-type' && value.startsWith('multipart/form-data; boundary=')) continue
      originalSetRequestHeader.call(xhr, name, value)
    }

    xhr.addEventListener('load', () => {
      resolve(buildResponseFromXHR(xhr))
    }, { once: true })

    xhr.addEventListener('error', () => {
      reject(new Error(`${xhr.status} ${xhr.statusText}`))
    }, { once: true })

    ;(req !== s.body
            ? req.blob().then((b) => originalSend.call(xhr, b))
            : Promise.resolve(originalSend.call(xhr, s.body ?? null))
    ).catch(reject)
  })
}

async function handleSendError(xhr: XMLHttpRequest, err: unknown) {
  let syntheticXHR: XMLHttpRequest

  if (err instanceof HTTPException) {
    syntheticXHR = await responseToXHR(err.getResponse(), xhr.responseType)
  } else if (typeof err === 'string') {
    syntheticXHR = await responseToXHR(new Response(err, { status: 500, statusText: err }), xhr.responseType)
  } else if (err instanceof Error) {
    syntheticXHR = await responseToXHR(new Response(err.message, { status: 500 }), xhr.responseType)
  } else {
    syntheticXHR = await responseToXHR(
        new Response(JSON.stringify(err), { status: 500, statusText: 'Internal Server Error' }),
        xhr.responseType,
    )
  }

  ;(xhr as any)._syntheticXHR = syntheticXHR
  xhr.dispatchEvent(new ProgressEvent('error'))
}

async function dispatchResponseEvents(xhr: XMLHttpRequest, c: FetchContext) {
  if (
      c.res.body &&
      c.res.headers.get('Content-Type') === 'text/event-stream'
  ) {
    const reader       = c.res.clone().body!.getReader()
    let   received     = 0
    let   responseText = ''
    const total        = parseInt(c.res.headers.get('Content-Length') ?? '0', 10)

    let chunk = await reader.read()
    while (!chunk.done) {
      received      += chunk.value.length
      responseText  += new TextDecoder().decode(chunk.value)

      const progress = new ProgressEvent('progress', {
        loaded: received,
        total,
        lengthComputable: total > 0,
      })
      xhr.dispatchEvent(progress)
      chunk = await reader.read()
    }
  } else {
    xhr.dispatchEvent(new ProgressEvent('progress'))
  }

  for (const type of ['load', 'loadend', 'readystatechange'] as const) {
    xhr.dispatchEvent(new ProgressEvent(type))
  }
}