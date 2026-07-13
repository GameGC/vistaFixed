import { FetchContext } from './interceptors/fetch'
import {TapObservable} from "./vista";

export function getBridgeSource(): string {
  return `vista-bridge:${window.location.origin}`
}

export interface BridgeMessage<T = unknown> {
  source: string
  url: string
  payload: T
}

export function matchBridgeUrl(matcher: string | RegExp, url: string): boolean {
  return typeof matcher === 'string' ? url.includes(matcher) : matcher.test(url)
}

export async function defaultBridgeDecode(c: FetchContext): Promise<unknown> {
  const text = await c.res.clone().text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function postBridgeMessage(url: string, payload: unknown): void {
  const message: BridgeMessage = {
    source: getBridgeSource(),
    url,
    payload,
  }
  window.postMessage(message, '*')
}

export type { BridgeMessage }

export function relay(
    tap: TapObservable<FetchContext>,
    decode: (c: FetchContext) => unknown | Promise<unknown> = defaultBridgeDecode,
): TapObservable<FetchContext> {
  return tap.subscribe(async (c) => {
    const payload = await decode(c)
    postBridgeMessage(c.req.url, payload)
    return payload
  })
}

export class IsolatedWorldReceiver<T = unknown> {
  private listeners = new Set<(message: BridgeMessage<T>) => void>()
  private store = new Map<string, T>()

  constructor() {
    window.addEventListener('message', this.handle)
  }


  protected getKey(payload: T, url: string): string {
    return url
  }

  private handle = (event: MessageEvent) => {
    if (event.source !== window) return
    const data = event.data as BridgeMessage<T> | undefined
    if (!data || data.source !== getBridgeSource()) return


    const key = this.getKey(data.payload, data.url)

    this.store.set(key, data.payload)
    this.listeners.forEach((listener) => listener(data))
  }

  get(url: string | RegExp): T | undefined {
    for (const [storedUrl, payload] of this.store) {
      if (matchBridgeUrl(url, storedUrl)) return payload
    }
    return undefined
  }

  on(url: string | RegExp, listener: (payload: T) => void): () => void {
    const wrapped = (message: BridgeMessage<T>) => {
      if (!matchBridgeUrl(url, message.url)) return
      listener(message.payload)
    }
    this.listeners.add(wrapped)
    return () => this.listeners.delete(wrapped)
  }

  wait(url: string | RegExp, timeoutMs = 15000): Promise<T | null> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(value);
      };

      const off = this.on(url, (payload) => {
        finish(payload);
      });

      // Check after subscribing to avoid the race.
      const cached = this.get(url);
      if (cached !== undefined) {
        finish(cached);
        return;
      }

      const timer = window.setTimeout(() => {
        finish(null);
      }, timeoutMs);
    });
  }

  destroy(): void {
    window.removeEventListener('message', this.handle)
    this.listeners.clear()
    this.store.clear()
  }
}
