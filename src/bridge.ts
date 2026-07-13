import { FetchContext } from './interceptors/fetch'
import { BaseContext } from './types'
import { TapObservable } from './vista'

function getSource(): string {
  return `vista-bridge:${window.location.origin}`
}

export interface BridgeMessage<T = unknown> {
  source: string
  url: string
  payload: T
}

function matchUrl(matcher: string | RegExp, url: string): boolean {
  return typeof matcher === 'string' ? url.includes(matcher) : matcher.test(url)
}

async function defaultDecode(c: FetchContext): Promise<unknown> {
  const text = await c.res.clone().text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function post(url: string, payload: unknown): void {
  const message: BridgeMessage = {
    source: getSource(),
    url,
    payload,
  }
  window.postMessage(message, '*')
}

export function relay(
    tap: TapObservable<FetchContext>,
    decode: (c: FetchContext) => unknown | Promise<unknown> = defaultDecode,
): TapObservable<FetchContext> {
  return tap.subscribe(async (c) => {
    const payload = await decode(c)
    post(c.req.url, payload)
    return payload
  })
}

declare module './vista' {
  interface TapObservable<T extends BaseContext> {
    relay(): this
  }
}

TapObservable.prototype.relay = function (this: TapObservable<FetchContext>) {
  const handler = this.getHandler()
  this.unsubscribe()
  return this.subscribe(async (c) => {
    const payload = handler ? await handler(c) : await defaultDecode(c)
    post(c.req.url, payload)
    return payload
  })
}

export class IsolatedWorldReceiver<T = unknown> {
  private listeners = new Set<(message: BridgeMessage<T>) => void>()
  private store = new Map<string, T>()

  constructor() {
    window.addEventListener('message', this.handle)
  }

  private handle = (event: MessageEvent) => {
    if (event.source !== window) return
    if (event.origin !== window.location.origin) return
    const data = event.data as BridgeMessage<T> | undefined
    if (!data || data.source !== getSource()) return
    this.store.set(data.url, data.payload)
    this.listeners.forEach((listener) => listener(data))
  }

  get(url: string | RegExp): T | undefined {
    for (const [storedUrl, payload] of this.store) {
      if (matchUrl(url, storedUrl)) return payload
    }
    return undefined
  }

  on(url: string | RegExp, listener: (payload: T) => void): () => void {
    const wrapped = (message: BridgeMessage<T>) => {
      if (!matchUrl(url, message.url)) return
      listener(message.payload)
    }
    this.listeners.add(wrapped)
    return () => this.listeners.delete(wrapped)
  }

  wait(url: string | RegExp, timeoutMs = 15000): Promise<T | null> {
    const cached = this.get(url)
    if (cached !== undefined) return Promise.resolve(cached)

    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        off()
        resolve(null)
      }, timeoutMs)
      const off = this.on(url, (payload) => {
        window.clearTimeout(timer)
        off()
        resolve(payload)
      })
    })
  }

  destroy(): void {
    window.removeEventListener('message', this.handle)
    this.listeners.clear()
    this.store.clear()
  }
}