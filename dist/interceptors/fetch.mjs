import { handleRequest } from "../context.mjs";
import { HTTPException } from "../http-exception.mjs";
export function stripRequestSignal(req) {
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
    referrerPolicy
  } = req;
  const init = {
    method,
    headers,
    body,
    mode,
    // IMPORTANT: Preserve these
    credentials,
    // IMPORTANT: Preserve these
    cache,
    redirect,
    integrity,
    referrer,
    referrerPolicy,
    signal: void 0
  };
  if (body instanceof ReadableStream) {
    ;
    init.duplex = "half";
  }
  return new Request(req.url, init);
}
export function getGlobalThis() {
  if (typeof unsafeWindow !== "undefined") {
    return unsafeWindow;
  }
  return globalThis;
}
export const interceptFetch = function(middlewares) {
  const globalContext = getGlobalThis();
  const pureFetch = globalContext.fetch.bind(globalContext);
  globalContext.fetch = async (input, init) => {
    let req;
    if (input instanceof Request) {
      req = !input.bodyUsed ? input.clone() : new Request(input, init);
    } else {
      req = new Request(input, init);
    }
    if (req.signal && !req.signal.aborted) {
      req = stripRequestSignal(req);
    }
    const c = {
      req,
      res: new Response(),
      type: "fetch"
    };
    try {
      await handleRequest(c, [
        ...middlewares,
        async (context) => {
          context.res = await pureFetch(context.req);
        }
      ]);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      if (err instanceof HTTPException) {
        return err.getResponse();
      }
      throw err;
    }
    return c.res;
  };
  return () => {
    globalContext.fetch = makeLookNative(pureFetch, globalContext.fetch);
  };
};
const originalDefineProperty = Object.defineProperty;
const originalFunctionToString = Function.prototype.toString;
function makeLookNative(replacementFn, nativeFn) {
  const nativeSource = originalFunctionToString.call(nativeFn);
  originalDefineProperty(replacementFn, "toString", {
    value() {
      return nativeSource;
    },
    writable: true,
    configurable: true,
    enumerable: false
  });
  try {
    originalDefineProperty(replacementFn, "name", { value: nativeFn.name, configurable: true });
  } catch (_) {
  }
  try {
    originalDefineProperty(replacementFn, "length", { value: nativeFn.length, configurable: true });
  } catch (_) {
  }
  return replacementFn;
}
