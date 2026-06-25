import { handleRequest } from "../context.mjs";
import { HTTPException } from "../http-exception.mjs";
import { getGlobalThis } from "./fetch.mjs";
const BODYLESS_STATUS_CODES = [101, 204, 205, 304];
async function responseToXHR(response, responseType) {
  const xhr = new XMLHttpRequest();
  let responseValue;
  const cloneResp = response.clone();
  const isStreaming = [
    "text/event-stream",
    "application/octet-stream"
  ].includes(response.headers.get("Content-Type") ?? "");
  if (isStreaming) {
    responseValue = cloneResp.body;
  } else {
    switch (responseType) {
      case "json":
        responseValue = await cloneResp.json();
        break;
      case "blob":
        responseValue = await cloneResp.blob();
        break;
      case "arraybuffer":
        responseValue = await cloneResp.arrayBuffer();
        break;
      case "document":
      case "text":
      default:
        responseValue = await cloneResp.text();
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
    readyState: {
      value: isStreaming ? XMLHttpRequest.LOADING : XMLHttpRequest.DONE
    },
    response: { value: responseValue },
    responseType: { value: responseType },
    responseText: {
      value: responseType === "text" || responseType === "" ? responseValue : null
    },
    getAllResponseHeaders: {
      value: () => {
        return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n");
      }
    },
    getResponseHeader: {
      value: (name) => headers[name.toLowerCase()] || null
    }
  });
  return xhr;
}
function parseHeadersText(text) {
  return text.split("\r\n").filter((header) => header).reduce(
    (acc, current) => {
      const [key, value] = current.split(": ");
      acc[key] = value;
      return acc;
    },
    {}
  );
}
export const interceptXHR = function(middlewares) {
  if (typeof XMLHttpRequest === "undefined") {
    return () => {
    };
  }
  class CustomXHR extends getGlobalThis().XMLHttpRequest {
    #method = "";
    #url = "";
    #async;
    #username;
    #password;
    #headers = {};
    #body;
    #listeners = [];
    open(method, url, async, username, password) {
      this.#method = method;
      this.#url = url;
      if (async !== void 0) {
        this.#async = async;
      }
      if (username !== void 0) {
        this.#username = username;
      }
      if (password !== void 0) {
        this.#password = password;
      }
    }
    static #middlewares = [];
    static middlewares(middlewares2) {
      CustomXHR.#middlewares = middlewares2;
    }
    setRequestHeader(name, value) {
      this.#headers[name] = value;
    }
    addEventListener(type, listener, options) {
      this.#listeners.push([type, listener, options]);
    }
    removeEventListener(type, listener, options) {
      this.#listeners = this.#listeners.filter(
        ([t, l, o]) => t !== type || l !== listener || o !== options
      );
    }
    #onload = null;
    #onloadend = null;
    #onerror = null;
    #onprogress = null;
    #onreadystatechange = null;
    get onload() {
      return this.#onload;
    }
    set onload(callback) {
      this.#onload = callback;
    }
    get onloadend() {
      return this.#onloadend;
    }
    set onloadend(callback) {
      this.#onloadend = callback;
    }
    get onerror() {
      return this.#onerror;
    }
    set onerror(callback) {
      this.#onerror = callback;
    }
    get onprogress() {
      return this.#onprogress;
    }
    set onprogress(callback) {
      this.#onprogress = callback;
    }
    get onreadystatechange() {
      return this.#onreadystatechange;
    }
    set onreadystatechange(callback) {
      this.#onreadystatechange = callback;
    }
    get status() {
      return this.#responseXHR?.status ?? super.status;
    }
    get statusText() {
      return this.#responseXHR?.statusText ?? super.statusText;
    }
    get responseURL() {
      return this.#responseXHR?.responseURL ?? super.responseURL;
    }
    get readyState() {
      return this.#responseXHR?.readyState ?? super.readyState;
    }
    get responseText() {
      return this.#responseXHR?.__responseText ?? this.#responseXHR?.responseText ?? super.responseText;
    }
    get responseType() {
      return this.#responseXHR?.responseType ?? super.responseType;
    }
    set responseType(value) {
      super.responseType = value;
    }
    #responseXHR;
    #getOnHandler(type) {
      switch (type) {
        case "load":
          return this.#onload;
        case "loadend":
          return this.#onloadend;
        case "error":
          return this.#onerror;
        case "progress":
          return this.#onprogress;
        case "readystatechange":
          return this.#onreadystatechange;
        default:
          return null;
      }
    }
    // Build a Response by reading from `super.*` rather than `this.*`. When
    // another extension subclasses CustomXHR (e.g. uBOL Lite's
    // json-prune-xhr-response), `this.response` walks the whole prototype
    // chain starting at the most-derived class, so vista's middleware would
    // receive data that has already been processed by a downstream layer.
    // Reading through `super` makes vista see only its direct upstream,
    // which is what the request/response pipeline model requires — see
    // docs/ubol-compat.md.
    #buildResponseFromSuper() {
      const status = super.status;
      const statusText = super.statusText;
      const responseType = super.responseType;
      const superResponse = super.response;
      const headers = parseHeadersText(
        super.getAllResponseHeaders.call(this)
      );
      let body = superResponse;
      if (BODYLESS_STATUS_CODES.includes(status)) {
        body = null;
      } else if (responseType === "" || responseType === "text") {
        body = super.responseText;
      } else if (responseType === "json") {
        body = JSON.stringify(superResponse);
      }
      return new Response(body, { status, statusText, headers });
    }
    async send(body) {
      this.#body = body;
      const origin = {
        req: new Request(this.#url, {
          method: this.#method,
          headers: this.#headers,
          body: this.#method === "GET" ? null : body
        }),
        res: new Response()
      };
      const c = {
        type: "xhr",
        req: origin.req,
        res: origin.res
      };
      try {
        await handleRequest(c, [
          ...CustomXHR.#middlewares,
          this.#getMiddleware(origin)
        ]);
      } catch (err) {
        if (err instanceof HTTPException) {
          this.#responseXHR = await responseToXHR(
            err.getResponse(),
            this.responseType
          );
        } else if (typeof err === "string") {
          this.#responseXHR = await responseToXHR(
            new Response(err, {
              status: 500,
              statusText: err
            }),
            this.responseType
          );
        } else if (err instanceof Error) {
          this.#responseXHR = await responseToXHR(
            new Response(err.message, { status: 500 }),
            this.responseType
          );
        } else {
          this.#responseXHR = await responseToXHR(
            new Response(JSON.stringify(err), {
              status: 500,
              statusText: "Internal Server Error"
            }),
            this.responseType
          );
        }
        const errorEvent = new ProgressEvent("error");
        this.#onerror?.call(this, errorEvent);
        this.#listeners.filter(([type]) => type === "error").forEach(([_type, listener, _options]) => {
          listener.call(this, errorEvent);
        });
        return;
      }
      if (c.res !== origin.res) {
        this.#responseXHR = await responseToXHR(c.res, this.responseType);
      }
      const progressCallbacks = this.#listeners.filter(
        ([type]) => type === "progress"
      );
      const hasProgress = progressCallbacks.length > 0 || this.#onprogress !== null;
      if (hasProgress) {
        if (this.#responseXHR?.response instanceof ReadableStream && c.res.headers.get("Content-Type") === "text/event-stream") {
          let responseText = "";
          const reader = c.res.clone().body.getReader();
          let receivedLength = 0;
          let chunk = await reader.read();
          while (!chunk.done) {
            receivedLength += chunk.value.length;
            const textChunk = new TextDecoder().decode(chunk.value);
            responseText += textChunk;
            const progressEvent = new ProgressEvent("progress", {
              loaded: receivedLength,
              lengthComputable: true,
              total: parseInt(c.res.headers.get("Content-Length") || "0", 10)
            });
            this.#responseXHR.__responseText = responseText;
            this.#onprogress?.call(this, progressEvent);
            progressCallbacks.forEach(([_type, listener, _options]) => {
              listener.call(this, progressEvent);
            });
            chunk = await reader.read();
          }
        } else {
          const progressEvent = new ProgressEvent("progress");
          this.#onprogress?.call(this, progressEvent);
          progressCallbacks.forEach(([_type, listener, _options]) => {
            listener.call(this, progressEvent);
          });
        }
      }
      for (const type of ["load", "loadend", "readystatechange"]) {
        const event = new ProgressEvent(type);
        this.#getOnHandler(type)?.call(this, event);
        this.#listeners.filter(([t]) => t === type).forEach(([_t, listener, _options]) => {
          listener.call(this, event);
        });
      }
    }
    #getMiddleware = (origin) => async (c) => {
      const openArgs = [c.req.method, c.req.url];
      if (this.#async !== void 0) {
        openArgs.push(this.#async);
      }
      if (this.#username !== void 0) {
        openArgs.push(this.#username);
      }
      if (this.#password !== void 0) {
        openArgs.push(this.#password);
      }
      super.open.apply(this, openArgs);
      for (const [name, value] of c.req.headers.entries()) {
        if (name === "content-type" && value.startsWith("multipart/form-data; boundary=")) {
          continue;
        }
        super.setRequestHeader.apply(this, [name, value]);
      }
      this.#listeners.filter(
        ([type]) => ![
          "load",
          "loadend",
          "readystatechange",
          "error",
          "progress"
        ].includes(type)
      ).forEach(([type, listener, options]) => {
        super.addEventListener.apply(this, [type, listener, options]);
      });
      let sendBody = this.#body;
      if (c.req !== origin.req) {
        sendBody = await c.req.blob();
      }
      await new Promise((resolve, reject) => {
        super.addEventListener.apply(this, [
          "load",
          (_ev) => {
            c.res = this.#buildResponseFromSuper();
            origin.res = c.res;
            resolve();
          }
        ]);
        super.addEventListener.apply(this, [
          "error",
          (_ev) => {
            reject(new Error(this.status + " " + this.statusText));
          }
        ]);
        super.addEventListener.apply(this, [
          "readystatechange",
          (ev) => {
            if (this.readyState === XMLHttpRequest.DONE) {
              return;
            }
            this.#onreadystatechange?.call(this, ev);
            this.#listeners.filter(([type]) => type === "readystatechange").forEach(([_type, listener, _options]) => {
              listener.call(this, ev);
            });
          }
        ]);
        if (c.req !== origin.req) {
          super.send.apply(this, [sendBody]);
        } else {
          super.send.apply(this, [this.#body]);
        }
      });
    };
  }
  const pureXHR = getGlobalThis().XMLHttpRequest;
  getGlobalThis().XMLHttpRequest = CustomXHR;
  CustomXHR.middlewares(middlewares);
  return () => {
    getGlobalThis().XMLHttpRequest = pureXHR;
  };
};
