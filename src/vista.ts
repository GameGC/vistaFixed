import { BaseContext, BaseMiddleware } from './types'

export class Vista<T extends BaseContext> {
  private middlewares: BaseMiddleware<T>[] = []

  private cancels: (() => void)[] = []

  constructor(
    private readonly interceptors: Array<
      (middlewares: BaseMiddleware<T>[]) => () => void
    > = [],
  ) {}

  use(middleware: BaseMiddleware<T>) {
    this.middlewares.push(middleware)
    return this
  }

  intercept() {
    this.cancels = this.interceptors.map((interceptor) =>
      interceptor(this.middlewares),
    )
  }

  destroy() {
    this.cancels.forEach((cancel) => cancel())
    this.cancels = []
  }

  unuse(middleware: BaseMiddleware<T>) {
    this.middlewares = this.middlewares.filter(m => m !== middleware)
    return this
  }

  tap(url: string | RegExp, method?: string): TapObservable<T> {
    return new TapObservable(this, url, method)
  }
}
export class TapObservable<T extends BaseContext> {
  constructor(
      private vista: Vista<T>,
      private url: string | RegExp,
      private method?: string,
  ) {}

  private middleware: BaseMiddleware<T> | null = null

  subscribe(handler: (c: T) => void): this {
    this.middleware = async (c: T, next: () => Promise<void>) => {
      await next()
      const matchUrl =
          typeof this.url === 'string' ? c.req.url === this.url : this.url.test(c.req.url)
      const matchMethod = !this.method || c.req.method.toUpperCase() === this.method.toUpperCase()
      if (matchUrl && matchMethod) handler(c)
    }
    this.vista.use(this.middleware)
    return this
  }

  unsubscribe(): this {
    if (this.middleware) {
      this.vista.unuse(this.middleware)
      this.middleware = null
    }
    return this
  }
}