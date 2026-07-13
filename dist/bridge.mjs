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
export function relay(tap, decode = defaultDecode) {
  return tap.subscribe(async (c) => {
    const payload = await decode(c);
    const message = {
      source: getSource(),
      url: c.req.url,
      payload
    };
    window.postMessage(message, "*");
  });
}
export class IsolatedWorldReceiver {
  listeners = /* @__PURE__ */ new Set();
  store = /* @__PURE__ */ new Map();
  constructor() {
    window.addEventListener("message", this.handle);
  }
  handle = (event) => {
    if (event.source !== window) return;
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
