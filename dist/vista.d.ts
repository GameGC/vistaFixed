import { BaseContext, BaseMiddleware } from './types';
export declare class Vista<T extends BaseContext> {
    private readonly interceptors;
    private middlewares;
    private cancels;
    constructor(interceptors?: Array<(middlewares: BaseMiddleware<T>[]) => () => void>);
    use(middleware: BaseMiddleware<T>): this;
    intercept(): void;
    destroy(): void;
    unuse(middleware: BaseMiddleware<T>): this;
    tap(url: string | RegExp, method?: string): TapObservable<T>;
}
export declare class TapObservable<T extends BaseContext> {
    private vista;
    private url;
    private method?;
    constructor(vista: Vista<T>, url: string | RegExp, method?: string | undefined);
    private middleware;
    private handler;
    subscribe(handler: (c: T) => unknown): this;
    getHandler(): ((c: T) => unknown) | null;
    relay(): this;
    unsubscribe(): this;
}
