import { handleRequest } from '../context'
import { HTTPException } from '../http-exception'
import { Interceptor } from '../types'

export interface FetchContext {
  type: 'fetch' | 'xhr' | 'request'

  req: Request
  res: Response

  [key: string]: any
}

export interface FetchMiddleware {
  (c: FetchContext, next: () => Promise<void>): void | Promise<void>
}

export function stripRequestSignal(req: Request): Request {
  const {
    method,
    headers,
    body,
    mode,
    credentials,
    cache,
    redirect,
    integrity,
    referrer,
    referrerPolicy,
  } = req

  const init: RequestInit = {
    method,
    headers,
    body,
    mode, // IMPORTANT: Preserve these
    credentials, // IMPORTANT: Preserve these
    cache,
    redirect,
    integrity,
    referrer,
    referrerPolicy,
    signal: undefined,
  }

  if (body instanceof ReadableStream) {
    ;(init as any).duplex = 'half'
  }

  return new Request(req.url, init)
}

export function getGlobalThis(): typeof globalThis {
  // @ts-expect-error
  if (typeof unsafeWindow !== 'undefined') {
    // @ts-expect-error
    return unsafeWindow
  }

  return globalThis
}


export const interceptFetch: Interceptor<FetchMiddleware> = function (
    middlewares: FetchMiddleware[],
) {
  const globalContext = getGlobalThis()
  const pureFetch = globalContext.fetch.bind(globalContext)

  globalContext.fetch = async (input, init) => {

    // FIX 1: Safely clone the Request if it already exists to prevent stream locking
    let req: Request
    if (input instanceof Request) {
      req = !input.bodyUsed ? input.clone() : new Request(input, init)
    } else {
      req = new Request(input, init)
    }

    if (req.signal && !req.signal.aborted) {
      req = stripRequestSignal(req)
    }

    const c: FetchContext = {
      req,
      res: new Response(),
      type: 'fetch',
    }

    try {
      await handleRequest(c, [
        ...middlewares,
        async (context) => {
          context.res = await pureFetch(context.req)
        },
      ])
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err
      }
      if (err instanceof HTTPException) {
        return err.getResponse()
      }
      throw err
    }
    return c.res
  }

  /*
  globalContext.fetch = async (input, init) => {
    // PASS-THROUGH: Do nothing to the request.
    // Just forward it to pureFetch.
    const res = await pureFetch(input, init);

    // Create the context simply to trigger your Vista middleware
    const c: FetchContext = {
      req: input instanceof Request ? input : new Request(input, init),
      res: res,
      type: 'fetch',
    };

    // Run your observers/middleware
    await handleRequest(c, middlewares);

    return res;
  };

   */

  return () => {
    globalContext.fetch = makeLookNative(pureFetch,globalContext.fetch)
  }
}

const originalDefineProperty = Object.defineProperty;
const originalFunctionToString = Function.prototype.toString;
function makeLookNative(replacementFn, nativeFn) {
  const nativeSource = originalFunctionToString.call(nativeFn);
  originalDefineProperty(replacementFn, 'toString', {
    value() { return nativeSource; },
    writable: true,
    configurable: true,
    enumerable: false,
  });
  try {
    originalDefineProperty(replacementFn, 'name', { value: nativeFn.name, configurable: true });
  } catch (_) {}
  try {
    originalDefineProperty(replacementFn, 'length', { value: nativeFn.length, configurable: true });
  } catch (_) {}
  return replacementFn;
}