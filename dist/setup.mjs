import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { detectPort } from "detect-port";
let server;
export async function setup(project) {
  const port = await detectPort(3e3);
  const app = new Hono().use(cors()).get(
    "/todos/1",
    (c) => c.json({
      userId: 1,
      id: 1,
      title: "delectus aut autem",
      completed: false
    })
  ).get("/wait", async (c) => {
    const timeout = c.req.query("timeout");
    if (!timeout) {
      return c.text("ok");
    }
    await new Promise((resolve) => setTimeout(resolve, Number(timeout)));
    return c.text("ok");
  }).get("/empty", () => {
    return new Response(null, {
      status: 204
    });
  }).get("/headers", (c) => {
    return new Response(JSON.stringify(c.req.header()), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }).put("/echo", async (c) => {
    const body = await c.req.text();
    return c.text(body);
  }).get("/sse", (c) => {
    const count = Number(c.req.query("count"));
    const sleep = c.req.query("sleep") ? Number(c.req.query("sleep")) : 10;
    return streamSSE(c, async (stream) => {
      let id = 0;
      while (id < count) {
        const message = `It is ${(/* @__PURE__ */ new Date()).toISOString()}`;
        await stream.writeSSE({
          data: message,
          event: "time-update",
          id: String(id++)
        });
        await stream.sleep(sleep);
      }
    });
  }).post("/echo", async (c) => {
    const body = await c.req.text();
    return c.json({ echo: body });
  }).post("/upload", async (c) => {
    const boundary = c.req.header("Content-Type")?.slice("multipart/form-data; boundary=".length);
    if (!boundary) {
      return c.text("No boundary found", 400);
    }
    const body = await c.req.text();
    if (!body.includes(boundary)) {
      return c.text("Invalid multipart/form-data", 400);
    }
    return c.text(body);
  });
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      return {
        onMessage(event, ws) {
          ws.send(`echo:${event.data}`);
        }
      };
    })
  );
  project.provide("serverUrl", `http://localhost:${port}`);
  project.provide("wsUrl", `ws://localhost:${port}/ws`);
  server = serve({ ...app, port }, (info) => {
  });
  injectWebSocket(server);
}
export async function teardown() {
  await new Promise((resolve) => server.close(resolve));
}
