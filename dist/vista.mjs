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
}
