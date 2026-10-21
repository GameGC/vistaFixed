import { Interceptor } from '../types';
export interface ResponseContext {
    type: 'response';
    req: {
        url: string;
        method: string;
    };
    res: Response;
    via: 'arrayBuffer' | 'json' | 'text';
    [key: string]: any;
}
export interface ResponseMiddleware {
    (c: ResponseContext, next: () => Promise<void>): void | Promise<void>;
}
export declare const interceptResponse: Interceptor<ResponseMiddleware>;
