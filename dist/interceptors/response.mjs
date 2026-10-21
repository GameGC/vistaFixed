import { handleRequest } from "../context.mjs";
import { getGlobalThis } from "./fetch.mjs";
import { deliveredByRequestChannel, makeLookNative, responseNatives } from "./shared.mjs";
export async function readBodyUntracked(res, how) {
  const native = responseNatives[how] ?? Response.prototype[how] ?? res[how]?.bind(res);
  if (typeof native !== "function") {
    throw new Error(`[vista] Response.${how} \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D`);
  }
  return native.call(res);
}
export const interceptResponse = function(middlewares) {
  const globalContext = getGlobalThis();
  if (typeof globalContext.Response === "undefined") return () => {
  };
  if (!middlewares || middlewares.length === 0) return () => {
  };
  const proto = globalContext.Response.prototype;
  const dispatch = (res) => {
    try {
      const url = res.url || "";
      if (!url) return;
      if (deliveredByRequestChannel.has(res)) return;
      const c = {
        req: new Request(url),
        res,
        type: "fetch"
      };
      handleRequest(c, middlewares).catch(
        (err) => {
          console.error("[vista] response middleware failed", err);
        }
      );
    } catch (err) {
      console.error("[vista] response dispatch failed", err);
    }
  };
  const installed = [];
  for (const name of ["arrayBuffer", "json", "text"]) {
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    const wrapped = async function() {
      const result = await orig.apply(this, arguments);
      dispatch(this);
      return result;
    };
    makeLookNative(wrapped, orig);
    try {
      proto[name] = wrapped;
    } catch {
      continue;
    }
    installed.push({ name, orig, wrapped });
  }
  return () => {
    for (const { name, orig, wrapped } of installed) {
      if (proto[name] === wrapped) proto[name] = orig;
    }
  };
};
