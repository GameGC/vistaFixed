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
      if (!matchBridgeUrl(url, message.url)) return;
      listener(message.payload);
    };
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }
  wait(url, timeoutMs = 15e3) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
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
      const timer = window.setTimeout(() => {
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
const interceptXHR = function(middlewares) {
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
