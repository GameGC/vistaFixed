import { handleRequest } from "../context.mjs";
import { getGlobalThis } from "./fetch.mjs";
export const interceptWebSocket = function(middlewares) {
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
