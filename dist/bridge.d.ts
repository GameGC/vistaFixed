import { FetchContext } from './interceptors/fetch';
import { TapObservable } from "./vista";
export declare function getBridgeSource(): string;
export interface BridgeMessage<T = unknown> {
    source: string;
    url: string;
    payload: T;
}
export declare function matchBridgeUrl(matcher: string | RegExp, url: string): boolean;
export declare function defaultBridgeDecode(c: FetchContext): Promise<unknown>;
export declare function postBridgeMessage(url: string, payload: unknown): void;
export type { BridgeMessage };
export declare function relay(tap: TapObservable<FetchContext>, decode?: (c: FetchContext) => unknown | Promise<unknown>): TapObservable<FetchContext>;
export declare class IsolatedWorldReceiver<T = unknown> {
    private listeners;
    private store;
    constructor();
    protected getKey(payload: T, url: string): string;
    private handle;
    get(url: string | RegExp): T | undefined;
    on(url: string | RegExp, listener: (payload: T) => void): () => void;
    wait(url: string | RegExp, timeoutMs?: number): Promise<T | null>;
    destroy(): void;
}
