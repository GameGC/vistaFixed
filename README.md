# @rxliuli/vista

[![npm version](https://badge.fury.io/js/@rxliuli%2Fvista.svg)](https://www.npmjs.com/package/@rxliuli/vista)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A powerful homogeneous request interception library that supports unified interception of Fetch/XHR/WebSocket requests. It allows you to intervene at different stages of the request lifecycle, enabling various functions such as request monitoring, modification, and mocking.

## Characteristics

- 🚀 Supports Fetch, XHR and WebSocket interception
- 🎯 Use middleware pattern, flexible and easy to expand
- 💫 Support interventions before and after requests
- 🔄 Modifiable request and response data
- 📦 Zero dependency, compact size
- 🌐 Supports browser extension and userscript environments
- 🔄 Modifiable stream response

## Installation

```bash
npm install @rxliuli/vista
# Or
yarn add @rxliuli/vista
# Or
pnpm add @rxliuli/vista
```

### CDN Import

Use directly in the browser via CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/@rxliuli/vista@latest/dist/index.iife.mjs"></script>
```

For userscripts (Tampermonkey/Greasemonkey):

```js
// @require https://cdn.jsdelivr.net/npm/@rxliuli/vista@latest/dist/index.iife.mjs
```

> **Note**: If uploading to Greasyfork, replace `@latest` with a specific version number.

Vista automatically detects the userscript environment and uses `unsafeWindow` to intercept page-level requests, so no additional configuration is needed.

## Basic Usage

### CDN Usage

```js
const { Vista, interceptFetch, interceptXHR } = window.Vista;
```

### NPM Usage

```ts
import { Vista, interceptFetch, interceptXHR } from '@rxliuli/vista'

new Vista([interceptFetch, interceptXHR])
  .use(async (c, next) => {
    console.log('Request started:', c.req.url)
    await next()
  })
  .use(async (c, next) => {
    await next()
    console.log('Response data:', await c.res.clone().text())
  })
  .intercept()
```

## Advanced Use Cases

### Add global request headers

```ts
new Vista([interceptFetch, interceptXHR])
  .use(async (c, next) => {
    c.req.headers.set('Authorization', 'Bearer token')
    await next()
  })
  .intercept()
```

### Modify request URL

```ts
new Vista([interceptFetch, interceptXHR])
  .use(async (c, next) => {
    const newUrl = 'https://example.com/new-url'
    c.req = new Request(newUrl + '?url=' + c.req.url, c.req)
    await next()
  })
  .intercept()
```

### Modify POST request URL

```ts
new Vista([interceptFetch, interceptXHR])
  .use(async (c, next) => {
    if (c.req.method === 'POST' && c.req.url.includes('/old-endpoint')) {
      c.req = new Request('https://example.com/new-endpoint', {
        method: c.req.method,
        headers: c.req.headers,
        body: await c.req.text(),
        duplex: 'half',
      } as RequestInit)
    }
    await next()
  })
  .intercept()
```

> **Note**: When modifying a POST request URL, you need to read the body with `await c.req.text()` and set `duplex: 'half'` to properly transfer the request body.

### Request Result Cache

```ts
const cache = new Map()

new Vista([interceptFetch, interceptXHR])
  .use(async (c, next) => {
    const key = c.req.url
    if (cache.has(key)) {
      c.res = cache.get(key).clone()
      return
    }
    await next()
    cache.set(key, c.res.clone())
  })
  .intercept()
```

### Request failed, please retry

```ts
new Vista([interceptFetch, interceptXHR])
  .use(async (c, next) => {
    const maxRetries = 3
    let retries = 0

    while (retries < maxRetries) {
      try {
        await next()
        break
      } catch (err) {
        retries++
        if (retries === maxRetries) throw err
      }
    }
  })
  .intercept()
```

### Dynamic modify response

```ts
new Vista([interceptFetch, interceptXHR])
  .use(async (c, next) => {
    await next()
    if (c.req.url === 'https://example.com/example') {
      const json = await c.res.json()
      json.id = 2
      c.res = new Response(JSON.stringify(json), c.res)
    }
  })
  .intercept()
```

### Modify stream response

```ts
new Vista([interceptFetch, interceptXHR])
  .use(async (c, next) => {
    await next()
    if (
      c.res.headers.get('Content-Type') === 'text/event-stream' &&
      c.res.body
    ) {
      c.res = new Response(
        new ReadableStream({
          async start(controller) {
            const reader = c.res.body!.getReader()
            let chunk = await reader.read()
            while (!chunk.done) {
              // send two chunk to client
              controller.enqueue(chunk.value)
              controller.enqueue(chunk.value)
              chunk = await reader.read()
            }
            controller.close()
          },
        }),
        c.res,
      )
    }
  })
  .intercept()
```

### Intercept WebSocket messages

```ts
import { Vista, interceptWebSocket } from '@rxliuli/vista'

new Vista([interceptWebSocket])
  .use(async (c, next) => {
    // Intercept messages from server → client
    c.onServerMessage((event) => {
      console.log('Server sent:', event.data)
      event.replaceWith(`[modified] ${event.data}`) // modify the message
    })
    // Intercept messages from client → server
    c.onClientMessage((event) => {
      console.log('Client sending:', event.data)
      // event.preventDefault() // block the message
    })
    await next() // establish real connection
  })
  .intercept()
```

### Mock WebSocket connection

```ts
import { Vista, interceptWebSocket } from '@rxliuli/vista'

new Vista([interceptWebSocket])
  .use(async (c) => {
    // Don't call next() — fully mock the connection
    c.onClientMessage((event) => {
      // Simulate server response
      c.sendToClient(`Echo: ${event.data}`)
    })
  })
  .intercept()
```

## API Reference

### Vista Class

Main interceptor class, providing the following methods:

- `use(middleware)`: Add middleware
- `intercept()`: Start intercepting requests
- `destroy()`: Stop intercepting requests

### Middleware Context

The middleware function receives two parameters:

- `context`: Contains request and response information
  - `req`: Request object
    `res`: Response object
  - `type`: Request type, `fetch` or `xhr`
- `next`: Call the function of the next middleware or original request

### WebSocket Middleware Context

The WebSocket middleware function receives:

- `context`: WebSocket connection context
  - `url`: The WebSocket URL
  - `protocols`: Requested sub-protocols
  - `sendToClient(data)`: Inject a message to the client (simulate server push)
  - `sendToServer(data)`: Send a message to the server (simulate client send)
  - `onClientMessage(handler)`: Intercept client → server messages. The handler receives an event with `data`, `replaceWith(newData)`, and `preventDefault()`
  - `onServerMessage(handler)`: Intercept server → client messages (same event interface)
  - `onOpen(handler)`: Called when the connection opens
  - `onClose(handler)`: Called when the connection closes, receives `(code, reason)`
- `next`: Call to establish the real WebSocket connection. If not called, the connection is fully mocked

## FAQ

1. **How to stop interception?**

   ```ts
   const vista = new Vista([interceptFetch, interceptXHR])
   vista.intercept()
   // When not needed
   vista.destroy()
   ```

2. **Does it support asynchronous operations?**
   Yes, the middleware supports async/await syntax.

3. **Does it support intercepting requests in Node.js?**

   No, it only supports intercepting requests in the browser.

## Thank you

- [xhook](https://github.com/jpillora/xhook): A library that implements xhr interception, helpful for the implementation of some features.
- [hono](https://github.com/honojs/hono): An excellent web server framework that provides a lot of inspiration in its API.

## Contribution Guidelines

Welcome to submit Issues and Pull Requests!

## License

[MIT License](./LICENSE)
