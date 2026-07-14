import { handleRequest } from "../context.mjs";
import { HTTPException } from "../http-exception.mjs";
import { getGlobalThis } from "./fetch.mjs";
const BODYLESS_STATUS_CODES = [101, 204, 205, 304];
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
const xhrState = /* @__PURE__ */ new WeakMap();
function getState(xhr) {
  let s = xhrState.get(xhr);
  if (!s) {
    s = {
      method: "GET",
      url: "",
      async: true,
      headers: {},
      responseType: "",
      withCredentials: false,
      timeout: 0
    };
    xhrState.set(xhr, s);
  }
  return s;
}
function defineInstanceProp(xhr, prop, value) {
  originalDefineProperty(xhr, prop, {
    value,
    configurable: true,
    writable: true,
    enumerable: true
  });
}
function parseHeadersText(text) {
  return text.split("\r\n").filter(Boolean).reduce((acc, line) => {
    const idx = line.indexOf(": ");
    if (idx > -1) acc[line.slice(0, idx)] = line.slice(idx + 2);
    return acc;
  }, {});
}
let nativeXHRProto = null;
function hasSubclassResponseOverride(xhr) {
  if (!nativeXHRProto) return false;
  let proto = Object.getPrototypeOf(xhr);
  while (proto && proto !== nativeXHRProto) {
    if (Object.prototype.hasOwnProperty.call(proto, "response")) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
async function applyResponseToXHR(xhr, res, responseType, isStreaming) {
  const headers = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let responseValue = null;
  let responseTextValue = "";
  if (!isStreaming && !BODYLESS_STATUS_CODES.includes(res.status)) {
    const ab = await res.clone().arrayBuffer();
    responseTextValue = new TextDecoder().decode(ab);
    switch (responseType) {
      case "json":
        try {
          responseValue = JSON.parse(responseTextValue);
        } catch {
          responseValue = null;
        }
        break;
      case "blob":
        responseValue = new Blob([ab]);
        break;
      case "arraybuffer":
        responseValue = ab;
        break;
      case "document":
        responseValue = responseTextValue;
        break;
      default:
        responseValue = responseTextValue;
    }
  }
  defineInstanceProp(xhr, "status", res.status);
  defineInstanceProp(xhr, "statusText", res.statusText);
  defineInstanceProp(xhr, "responseURL", res.url || "");
  defineInstanceProp(xhr, "readyState", XMLHttpRequest.DONE);
  defineInstanceProp(xhr, "responseText", responseTextValue);
  if (!hasSubclassResponseOverride(xhr)) {
    defineInstanceProp(xhr, "response", responseValue);
  }
  defineInstanceProp(
    xhr,
    "getAllResponseHeaders",
    () => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")
  );
  defineInstanceProp(
    xhr,
    "getResponseHeader",
    (name) => headers[name.toLowerCase()] ?? null
  );
  return { responseValue, responseTextValue };
}
export const interceptXHR = function(middlewares) {
  const g = getGlobalThis();
  if (typeof g.XMLHttpRequest === "undefined") return () => {
  };
  const proto = g.XMLHttpRequest.prototype;
  if (proto.__xhrPatched) return () => {
  };
  proto.__xhrPatched = true;
  const originalOpen = proto.open;
  const originalSetRequestHeader = proto.setRequestHeader;
  const originalSend = proto.send;
  const originalAbort = proto.abort;
  const NativeXHR = g.XMLHttpRequest;
  nativeXHRProto = NativeXHR.prototype;
  proto.open = makeLookNative(function(method, url, async = true, username, password) {
    const s = getState(this);
    s.method = method;
    s.url = url;
    s.async = async;
    s.username = username;
    s.password = password;
    s.headers = {};
    s.done = false;
    s.aborted = false;
    s.shadow = void 0;
    defineInstanceProp(this, "readyState", XMLHttpRequest.OPENED);
    this.dispatchEvent(new ProgressEvent("readystatechange"));
  }, originalOpen);
  proto.setRequestHeader = makeLookNative(function(name, value) {
    const lower = name.toLowerCase();
    const s = getState(this);
    s.headers[lower] = s.headers[lower] ? `${s.headers[lower]}, ${value}` : value;
  }, originalSetRequestHeader);
  proto.abort = makeLookNative(function() {
    const s = getState(this);
    s.aborted = true;
    if (s.shadow) {
      try {
        s.shadow.abort();
      } catch (_) {
      }
    }
    if (!s.done) {
      s.done = true;
      defineInstanceProp(this, "readyState", XMLHttpRequest.DONE);
      this.dispatchEvent(new ProgressEvent("abort"));
      this.dispatchEvent(new ProgressEvent("loadend"));
    }
  }, originalAbort);
  proto.send = makeLookNative(function(body) {
    const self = this;
    const s = getState(this);
    s.body = body;
    s.responseType = this.responseType;
    s.withCredentials = this.withCredentials;
    s.timeout = this.timeout;
    const originReq = new Request(s.url, {
      method: s.method,
      headers: s.headers,
      body: s.method.toUpperCase() === "GET" ? null : body
    });
    s.originReq = originReq;
    const c = {
      type: "xhr",
      req: originReq,
      res: new Response()
    };
    (async () => {
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
              originalSend
            );
          }
        ]);
      } catch (err) {
        await handleSendError(self, err, s);
        return;
      }
      if (s.aborted) return;
      await dispatchResponseEvents(self, c, s);
    })();
  }, originalSend);
  return () => {
    proto.open = originalOpen;
    proto.setRequestHeader = originalSetRequestHeader;
    proto.send = originalSend;
    proto.abort = originalAbort;
    delete proto.__xhrPatched;
  };
};
async function dispatchNativeXHR(xhr, req, s, NativeXHR, originalOpen, originalSetRequestHeader, originalSend) {
  return new Promise((resolve, reject) => {
    const shadow = new NativeXHR();
    s.shadow = shadow;
    const args = [req.method, req.url, s.async];
    if (s.username !== void 0 && s.username !== null) {
      args.push(s.username);
      if (s.password !== void 0 && s.password !== null) {
        args.push(s.password);
      }
    }
    originalOpen.apply(shadow, args);
    for (const [name, value] of req.headers.entries()) {
      if (name === "content-type" && value.startsWith("multipart/form-data; boundary=")) continue;
      if (name === "content-length") continue;
      try {
        originalSetRequestHeader.call(shadow, name, value);
      } catch (_) {
      }
    }
    try {
      shadow.withCredentials = s.withCredentials;
    } catch (_) {
    }
    try {
      shadow.timeout = s.timeout;
    } catch (_) {
    }
    try {
      shadow.responseType = "arraybuffer";
    } catch (_) {
    }
    shadow.addEventListener("load", () => {
      const status = shadow.status;
      const statusText = shadow.statusText;
      const headers = parseHeadersText(shadow.getAllResponseHeaders());
      let body = null;
      if (!BODYLESS_STATUS_CODES.includes(status)) {
        body = shadow.response;
      }
      const response = new Response(body, { status, statusText, headers });
      resolve(response);
    }, { once: true });
    shadow.addEventListener("error", () => {
      reject(new Error("Network error"));
    }, { once: true });
    shadow.addEventListener("timeout", () => {
      reject(new Error("Request timed out"));
    }, { once: true });
    shadow.addEventListener("abort", () => {
      reject(new Error("Request aborted"));
    }, { once: true });
    const sendBody = async () => {
      if (req === s.originReq) {
        originalSend.call(shadow, s.body ?? null);
      } else {
        const blob = await req.blob();
        originalSend.call(shadow, blob);
      }
    };
    sendBody().catch(reject);
  });
}
async function handleSendError(xhr, err, s) {
  if (s.aborted || s.done) return;
  s.done = true;
  let res;
  if (err instanceof HTTPException) {
    res = err.getResponse();
  } else if (typeof err === "string") {
    res = new Response(err, { status: 500, statusText: err });
  } else if (err instanceof Error) {
    res = new Response(err.message, { status: 500 });
  } else {
    res = new Response(JSON.stringify(err), { status: 500, statusText: "Internal Server Error" });
  }
  await applyResponseToXHR(xhr, res, s.responseType, false);
  xhr.dispatchEvent(new ProgressEvent("readystatechange"));
  xhr.dispatchEvent(new ProgressEvent("error"));
  xhr.dispatchEvent(new ProgressEvent("loadend"));
}
async function dispatchResponseEvents(xhr, c, s) {
  if (s.aborted || s.done) return;
  s.done = true;
  const isSSE = c.res.body !== null && c.res.headers.get("Content-Type") === "text/event-stream";
  if (isSSE) {
    defineInstanceProp(xhr, "readyState", XMLHttpRequest.LOADING);
    defineInstanceProp(xhr, "responseText", "");
    if (!hasSubclassResponseOverride(xhr)) {
      defineInstanceProp(xhr, "response", "");
    }
    xhr.dispatchEvent(new ProgressEvent("readystatechange"));
    const reader = c.res.clone().body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let responseText = "";
    const total = parseInt(c.res.headers.get("Content-Length") ?? "0", 10);
    let chunk = await reader.read();
    while (!chunk.done) {
      received += chunk.value.length;
      responseText += decoder.decode(chunk.value, { stream: true });
      defineInstanceProp(xhr, "responseText", responseText);
      if (!hasSubclassResponseOverride(xhr)) {
        defineInstanceProp(xhr, "response", responseText);
      }
      const progress = new ProgressEvent("progress", {
        loaded: received,
        total,
        lengthComputable: total > 0
      });
      xhr.dispatchEvent(progress);
      chunk = await reader.read();
    }
    responseText += decoder.decode();
    defineInstanceProp(xhr, "responseText", responseText);
    if (!hasSubclassResponseOverride(xhr)) {
      defineInstanceProp(xhr, "response", responseText);
    }
    const headers = {};
    c.res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    defineInstanceProp(xhr, "status", c.res.status);
    defineInstanceProp(xhr, "statusText", c.res.statusText);
    defineInstanceProp(xhr, "responseURL", c.res.url || "");
    defineInstanceProp(xhr, "readyState", XMLHttpRequest.DONE);
    defineInstanceProp(
      xhr,
      "getAllResponseHeaders",
      () => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")
    );
    defineInstanceProp(
      xhr,
      "getResponseHeader",
      (name) => headers[name.toLowerCase()] ?? null
    );
  } else {
    await applyResponseToXHR(xhr, c.res, s.responseType, false);
  }
  if (!isSSE) {
    xhr.dispatchEvent(new ProgressEvent("progress"));
  }
  xhr.dispatchEvent(new ProgressEvent("readystatechange"));
  xhr.dispatchEvent(new ProgressEvent("load"));
  xhr.dispatchEvent(new ProgressEvent("loadend"));
}
