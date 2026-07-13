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
  return text.split("\r\n").filter((header) => header).reduce((acc, current) => {
    const index = current.indexOf(": ");
    if (index > -1) {
      const key = current.slice(0, index);
      const value = current.slice(index + 2);
      acc[key] = value;
    }
    return acc;
  }, {});
}
export const interceptXHR = function(middlewares) {
  if (typeof XMLHttpRequest === "undefined") {
    return () => {
    };
  }
  class CustomXHR extends getGlobalThis().XMLHttpRequest {
    _method = "";
    _url = "";
    _async;
    _username;
    _password;
    _headers = {};
    _body;
    // Internal state renamed from # to _
    _listeners = [];
    _responseXHR;
    _onload = null;
    _onloadend = null;
    _onerror = null;
    _onprogress = null;
    _onreadystatechange = null;
    static _middlewares = [];
    static middlewares(middlewares2) {
      CustomXHR._middlewares = middlewares2;
    }
    get response() {
      return this._responseXHR?.response ?? super.response;
    }
    getResponseHeader(name) {
      if (this._responseXHR) {
        return this._responseXHR.getResponseHeader(name);
      }
      return super.getResponseHeader(name);
    }
    getAllResponseHeaders() {
      if (this._responseXHR) {
        return this._responseXHR.getAllResponseHeaders();
      }
      return super.getAllResponseHeaders();
    }
    get withCredentials() {
      return super.withCredentials;
    }
    set withCredentials(value) {
      super.withCredentials = value;
    }
    open(method, url, async, username, password) {
      this._method = method;
      this._url = url;
      if (async !== void 0) this._async = async;
      if (username !== void 0) this._username = username;
      if (password !== void 0) this._password = password;
      super.open(method, url, async ?? true, username, password);
    }
    setRequestHeader(name, value) {
      const lowerName = name.toLowerCase();
      if (this._headers[lowerName]) {
        this._headers[lowerName] += `, ${value}`;
      } else {
        this._headers[lowerName] = value;
      }
    }
    addEventListener(type, listener, options) {
      this._listeners.push([type, listener, options]);
    }
    removeEventListener(type, listener, options) {
      this._listeners = this._listeners.filter(
        ([t, l, o]) => t !== type || l !== listener || o !== options
      );
    }
    // Getters/Setters for event handlers
    get onload() {
      return this._onload;
    }
    set onload(callback) {
      this._onload = callback;
    }
    get onloadend() {
      return this._onloadend;
    }
    set onloadend(callback) {
      this._onloadend = callback;
    }
    get onerror() {
      return this._onerror;
    }
    set onerror(callback) {
      this._onerror = callback;
    }
    get onprogress() {
      return this._onprogress;
    }
    set onprogress(callback) {
      this._onprogress = callback;
    }
    get onreadystatechange() {
      return this._onreadystatechange;
    }
    set onreadystatechange(callback) {
      this._onreadystatechange = callback;
    }
    // Overridden properties
    get status() {
      return this._responseXHR?.status ?? super.status;
    }
    get statusText() {
      return this._responseXHR?.statusText ?? super.statusText;
    }
    get responseURL() {
      return this._responseXHR?.responseURL ?? super.responseURL;
    }
    get readyState() {
      return this._responseXHR?.readyState ?? super.readyState;
    }
    get responseText() {
      return this._responseXHR?.__responseText ?? this._responseXHR?.responseText ?? super.responseText;
    }
    get responseType() {
      return this._responseXHR?.responseType ?? super.responseType;
    }
    set responseType(value) {
      super.responseType = value;
    }
    _getOnHandler(type) {
      switch (type) {
        case "load":
          return this._onload;
        case "loadend":
          return this._onloadend;
        case "error":
          return this._onerror;
        case "progress":
          return this._onprogress;
        case "readystatechange":
          return this._onreadystatechange;
        default:
          return null;
      }
    }
    _buildResponseFromSuper() {
      const status = super.status;
      const statusText = super.statusText;
      const responseType = super.responseType;
      const superResponse = super.response;
      const headers = parseHeadersText(super.getAllResponseHeaders.call(this));
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
      this._body = body;
      const origin = {
        req: new Request(this._url, {
          method: this._method,
          headers: this._headers,
          body: this._method === "GET" ? null : body
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
          ...CustomXHR._middlewares,
          this._getMiddleware(origin)
        ]);
      } catch (err) {
        if (err instanceof HTTPException) {
          this._responseXHR = await responseToXHR(err.getResponse(), this.responseType);
        } else if (typeof err === "string") {
          this._responseXHR = await responseToXHR(new Response(err, { status: 500, statusText: err }), this.responseType);
        } else if (err instanceof Error) {
          this._responseXHR = await responseToXHR(new Response(err.message, { status: 500 }), this.responseType);
        } else {
          this._responseXHR = await responseToXHR(new Response(JSON.stringify(err), { status: 500, statusText: "Internal Server Error" }), this.responseType);
        }
        const errorEvent = new ProgressEvent("error");
        this._onerror?.call(this, errorEvent);
        this._listeners.filter(([type]) => type === "error").forEach(([_type, listener, _options]) => {
          listener.call(this, errorEvent);
        });
        return;
      }
      if (c.res !== origin.res) {
        this._responseXHR = await responseToXHR(c.res, this.responseType);
      }
      const progressCallbacks = this._listeners.filter(([type]) => type === "progress");
      const hasProgress = progressCallbacks.length > 0 || this._onprogress !== null;
      if (hasProgress) {
        if (this._responseXHR?.response instanceof ReadableStream && c.res.headers.get("Content-Type") === "text/event-stream") {
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
            this._responseXHR.__responseText = responseText;
            this._onprogress?.call(this, progressEvent);
            progressCallbacks.forEach(([_type, listener, _options]) => {
              listener.call(this, progressEvent);
            });
            chunk = await reader.read();
          }
        } else {
          const progressEvent = new ProgressEvent("progress");
          this._onprogress?.call(this, progressEvent);
          progressCallbacks.forEach(([_type, listener, _options]) => {
            listener.call(this, progressEvent);
          });
        }
      }
      for (const type of ["load", "loadend", "readystatechange"]) {
        const event = new ProgressEvent(type);
        this._getOnHandler(type)?.call(this, event);
        this._listeners.filter(([t]) => t === type).forEach(([_t, listener, _options]) => {
          listener.call(this, event);
        });
      }
    }
    _getMiddleware = (origin) => async (c) => {
      const openArgs = [c.req.method, c.req.url];
      if (this._async !== void 0) openArgs.push(this._async);
      if (this._username !== void 0) openArgs.push(this._username);
      if (this._password !== void 0) openArgs.push(this._password);
      super.open.apply(this, openArgs);
      for (const [name, value] of c.req.headers.entries()) {
        if (name === "content-type" && value.startsWith("multipart/form-data; boundary=")) continue;
        super.setRequestHeader.apply(this, [name, value]);
      }
      this._listeners.filter(([type]) => !["load", "loadend", "readystatechange", "error", "progress"].includes(type)).forEach(([type, listener, options]) => {
        super.addEventListener.apply(this, [type, listener, options]);
      });
      let sendBody = this._body;
      if (c.req !== origin.req) {
        sendBody = await c.req.blob();
      }
      await new Promise((resolve, reject) => {
        super.addEventListener.apply(this, [
          "load",
          (_ev) => {
            c.res = this._buildResponseFromSuper();
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
            if (this.readyState === XMLHttpRequest.DONE) return;
            this._onreadystatechange?.call(this, ev);
            this._listeners.filter(([type]) => type === "readystatechange").forEach(([_type, listener, _options]) => {
              listener.call(this, ev);
            });
          }
        ]);
        if (c.req !== origin.req) {
          super.send.apply(this, [sendBody]);
        } else {
          super.send.apply(this, [this._body]);
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
