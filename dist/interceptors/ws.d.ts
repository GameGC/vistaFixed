import type { Interceptor } from '../types';
/** @beta */
export interface WSMessageEvent {
    readonly data: any;
    replaceWith(data: string | ArrayBuffer | Blob | ArrayBufferView): void;
    preventDefault(): void;
}
/** @beta */
export interface WebSocketContext {
    type: 'websocket';
    url: string;
    protocols: string | string[];
    /** Send a message to the client (simulate server pushing a message) */
    sendToClient(data: string | ArrayBuffer | Blob | ArrayBufferView): void;
    /** Send a message to the server (simulate client sending a message) */
    sendToServer(data: string | ArrayBuffer | Blob | ArrayBufferView): void;
    /** Intercept messages sent by the client (client → server direction) */
    onClientMessage(handler: (event: WSMessageEvent) => void): void;
    /** Intercept messages sent by the server (server → client direction) */
    onServerMessage(handler: (event: WSMessageEvent) => void): void;
    onOpen(handler: () => void): void;
    onClose(handler: (code: number, reason: string) => void): void;
    [key: string]: any;
}
/** @beta */
export interface WSMiddleware {
    (c: WebSocketContext, next: () => Promise<void>): void | Promise<void>;
}
/** @beta */
export declare const interceptWebSocket: Interceptor<WSMiddleware>;
