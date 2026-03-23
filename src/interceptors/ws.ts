import { handleRequest } from '../context'
import type { Interceptor } from '../types'
import { getGlobalThis } from './fetch'

/** @beta */
export interface WSMessageEvent {
  readonly data: any
  replaceWith(data: string | ArrayBuffer | Blob | ArrayBufferView): void
  preventDefault(): void
}

/** @beta */
export interface WebSocketContext {
  type: 'websocket'
  url: string
  protocols: string | string[]

  /** Send a message to the client (simulate server pushing a message) */
  sendToClient(data: string | ArrayBuffer | Blob | ArrayBufferView): void
  /** Send a message to the server (simulate client sending a message) */
  sendToServer(data: string | ArrayBuffer | Blob | ArrayBufferView): void

  /** Intercept messages sent by the client (client → server direction) */
  onClientMessage(handler: (event: WSMessageEvent) => void): void
  /** Intercept messages sent by the server (server → client direction) */
  onServerMessage(handler: (event: WSMessageEvent) => void): void

  onOpen(handler: () => void): void
  onClose(handler: (code: number, reason: string) => void): void

  [key: string]: any
}

/** @beta */
export interface WSMiddleware {
  (c: WebSocketContext, next: () => Promise<void>): void | Promise<void>
}

/** @beta */
export const interceptWebSocket: Interceptor<WSMiddleware> = function (
  middlewares: WSMiddleware[],
) {
  const g = getGlobalThis()
  const OriginalWebSocket = g.WebSocket

  class CustomWebSocket extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3

    #readyState = 0
    #url: string
    #protocol = ''
    #extensions = ''
    #binaryType: BinaryType = 'blob'

    #realWs: WebSocket | null = null

    #clientMessageHandlers: ((event: WSMessageEvent) => void)[] = []
    #serverMessageHandlers: ((event: WSMessageEvent) => void)[] = []
    #openHandlers: (() => void)[] = []
    #closeHandlers: ((code: number, reason: string) => void)[] = []

    #onopen: ((this: WebSocket, ev: Event) => any) | null = null
    #onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null
    #onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null = null
    #onerror: ((this: WebSocket, ev: Event) => any) | null = null

    get readyState() {
      return this.#readyState
    }
    get url() {
      return this.#url
    }
    get protocol() {
      return this.#protocol
    }
    get extensions() {
      return this.#extensions
    }
    get binaryType() {
      return this.#binaryType
    }
    set binaryType(v: BinaryType) {
      this.#binaryType = v
      if (this.#realWs) this.#realWs.binaryType = v
    }
    get bufferedAmount() {
      return this.#realWs?.bufferedAmount ?? 0
    }

    get onopen() {
      return this.#onopen
    }
    set onopen(v) {
      this.#onopen = v
    }
    get onclose() {
      return this.#onclose
    }
    set onclose(v) {
      this.#onclose = v
    }
    get onmessage() {
      return this.#onmessage
    }
    set onmessage(v) {
      this.#onmessage = v
    }
    get onerror() {
      return this.#onerror
    }
    set onerror(v) {
      this.#onerror = v
    }

    constructor(url: string | URL, protocols?: string | string[]) {
      super()
      this.#url = url.toString()

      let connected = false

      const context: WebSocketContext = {
        type: 'websocket',
        url: this.#url,
        protocols: protocols ?? [],
        sendToClient: (data) => this.#emitMessage(data),
        sendToServer: (data) => {
          if (this.#realWs?.readyState === OriginalWebSocket.OPEN) {
            this.#realWs.send(data as any)
          }
        },
        onClientMessage: (h) => this.#clientMessageHandlers.push(h),
        onServerMessage: (h) => this.#serverMessageHandlers.push(h),
        onOpen: (h) => this.#openHandlers.push(h),
        onClose: (h) => this.#closeHandlers.push(h),
      }

      handleRequest(context, [
        ...middlewares,
        // Final middleware: establish real WebSocket connection
        (c) =>
          new Promise<void>((resolve, reject) => {
            connected = true
            const protocolsArg =
              Array.isArray(c.protocols) && c.protocols.length === 0
                ? undefined
                : c.protocols
            this.#realWs = new OriginalWebSocket(c.url, protocolsArg)
            this.#realWs.binaryType = this.#binaryType

            this.#realWs.onopen = () => {
              this.#readyState = 1
              this.#protocol = this.#realWs!.protocol
              this.#extensions = this.#realWs!.extensions
              this.#openHandlers.forEach((h) => h())
              this.#emitOpen()
              resolve()
            }

            this.#realWs.onmessage = (e) => {
              this.#processServerMessage(e.data)
            }

            this.#realWs.onclose = (e) => {
              this.#readyState = 3
              this.#closeHandlers.forEach((h) => h(e.code, e.reason))
              this.#emitClose(e.code, e.reason, e.wasClean)
            }

            this.#realWs.onerror = () => {
              this.#emitError()
              reject()
            }
          }),
      ])
        .then(() => {
          if (!connected) {
            // Mock mode: no next() was called, simulate open
            this.#readyState = 1
            this.#openHandlers.forEach((h) => h())
            this.#emitOpen()
          }
        })
        .catch(() => {
          // Connection error already handled via onerror
        })
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.#readyState !== 1) {
        throw new DOMException(
          "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
          'InvalidStateError',
        )
      }
      this.#processClientMessage(data)
    }

    close(code?: number, reason?: string) {
      if (this.#readyState >= 2) return
      this.#readyState = 2
      if (this.#realWs) {
        this.#realWs.close(code, reason)
      } else {
        // Mock mode: simulate close
        queueMicrotask(() => {
          this.#readyState = 3
          this.#closeHandlers.forEach((h) => h(code ?? 1000, reason ?? ''))
          this.#emitClose(code ?? 1000, reason ?? '', true)
        })
      }
    }

    // --- Message processing with interception ---

    #processClientMessage(data: any) {
      let currentData = data
      let prevented = false
      const wsEvent: WSMessageEvent = {
        get data() {
          return currentData
        },
        replaceWith(d) {
          currentData = d
        },
        preventDefault() {
          prevented = true
        },
      }
      for (const handler of this.#clientMessageHandlers) {
        handler(wsEvent)
        if (prevented) return
      }
      // Forward to real server (no-op in mock mode)
      if (this.#realWs?.readyState === OriginalWebSocket.OPEN) {
        this.#realWs.send(currentData)
      }
    }

    #processServerMessage(data: any) {
      let currentData = data
      let prevented = false
      const wsEvent: WSMessageEvent = {
        get data() {
          return currentData
        },
        replaceWith(d) {
          currentData = d
        },
        preventDefault() {
          prevented = true
        },
      }
      for (const handler of this.#serverMessageHandlers) {
        handler(wsEvent)
        if (prevented) return
      }
      // Forward to client
      this.#emitMessage(currentData)
    }

    // --- Event emission ---

    #emitOpen() {
      const event = new Event('open')
      this.#onopen?.call(this as any, event)
      this.dispatchEvent(event)
    }

    #emitMessage(data: any) {
      const event = new MessageEvent('message', { data })
      this.#onmessage?.call(this as any, event)
      this.dispatchEvent(event)
    }

    #emitClose(code: number, reason: string, wasClean: boolean) {
      const event = new CloseEvent('close', { code, reason, wasClean })
      this.#onclose?.call(this as any, event)
      this.dispatchEvent(event)
    }

    #emitError() {
      const event = new Event('error')
      this.#onerror?.call(this as any, event)
      this.dispatchEvent(event)
    }
  }

  g.WebSocket = CustomWebSocket as any
  return () => {
    g.WebSocket = OriginalWebSocket
  }
}
