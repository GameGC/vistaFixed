function getBridgeSource() {
  return `vista-bridge:${window.location.origin}`;
}
function matchBridgeUrl(matcher, url) {
  return typeof matcher === "string" ? url.includes(matcher) : matcher.test(url);
}
async function defaultBridgeDecode(c) {
  const text = await c.res.clone().text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function postBridgeMessage(url, payload) {
  const message = {
    source: getBridgeSource(),
    url,
    payload
  };
  window.postMessage(message, "*");
}
function relay(tap, decode = defaultBridgeDecode) {
  return tap.subscribe(async (c) => {
    const payload = await decode(c);
    postBridgeMessage(c.req.url, payload);
    return payload;
  });
}
class IsolatedWorldReceiver {
  listeners = /* @__PURE__ */ new Set();
  store = /* @__PURE__ */ new Map();
  constructor() {
    window.addEventListener("message", this.handle);
  }
  getKey(payload, url) {
    return url;
  }
  handle = (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== getBridgeSource()) return;
    const key = this.getKey(data.payload, data.url);
    this.store.set(key, data.payload);
    this.listeners.forEach((listener) => listener(data));
  };
  get(url) {
    for (const [storedUrl, payload] of this.store) {
      if (matchBridgeUrl(url, storedUrl)) return payload;
    }
    return void 0;
  }
  on(url, listener) {
    const wrapped = (message) => {
      const key = this.getKey(message.payload, message.url);
      if (!matchBridgeUrl(url, key)) return;
      listener(message.payload);
    };
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }
  wait(url, timeoutMs = 15e3) {
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer)
          clearTimeout(timer);
        off();
        resolve(value);
      };
      const off = this.on(url, (payload) => {
        finish(payload);
      });
      const cached = this.get(url);
      if (cached !== void 0) {
        finish(cached);
        return;
      }
      timer = window.setTimeout(() => {
        finish(null);
      }, timeoutMs);
    });
  }
  destroy() {
    window.removeEventListener("message", this.handle);
    this.listeners.clear();
    this.store.clear();
  }
}

let Vista$1 = class Vista {
  constructor(interceptors = []) {
    this.interceptors = interceptors;
  }
  middlewares = [];
  cancels = [];
  use(middleware) {
    this.middlewares.push(middleware);
    return this;
  }
  intercept() {
    this.cancels = this.interceptors.map(
      (interceptor) => interceptor(this.middlewares)
    );
  }
  destroy() {
    this.cancels.forEach((cancel) => cancel());
    this.cancels = [];
  }
  unuse(middleware) {
    this.middlewares = this.middlewares.filter((m) => m !== middleware);
    return this;
  }
  tap(url, method) {
    return new TapObservable(this, url, method);
  }
};
class TapObservable {
  constructor(vista, url, method) {
    this.vista = vista;
    this.url = url;
    this.method = method;
  }
  middleware = null;
  handler = null;
  subscribe(handler) {
    this.handler = handler;
    if (!this.middleware) {
      this.middleware = async (c, next) => {
        await next();
        const matchUrl = typeof this.url === "string" ? c.req.url === this.url : this.url.test(c.req.url);
        const matchMethod = !this.method || c.req.method.toUpperCase() === this.method.toUpperCase();
        if (matchUrl && matchMethod && this.handler) this.handler(c);
      };
      this.vista.use(this.middleware);
    }
    return this;
  }
  relay() {
    const handler = this.handler;
    return this.subscribe(async (c) => {
      const payload = handler ? await handler(c) : await defaultBridgeDecode(c);
      postBridgeMessage(c.req.url, payload);
      return payload;
    });
  }
  unsubscribe() {
    if (this.middleware) {
      this.vista.unuse(this.middleware);
      this.middleware = null;
    }
    return this;
  }
}

async function handleRequest(context, middlewares) {
  const compose = (i) => {
    if (i >= middlewares.length) {
      return Promise.resolve();
    }
    return middlewares[i](context, () => compose(i + 1));
  };
  await compose(0);
}

class HTTPException extends Error {
  res;
  status;
  /**
   * Creates an instance of `HTTPException`.
   * @param status - HTTP status code for the exception. Defaults to 500.
   * @param options - Additional options for the exception.
   */
  constructor(status = 500, options) {
    super(options?.message, { cause: options?.cause });
    this.res = options?.res;
    this.status = status;
  }
  /**
   * Returns the response object associated with the exception.
   * If a response object is not provided, a new response is created with the error message and status code.
   * @returns The response object.
   */
  getResponse() {
    if (this.res) {
      const newResponse = new Response(this.res.body, {
        status: this.status,
        headers: this.res.headers
      });
      return newResponse;
    }
    return new Response(this.message, {
      status: this.status
    });
  }
}

function stripRequestSignal(req) {
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
    init.duplex = "half";
  }
  return new Request(req.url, init);
}
function getGlobalThis() {
  if (typeof unsafeWindow !== "undefined") {
    return unsafeWindow;
  }
  return globalThis;
}
const interceptFetch = function(middlewares) {
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
    globalContext.fetch = makeLookNative$1(pureFetch, globalContext.fetch);
  };
};
const originalDefineProperty$1 = Object.defineProperty;
const originalFunctionToString$1 = Function.prototype.toString;
function makeLookNative$1(replacementFn, nativeFn) {
  const nativeSource = originalFunctionToString$1.call(nativeFn);
  originalDefineProperty$1(replacementFn, "toString", {
    value() {
      return nativeSource;
    },
    writable: true,
    configurable: true,
    enumerable: false
  });
  try {
    originalDefineProperty$1(replacementFn, "name", { value: nativeFn.name, configurable: true });
  } catch (_) {
  }
  try {
    originalDefineProperty$1(replacementFn, "length", { value: nativeFn.length, configurable: true });
  } catch (_) {
  }
  return replacementFn;
}

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
  if (!BODYLESS_STATUS_CODES.includes(res.status)) {
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
const interceptXHR = function(middlewares) {
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
  const constructorProxy = new Proxy(NativeXHR, {
    construct(target, args, newTarget) {
      const xhr = Reflect.construct(target, args, newTarget);
      originalDefineProperty(xhr, "open", {
        value: function(...args2) {
          return proto.open.apply(this, args2);
        },
        writable: true,
        configurable: true,
        enumerable: true
      });
      originalDefineProperty(xhr, "setRequestHeader", {
        value: function(...args2) {
          return proto.setRequestHeader.apply(this, args2);
        },
        writable: true,
        configurable: true,
        enumerable: true
      });
      originalDefineProperty(xhr, "send", {
        value: function(...args2) {
          return proto.send.apply(this, args2);
        },
        writable: true,
        configurable: true,
        enumerable: true
      });
      originalDefineProperty(xhr, "abort", {
        value: function(...args2) {
          return proto.abort.apply(this, args2);
        },
        writable: true,
        configurable: true,
        enumerable: true
      });
      return xhr;
    }
  });
  if (g.XMLHttpRequest === NativeXHR) {
    g.XMLHttpRequest = constructorProxy;
    for (const key of ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"]) {
      if (NativeXHR[key] !== void 0) {
        try {
          originalDefineProperty(constructorProxy, key, {
            value: NativeXHR[key],
            writable: false,
            configurable: false,
            enumerable: true
          });
        } catch (_) {
        }
      }
    }
  }
  return () => {
    proto.open = originalOpen;
    proto.setRequestHeader = originalSetRequestHeader;
    proto.send = originalSend;
    proto.abort = originalAbort;
    delete proto.__xhrPatched;
    if (g.XMLHttpRequest === constructorProxy) {
      g.XMLHttpRequest = NativeXHR;
    }
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
  await applyResponseToXHR(xhr, res, s.responseType);
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
    await applyResponseToXHR(xhr, c.res, s.responseType);
  }
  if (!isSSE) {
    xhr.dispatchEvent(new ProgressEvent("progress"));
  }
  xhr.dispatchEvent(new ProgressEvent("readystatechange"));
  xhr.dispatchEvent(new ProgressEvent("load"));
  xhr.dispatchEvent(new ProgressEvent("loadend"));
}

const interceptWebSocket = function(middlewares) {
  const g = getGlobalThis();
  const OriginalWebSocket = g.WebSocket;
  class CustomWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    #readyState = 0;
    #url;
    #protocol = "";
    #extensions = "";
    #binaryType = "blob";
    #realWs = null;
    #clientMessageHandlers = [];
    #serverMessageHandlers = [];
    #openHandlers = [];
    #closeHandlers = [];
    #onopen = null;
    #onclose = null;
    #onmessage = null;
    #onerror = null;
    get readyState() {
      return this.#readyState;
    }
    get url() {
      return this.#url;
    }
    get protocol() {
      return this.#protocol;
    }
    get extensions() {
      return this.#extensions;
    }
    get binaryType() {
      return this.#binaryType;
    }
    set binaryType(v) {
      this.#binaryType = v;
      if (this.#realWs) this.#realWs.binaryType = v;
    }
    get bufferedAmount() {
      return this.#realWs?.bufferedAmount ?? 0;
    }
    get onopen() {
      return this.#onopen;
    }
    set onopen(v) {
      this.#onopen = v;
    }
    get onclose() {
      return this.#onclose;
    }
    set onclose(v) {
      this.#onclose = v;
    }
    get onmessage() {
      return this.#onmessage;
    }
    set onmessage(v) {
      this.#onmessage = v;
    }
    get onerror() {
      return this.#onerror;
    }
    set onerror(v) {
      this.#onerror = v;
    }
    constructor(url, protocols) {
      super();
      this.#url = url.toString();
      let connected = false;
      const context = {
        type: "websocket",
        url: this.#url,
        protocols: protocols ?? [],
        sendToClient: (data) => this.#emitMessage(data),
        sendToServer: (data) => {
          if (this.#realWs?.readyState === OriginalWebSocket.OPEN) {
            this.#realWs.send(data);
          }
        },
        onClientMessage: (h) => this.#clientMessageHandlers.push(h),
        onServerMessage: (h) => this.#serverMessageHandlers.push(h),
        onOpen: (h) => this.#openHandlers.push(h),
        onClose: (h) => this.#closeHandlers.push(h)
      };
      handleRequest(context, [
        ...middlewares,
        // Final middleware: establish real WebSocket connection
        (c) => new Promise((resolve, reject) => {
          connected = true;
          const protocolsArg = Array.isArray(c.protocols) && c.protocols.length === 0 ? void 0 : c.protocols;
          this.#realWs = new OriginalWebSocket(c.url, protocolsArg);
          this.#realWs.binaryType = this.#binaryType;
          this.#realWs.onopen = () => {
            this.#readyState = 1;
            this.#protocol = this.#realWs.protocol;
            this.#extensions = this.#realWs.extensions;
            this.#openHandlers.forEach((h) => h());
            this.#emitOpen();
            resolve();
          };
          this.#realWs.onmessage = (e) => {
            this.#processServerMessage(e.data);
          };
          this.#realWs.onclose = (e) => {
            this.#readyState = 3;
            this.#closeHandlers.forEach((h) => h(e.code, e.reason));
            this.#emitClose(e.code, e.reason, e.wasClean);
          };
          this.#realWs.onerror = () => {
            this.#emitError();
            reject();
          };
        })
      ]).then(() => {
        if (!connected) {
          this.#readyState = 1;
          this.#openHandlers.forEach((h) => h());
          this.#emitOpen();
        }
      }).catch(() => {
      });
    }
    send(data) {
      if (this.#readyState !== 1) {
        throw new DOMException(
          "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
          "InvalidStateError"
        );
      }
      this.#processClientMessage(data);
    }
    close(code, reason) {
      if (this.#readyState >= 2) return;
      this.#readyState = 2;
      if (this.#realWs) {
        this.#realWs.close(code, reason);
      } else {
        queueMicrotask(() => {
          this.#readyState = 3;
          this.#closeHandlers.forEach((h) => h(code ?? 1e3, reason ?? ""));
          this.#emitClose(code ?? 1e3, reason ?? "", true);
        });
      }
    }
    // --- Message processing with interception ---
    #processClientMessage(data) {
      let currentData = data;
      let prevented = false;
      const wsEvent = {
        get data() {
          return currentData;
        },
        replaceWith(d) {
          currentData = d;
        },
        preventDefault() {
          prevented = true;
        }
      };
      for (const handler of this.#clientMessageHandlers) {
        handler(wsEvent);
        if (prevented) return;
      }
      if (this.#realWs?.readyState === OriginalWebSocket.OPEN) {
        this.#realWs.send(currentData);
      }
    }
    #processServerMessage(data) {
      let currentData = data;
      let prevented = false;
      const wsEvent = {
        get data() {
          return currentData;
        },
        replaceWith(d) {
          currentData = d;
        },
        preventDefault() {
          prevented = true;
        }
      };
      for (const handler of this.#serverMessageHandlers) {
        handler(wsEvent);
        if (prevented) return;
      }
      this.#emitMessage(currentData);
    }
    // --- Event emission ---
    #emitOpen() {
      const event = new Event("open");
      this.#onopen?.call(this, event);
      this.dispatchEvent(event);
    }
    #emitMessage(data) {
      const event = new MessageEvent("message", { data });
      this.#onmessage?.call(this, event);
      this.dispatchEvent(event);
    }
    #emitClose(code, reason, wasClean) {
      const event = new CloseEvent("close", { code, reason, wasClean });
      this.#onclose?.call(this, event);
      this.dispatchEvent(event);
    }
    #emitError() {
      const event = new Event("error");
      this.#onerror?.call(this, event);
      this.dispatchEvent(event);
    }
  }
  g.WebSocket = CustomWebSocket;
  return () => {
    g.WebSocket = OriginalWebSocket;
  };
};

const defaultTimeoutException = new HTTPException(504, {
  message: "Gateway Timeout"
});
const timeout = (duration, exception = defaultTimeoutException) => {
  return async function timeout2(context, next) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(typeof exception === "function" ? exception(context) : exception);
      }, duration);
    });
    try {
      await Promise.race([next(), timeoutPromise]);
    } finally {
      if (timer !== void 0) {
        clearTimeout(timer);
      }
    }
  };
};

const prettyJSON = (options) => {
  const targetQuery = options?.query ?? "pretty";
  return async function prettyJSON2(c, next) {
    const pretty = !!new URL(c.req.url).searchParams.has(targetQuery);
    await next();
    if (pretty && c.res.headers.get("Content-Type")?.startsWith("application/json")) {
      const obj = await c.res.json();
      c.res = new Response(
        JSON.stringify(obj, null, options?.space ?? 2),
        c.res
      );
    }
  };
};

const Vista = {
  __proto__: null,
  IsolatedWorldReceiver: IsolatedWorldReceiver,
  TapObservable: TapObservable,
  Vista: Vista$1,
  defaultBridgeDecode: defaultBridgeDecode,
  getBridgeSource: getBridgeSource,
  getGlobalThis: getGlobalThis,
  interceptFetch: interceptFetch,
  interceptWebSocket: interceptWebSocket,
  interceptXHR: interceptXHR,
  matchBridgeUrl: matchBridgeUrl,
  postBridgeMessage: postBridgeMessage,
  prettyJSON: prettyJSON,
  relay: relay,
  stripRequestSignal: stripRequestSignal,
  timeout: timeout
};

window.Vista = Vista;
