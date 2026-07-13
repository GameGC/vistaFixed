export function getBridgeSource() {
  return `vista-bridge:${window.location.origin}`;
}
export function matchBridgeUrl(matcher, url) {
  return typeof matcher === "string" ? url.includes(matcher) : matcher.test(url);
}
export async function defaultBridgeDecode(c) {
  const text = await c.res.clone().text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
export function postBridgeMessage(url, payload) {
  const message = {
    source: getBridgeSource(),
    url,
    payload
  };
  window.postMessage(message, "*");
}
export function relay(tap, decode = defaultBridgeDecode) {
  return tap.subscribe(async (c) => {
    const payload = await decode(c);
    postBridgeMessage(c.req.url, payload);
    return payload;
  });
}
export class IsolatedWorldReceiver {
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
