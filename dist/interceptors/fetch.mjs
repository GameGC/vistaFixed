import { handleRequest } from "../context.mjs";
import { HTTPException } from "../http-exception.mjs";
export function getGlobalThis() {
  if (typeof unsafeWindow !== "undefined") {
    return unsafeWindow;
  }
  return globalThis;
}
export const interceptFetch = function(middlewares) {
  const pureFetch = getGlobalThis().fetch;
  getGlobalThis().fetch = async (input, init) => {
    const c = {
      req: new Request(input, init),
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
      if (err instanceof HTTPException) {
        return err.getResponse();
      }
      throw err;
    }
    return c.res;
  };
  return () => {
    getGlobalThis().fetch = pureFetch;
  };
};
