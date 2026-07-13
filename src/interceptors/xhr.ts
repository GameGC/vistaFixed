import { handleRequest } from '../context'
import { HTTPException } from '../http-exception'
import type { Interceptor } from '../types'
import { getGlobalThis, type FetchContext, type FetchMiddleware } from './fetch'

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const BODYLESS_STATUS_CODES = [101, 204, 205, 304]

/**
 * Per-instance state stored directly on each XHR object.
 * Using a WeakMap keeps this fully private and GC-friendly.
 */
interface XHRState {
  method: string
  url: string | URL
  async: boolean
  username?: string | null
  password?: string | null
  headers: Record<string, string>
  body?: Document | XMLHttpRequestBodyInit | null
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
// Response helpers (unchanged from original)
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

/**
 * Intercepts XHR by patching `open`, `setRequestHeader`, and `send` on the
 * prototype — the same minimal-surface approach used by `interceptFetch`.
 *
 * Each call to `send` builds a `FetchContext`, runs it through the middleware
 * pipeline, then forwards the (possibly mutated) request to the native XHR.
 * A teardown function is returned that restores all three originals.
 */
export const interceptXHR: Interceptor<FetchMiddleware> = function (
    middlewares: FetchMiddleware[],
) {
  const g = getGlobalThis()
  if (typeof g.XMLHttpRequest === 'undefined') return () => {}

  const proto = g.XMLHttpRequest.prototype as XMLHttpRequest & {
    __xhrPatched?: boolean
  }

  // Guard against double-patching (e.g. hot-reload / multiple SDK instances)
  if (proto.__xhrPatched) return () => {}
  proto.__xhrPatched = true

  const originalOpen             = proto.open
  const originalSetRequestHeader = proto.setRequestHeader
  const originalSend             = proto.send

  // ------ open ---------------------------------------------------------------

  proto.open = function (
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
    s.headers  = {} // reset headers on each open()
    // Defer the real open() to send() so middleware can mutate method/url first
  }

  // ------ setRequestHeader ---------------------------------------------------

  proto.setRequestHeader = function (name: string, value: string) {
    const lower = name.toLowerCase()
    const s     = getState(this)
    // Fold duplicate headers (matching native XHR behaviour)
    s.headers[lower] = s.headers[lower] ? `${s.headers[lower]}, ${value}` : value
  }

  // ------ send ---------------------------------------------------------------

  proto.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
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

        // Run the middleware pipeline then dispatch the native XHR
    ;(async () => {
      try {
        await handleRequest(c, [
          ...middlewares,
          // Terminal middleware: fires the real XHR and resolves with the response
          async (context) => {
            context.res = await dispatchNativeXHR(self, context.req, s, originalOpen, originalSetRequestHeader, originalSend)
          },
        ])
      } catch (err) {
        await handleSendError(self, err)
        return
      }

      // Dispatch remaining XHR events expected by callers
      await dispatchResponseEvents(self, c)
    })()
  }

  // ------ teardown -----------------------------------------------------------

  return () => {
    proto.open             = originalOpen
    proto.setRequestHeader = originalSetRequestHeader
    proto.send             = originalSend
    delete (proto as any).__xhrPatched
  }
}

// ----------------------------------------------------------------------------
// Internal helpers used by the patched `send`
// ----------------------------------------------------------------------------

/**
 * Opens and sends a real XHR using the (possibly middleware-mutated) Request,
 * then wraps the native response in a standard `Response` object.
 */
async function dispatchNativeXHR(
    xhr: XMLHttpRequest,
    req: Request,
    s: XHRState,
    originalOpen: typeof XMLHttpRequest.prototype.open,
    originalSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader,
    originalSend: typeof XMLHttpRequest.prototype.send,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    originalOpen.call(xhr, req.method, req.url, s.async, s.username ?? null, s.password ?? null)

    // Apply headers from the (possibly mutated) request
    for (const [name, value] of req.headers.entries()) {
      // Skip the browser-managed multipart boundary
      if (name === 'content-type' && value.startsWith('multipart/form-data; boundary=')) continue
      originalSetRequestHeader.call(xhr, name, value)
    }

    xhr.addEventListener('load', () => {
      resolve(buildResponseFromXHR(xhr))
    }, { once: true })

    xhr.addEventListener('error', () => {
      reject(new Error(`${xhr.status} ${xhr.statusText}`))
    }, { once: true })

    // Resolve body: if middleware replaced req, stream it out as a blob
    ;(req !== s.body
            ? req.blob().then((b) => originalSend.call(xhr, b))
            : Promise.resolve(originalSend.call(xhr, s.body ?? null))
    ).catch(reject)
  })
}

/**
 * Translates middleware / network errors into XHR error events.
 */
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

  // Expose the synthetic response on the instance so callers reading
  // xhr.status / xhr.response still get the right values
  ;(xhr as any)._syntheticXHR = syntheticXHR

  xhr.dispatchEvent(new ProgressEvent('error'))
}

/**
 * Fires the `load`, `loadend`, and `readystatechange` events expected by XHR
 * consumers, and handles SSE streaming progress if applicable.
 */
async function dispatchResponseEvents(xhr: XMLHttpRequest, c: FetchContext) {
  // SSE / streaming progress
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