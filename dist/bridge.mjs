import { TapObservable } from "./vista.mjs";
function getSource() {
  return `vista-bridge:${window.location.origin}`;
}
function matchUrl(matcher, url) {
  return typeof matcher === "string" ? url.includes(matcher) : matcher.test(url);
}
async function defaultDecode(c) {
  const text = await c.res.clone().text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function post(url, payload) {
  const message = {
    source: getSource(),
    url,
    payload
  };
  window.postMessage(message, "*");
}
export function relay(tap, decode = defaultDecode) {
  return tap.subscribe(async (c) => {
    const payload = await decode(c);
    post(c.req.url, payload);
    return payload;
  });
}
TapObservable.prototype.relay = function() {
  const handler = this.getHandler();
  this.unsubscribe();
  return this.subscribe(async (c) => {
    const payload = handler ? await handler(c) : await defaultDecode(c);
    post(c.req.url, payload);
    return payload;
  });
};
export class IsolatedWorldReceiver {
  listeners = /* @__PURE__ */ new Set();
  store = /* @__PURE__ */ new Map();
  constructor() {
    window.addEventListener("message", this.handle);
  }
  handle = (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== getSource()) return;
    this.store.set(data.url, data.payload);
    this.listeners.forEach((listener) => listener(data));
  };
  get(url) {
    for (const [storedUrl, payload] of this.store) {
      if (matchUrl(url, storedUrl)) return payload;
    }
    return void 0;
  }
  on(url, listener) {
    const wrapped = (message) => {
      if (!matchUrl(url, message.url)) return;
      listener(message.payload);
    };
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }
  wait(url, timeoutMs = 15e3) {
    const cached = this.get(url);
    if (cached !== void 0) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
      const off = this.on(url, (payload) => {
        window.clearTimeout(timer);
        off();
        resolve(payload);
      });
    });
  }
  destroy() {
    window.removeEventListener("message", this.handle);
    this.listeners.clear();
    this.store.clear();
  }
}
