import { BaseContext, BaseMiddleware } from './types';
export declare class Vista<T extends BaseContext> {
    private readonly interceptors;
    private middlewares;
    private cancels;
    constructor(interceptors?: Array<(middlewares: BaseMiddleware<T>[]) => () => void>);
    use(middleware: BaseMiddleware<T>): this;
    intercept(): void;
    destroy(): void;
}
