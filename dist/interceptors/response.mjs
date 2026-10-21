import { handleRequest } from "../context.mjs";
import { getGlobalThis } from "./fetch.mjs";
import { deliveredByRequestChannel, makeLookNative } from "./shared.mjs";
export const interceptResponse = function(middlewares) {
  const globalContext = getGlobalThis();
  if (typeof globalContext.Response === "undefined") return () => {
  };
  if (!middlewares || middlewares.length === 0) return () => {
  };
  const proto = globalContext.Response.prototype;
  const dispatch = (res, via) => {
    try {
      const url = res.url || "";
      if (!url) return;
      if (deliveredByRequestChannel.has(res)) return;
      const c = {
        type: "response",
        req: { url, method: "" },
        res,
        via
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
      dispatch(this, name);
      return;
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
