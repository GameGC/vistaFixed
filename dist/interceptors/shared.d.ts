export declare const deliveredByRequestChannel: WeakSet<object>;
/** Пометить Response как доставленный запросным каналом. */
export declare function markDelivered(res: object): void;
export declare const responseNatives: Partial<Record<'arrayBuffer' | 'json' | 'text', any>>;
/** Маскировка патченых методов под нативные (анти-детект toString). */
export declare function makeLookNative(replacementFn: any, nativeFn: any): any;
