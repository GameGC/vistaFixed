import { FetchContext } from './interceptors/fetch';
import { BaseContext } from './types';
import { TapObservable } from './vista';
export interface BridgeMessage<T = unknown> {
    source: string;
    url: string;
    payload: T;
}
export declare function relay(tap: TapObservable<FetchContext>, decode?: (c: FetchContext) => unknown | Promise<unknown>): TapObservable<FetchContext>;
declare module './vista' {
    interface TapObservable<T extends BaseContext> {
        relay(): this;
    }
}
export declare class IsolatedWorldReceiver<T = unknown> {
    private listeners;
    private store;
    constructor();
    private handle;
    get(url: string | RegExp): T | undefined;
    on(url: string | RegExp, listener: (payload: T) => void): () => void;
    wait(url: string | RegExp, timeoutMs?: number): Promise<T | null>;
    destroy(): void;
}
