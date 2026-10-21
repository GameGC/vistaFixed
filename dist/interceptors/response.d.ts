import { Interceptor } from '../types';
import { FetchContext } from './fetch';
export interface ResponseMiddleware {
    (c: FetchContext, next: () => Promise<void>): void | Promise<void>;
}
export declare const interceptResponse: Interceptor<ResponseMiddleware>;
