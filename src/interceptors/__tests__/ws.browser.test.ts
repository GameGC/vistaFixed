import { beforeEach, inject, it, expect, vi } from 'vitest'
import { interceptWebSocket } from '../ws'

beforeEach(() => {
  vi.restoreAllMocks()
})

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket error')), {
      once: true,
    })
  })
}

function nextMessage(ws: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => resolve(e), { once: true })
  })
}

// Test raw WS connection without interception
it('should connect WebSocket', async () => {
  const ws = new WebSocket(inject('wsUrl'))
  await waitForOpen(ws)

  const msgPromise = nextMessage(ws)
  ws.send('Hello')
  const event = await msgPromise
  expect(event.data).toBe('echo:Hello')
  ws.close()
})

// Test pass-through middleware (calls next, no modification)
it('should pass through with middleware', async () => {
  const unIntercept = interceptWebSocket([
    async (_c, next) => {
      await next()
    },
  ])

  const ws = new WebSocket(inject('wsUrl'))
  await waitForOpen(ws)

  const msgPromise = nextMessage(ws)
  ws.send('Hello')
  const event = await msgPromise
  expect(event.data).toBe('echo:Hello')

  ws.close()
  unIntercept()
})

// Test intercepting client → server messages
it('should intercept and modify client messages', async () => {
  const unIntercept = interceptWebSocket([
    async (c, next) => {
      c.onClientMessage((event) => {
        event.replaceWith(`modified:${event.data}`)
      })
      await next()
    },
  ])

  const ws = new WebSocket(inject('wsUrl'))
  await waitForOpen(ws)

  const msgPromise = nextMessage(ws)
  ws.send('Hello')
  const event = await msgPromise
  // Server echoes what it receives, which should be the modified message
  expect(event.data).toBe('echo:modified:Hello')

  ws.close()
  unIntercept()
})

// Test intercepting server → client messages
it('should intercept and modify server messages', async () => {
  const unIntercept = interceptWebSocket([
    async (c, next) => {
      c.onServerMessage((event) => {
        event.replaceWith(`intercepted:${event.data}`)
      })
      await next()
    },
  ])

  const ws = new WebSocket(inject('wsUrl'))
  await waitForOpen(ws)

  const msgPromise = nextMessage(ws)
  ws.send('Hello')
  const event = await msgPromise
  expect(event.data).toBe('intercepted:echo:Hello')

  ws.close()
  unIntercept()
})

// Test blocking a client message with preventDefault
it('should block client message with preventDefault', async () => {
  const unIntercept = interceptWebSocket([
    async (c, next) => {
      c.onClientMessage((event) => {
        if (event.data === 'blocked') {
          event.preventDefault()
        }
      })
      await next()
    },
  ])

  const ws = new WebSocket(inject('wsUrl'))
  await waitForOpen(ws)

  // Send a message that should go through
  const msgPromise = nextMessage(ws)
  ws.send('Hello')
  const event = await msgPromise
  expect(event.data).toBe('echo:Hello')

  // Send a blocked message - server should not receive it, so no reply
  ws.send('blocked')

  // Send another message to confirm the connection still works
  const msgPromise2 = nextMessage(ws)
  ws.send('After')
  const event2 = await msgPromise2
  expect(event2.data).toBe('echo:After')

  ws.close()
  unIntercept()
})

// Test fully mocked WebSocket (no real connection)
it('should fully mock WebSocket connection', async () => {
  const unIntercept = interceptWebSocket([
    async (c) => {
      // Don't call next() - mock mode
      c.onClientMessage((event) => {
        c.sendToClient(`mock:${event.data}`)
      })
    },
  ])

  const ws = new WebSocket(inject('wsUrl'))
  await waitForOpen(ws)

  const msgPromise = nextMessage(ws)
  ws.send('Hello')
  const event = await msgPromise
  expect(event.data).toBe('mock:Hello')

  ws.close()
  unIntercept()
})

// Test that sendToClient works for injecting messages
it('should inject messages to client with sendToClient', async () => {
  const unIntercept = interceptWebSocket([
    async (c, next) => {
      await next()
      // Inject an extra message after connection opens
      c.sendToClient('injected-message')
    },
  ])

  const ws = new WebSocket(inject('wsUrl'))
  // The injected message arrives right after open
  const msgPromise = nextMessage(ws)
  await waitForOpen(ws)
  const event = await msgPromise
  expect(event.data).toBe('injected-message')

  ws.close()
  unIntercept()
})

// Test onOpen handler in middleware
it('should call onOpen handler', async () => {
  const openSpy = vi.fn()
  const unIntercept = interceptWebSocket([
    async (c, next) => {
      c.onOpen(() => openSpy())
      await next()
    },
  ])

  const ws = new WebSocket(inject('wsUrl'))
  await waitForOpen(ws)

  expect(openSpy).toHaveBeenCalledTimes(1)

  ws.close()
  unIntercept()
})

// Test onClose handler in middleware
it('should call onClose handler', async () => {
  const closeSpy = vi.fn()
  const unIntercept = interceptWebSocket([
    async (c, next) => {
      c.onClose((code, reason) => closeSpy(code, reason))
      await next()
    },
  ])

  const ws = new WebSocket(inject('wsUrl'))
  await waitForOpen(ws)
  ws.close()

  await new Promise<void>((resolve) => {
    ws.addEventListener('close', () => resolve(), { once: true })
  })
  expect(closeSpy).toHaveBeenCalledTimes(1)

  unIntercept()
})
