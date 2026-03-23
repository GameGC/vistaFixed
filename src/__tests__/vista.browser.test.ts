import { beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { Vista } from '../vista'
import { interceptFetch } from '../interceptors/fetch'
import { interceptXHR } from '../interceptors/xhr'
import { interceptWebSocket } from '../interceptors/ws'
import { userEvent } from '@vitest/browser/context'

describe('Vista', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  it('fetch', async () => {
    const vista = new Vista([interceptFetch, interceptXHR])
    const logger = vi.fn()
    vista.use(async (c, next) => {
      logger(c)
      await next()
      const r = await c.res.json()
      r.id = 2
      c.res = new Response(JSON.stringify(r), r)
    })
    vista.intercept()
    const r = await (
      await fetch('https://jsonplaceholder.typicode.com/todos/1')
    ).json()
    expect(r.id).toBe(2)
    expect(logger).toBeCalledTimes(1)

    vista.destroy()
  })
  it('websocket', async () => {
    const vista = new Vista([interceptWebSocket])
    const logger = vi.fn()
    vista.use(async (c, next) => {
      logger(c.url)
      c.onServerMessage((event) => {
        event.replaceWith(`intercepted:${event.data}`)
      })
      await next()
    })
    vista.intercept()

    const ws = new WebSocket(inject('wsUrl'))
    await new Promise((resolve) => ws.addEventListener('open', resolve))

    const msgPromise = new Promise<MessageEvent>((resolve) =>
      ws.addEventListener('message', resolve, { once: true }),
    )
    ws.send('Hello')
    const event = await msgPromise
    expect(event.data).toBe('intercepted:echo:Hello')
    expect(logger).toHaveBeenCalledTimes(1)

    ws.close()
    vista.destroy()
  })
})
