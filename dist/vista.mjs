import { defaultBridgeDecode, postBridgeMessage } from "./bridge.mjs";
export class Vista {
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
}
export class TapObservable {
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
  getHandler() {
    return this.handler;
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
