import { handleRequest } from "../context.mjs";
import { HTTPException } from "../http-exception.mjs";
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
    if (input instanceof Request) {
      if (input.referrer != document.URL) {
        console.log("skipped" + input.url);
        await pureFetch(input);
      }
    }
    let req;
    if (input instanceof Request) {
      req = !input.bodyUsed ? input.clone() : input;
    } else {
      req = new Request(input, init);
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
    globalContext.fetch = pureFetch;
  };
};
