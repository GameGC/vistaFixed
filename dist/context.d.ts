import { BaseContext, BaseMiddleware } from './types';
export declare function handleRequest<T extends BaseContext>(context: T, middlewares: BaseMiddleware<T>[]): Promise<void>;
