import { handleRequest } from "../context.mjs";
import { HTTPException } from "../http-exception.mjs";
import { getGlobalThis } from "./fetch.mjs";
const BODYLESS_STATUS_CODES = [101, 204, 205, 304];
const xhrState = /* @__PURE__ */ new WeakMap();
function getState(xhr) {
  let s = xhrState.get(xhr);
  if (!s) {
    s = { method: "GET", url: "", async: true, headers: {} };
    xhrState.set(xhr, s);
  }
  return s;
}
async function responseToXHR(response, responseType) {
  const xhr = new (getGlobalThis()).XMLHttpRequest();
  let responseValue;
  const cloned = response.clone();
  const isStreaming = ["text/event-stream", "application/octet-stream"].includes(
    response.headers.get("Content-Type") ?? ""
  );
  if (isStreaming) {
    responseValue = cloned.body;
  } else {
    switch (responseType) {
      case "json":
        responseValue = await cloned.json();
        break;
      case "blob":
        responseValue = await cloned.blob();
        break;
      case "arraybuffer":
        responseValue = await cloned.arrayBuffer();
        break;
      default:
        responseValue = await cloned.text();
    }
  }
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  Object.defineProperties(xhr, {
    status: { value: response.status },
    statusText: { value: response.statusText },
    responseURL: { value: response.url },
    readyState: { value: isStreaming ? XMLHttpRequest.LOADING : XMLHttpRequest.DONE },
    response: { value: responseValue },
    responseType: { value: responseType },
    responseText: {
      value: responseType === "text" || responseType === "" ? responseValue : null
    },
    getAllResponseHeaders: {
      value: () => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")
    },
    getResponseHeader: {
      value: (name) => headers[name.toLowerCase()] ?? null
    }
  });
  return xhr;
}
function parseHeadersText(text) {
  return text.split("\r\n").filter(Boolean).reduce((acc, line) => {
    const idx = line.indexOf(": ");
    if (idx > -1) acc[line.slice(0, idx)] = line.slice(idx + 2);
    return acc;
  }, {});
}
function buildResponseFromXHR(xhr) {
  const status = xhr.status;
  const statusText = xhr.statusText;
  const headers = parseHeadersText(xhr.getAllResponseHeaders());
  const rt = xhr.responseType;
  let body = null;
  if (!BODYLESS_STATUS_CODES.includes(status)) {
    if (rt === "" || rt === "text") {
      body = xhr.responseText;
    } else if (rt === "json") {
      body = JSON.stringify(xhr.response);
    } else {
      body = xhr.response;
    }
  }
  return new Response(body, { status, statusText, headers });
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
  proto.open = function(method, url, async = true, username, password) {
    const s = getState(this);
    s.method = method;
    s.url = url;
    s.async = async;
    s.username = username;
    s.password = password;
    s.headers = {};
  };
  proto.setRequestHeader = function(name, value) {
    const lower = name.toLowerCase();
    const s = getState(this);
    s.headers[lower] = s.headers[lower] ? `${s.headers[lower]}, ${value}` : value;
  };
  proto.send = function(body) {
    const self = this;
    const s = getState(this);
    s.body = body;
    const originReq = new Request(s.url, {
      method: s.method,
      headers: s.headers,
      body: s.method.toUpperCase() === "GET" ? null : body
    });
    const c = {
      type: "xhr",
      req: originReq,
      res: new Response()
    };
    (async () => {
      try {
        await handleRequest(c, [
          ...middlewares,
          // Terminal middleware: fires the real XHR and resolves with the response
          async (context) => {
            context.res = await dispatchNativeXHR(self, context.req, s, originalOpen, originalSetRequestHeader, originalSend);
          }
        ]);
      } catch (err) {
        await handleSendError(self, err);
        return;
      }
      await dispatchResponseEvents(self, c);
    })();
  };
  return () => {
    proto.open = originalOpen;
    proto.setRequestHeader = originalSetRequestHeader;
    proto.send = originalSend;
    delete proto.__xhrPatched;
  };
};
async function dispatchNativeXHR(xhr, req, s, originalOpen, originalSetRequestHeader, originalSend) {
  return new Promise((resolve, reject) => {
    originalOpen.call(xhr, req.method, req.url, s.async, s.username ?? null, s.password ?? null);
    for (const [name, value] of req.headers.entries()) {
      if (name === "content-type" && value.startsWith("multipart/form-data; boundary=")) continue;
      originalSetRequestHeader.call(xhr, name, value);
    }
    xhr.addEventListener("load", () => {
      resolve(buildResponseFromXHR(xhr));
    }, { once: true });
    xhr.addEventListener("error", () => {
      reject(new Error(`${xhr.status} ${xhr.statusText}`));
    }, { once: true });
    (req !== s.body ? req.blob().then((b) => originalSend.call(xhr, b)) : Promise.resolve(originalSend.call(xhr, s.body ?? null))).catch(reject);
  });
}
async function handleSendError(xhr, err) {
  let syntheticXHR;
  if (err instanceof HTTPException) {
    syntheticXHR = await responseToXHR(err.getResponse(), xhr.responseType);
  } else if (typeof err === "string") {
    syntheticXHR = await responseToXHR(new Response(err, { status: 500, statusText: err }), xhr.responseType);
  } else if (err instanceof Error) {
    syntheticXHR = await responseToXHR(new Response(err.message, { status: 500 }), xhr.responseType);
  } else {
    syntheticXHR = await responseToXHR(
      new Response(JSON.stringify(err), { status: 500, statusText: "Internal Server Error" }),
      xhr.responseType
    );
  }
  ;
  xhr._syntheticXHR = syntheticXHR;
  xhr.dispatchEvent(new ProgressEvent("error"));
}
async function dispatchResponseEvents(xhr, c) {
  if (c.res.body && c.res.headers.get("Content-Type") === "text/event-stream") {
    const reader = c.res.clone().body.getReader();
    let received = 0;
    let responseText = "";
    const total = parseInt(c.res.headers.get("Content-Length") ?? "0", 10);
    let chunk = await reader.read();
    while (!chunk.done) {
      received += chunk.value.length;
      responseText += new TextDecoder().decode(chunk.value);
      const progress = new ProgressEvent("progress", {
        loaded: received,
        total,
        lengthComputable: total > 0
      });
      xhr.dispatchEvent(progress);
      chunk = await reader.read();
    }
  } else {
    xhr.dispatchEvent(new ProgressEvent("progress"));
  }
  for (const type of ["load", "loadend", "readystatechange"]) {
    xhr.dispatchEvent(new ProgressEvent(type));
  }
}
