import { Interceptor } from '../types';
export interface FetchContext {
    type: 'fetch' | 'xhr' | 'request';
    req: Request;
    res: Response;
    [key: string]: any;
}
export interface FetchMiddleware {
    (c: FetchContext, next: () => Promise<void>): void | Promise<void>;
}
export declare function stripRequestSignal(req: Request): Request;
export declare function getGlobalThis(): typeof globalThis;
export declare const interceptFetch: Interceptor<FetchMiddleware>;
