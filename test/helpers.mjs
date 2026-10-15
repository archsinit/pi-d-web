import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { initialize, readToken } from "../src/config.mjs";
import { startWebServer } from "../src/server.mjs";
import { JsonPeer } from "../src/wire.mjs";

export async function until(read, check = Boolean, timeout = 6000) {
  const began = Date.now();
  while (Date.now() - began < timeout) {
    const value = await read();
    if (check(value)) return value;
    await delay(20);
  }
  throw new Error("Timed out waiting for fixture state.");
}

export async function fixture(options = {}) {
  const home = await mkdtemp("/tmp/pi-d-web-");
  await initialize(home);
  const token = await readToken(home);
  const server = await startWebServer({ home, token, port: 0, ...options });
  const origin = `http://127.0.0.1:${server.port}`;
  let cookie;
  async function request(path, { method = "GET", value, headers = {}, auth = true, ...rest } = {}) {
    return fetch(`${origin}${path}`, {
      method, headers: { ...(auth && cookie ? { Cookie: cookie } : {}), ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), ...rest,
    });
  }
  async function login() {
    const response = await request("/api/login", { method: "POST", value: { token }, auth: false });
    if (response.status !== 200) throw new Error("Fixture login failed.");
    cookie = response.headers.get("set-cookie").split(";")[0];
    return response;
  }
  async function list() { return (await request("/api/sessions")).json(); }
  async function cleanup() { await server.close(); await rm(home, { recursive: true, force: true }); }
  return { home, token, server, origin, request, login, list, cleanup, cookie: () => cookie };
}

export async function fakeSession(server, { id = randomUUID(), name = "Fixture", respond, conversationId = 0 } = {}) {
  const socket = createConnection(server.socketPath);
  const peer = new JsonPeer(socket);
  await once(socket, "connect");
  const requests = [];
  peer.on("message", (frame) => {
    if (frame.type !== "request") return;
    requests.push(frame);
    if (respond) void Promise.resolve(respond(frame)).then((result) => peer.send({ type: "response", id: frame.id, ok: true, result }));
  });
  const ready = new Promise((resolve) => peer.on("message", (frame) => { if (frame.type === "ready") resolve(); }));
  peer.send({ type: "hello", protocol: 1, sessionId: id, name, conversationId, cwd: "/fixture", model: "faux/faux-1", tailId: 0, live: { busy: false } });
  await ready;
  return { id, peer, requests, close: async () => { peer.destroy(); await peer.closed; } };
}

export async function eventReader(f, id) {
  const abort = new AbortController();
  const response = await f.request(`/api/events${id ? `?session=${id}` : ""}`, { signal: abort.signal });
  if (response.status !== 200) throw new Error("Could not open fixture SSE stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    close: () => { abort.abort(); },
    async next(name) {
      const timeout = setTimeout(() => abort.abort(), 6000);
      try {
        while (true) {
          let separator;
          while ((separator = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, separator); buffer = buffer.slice(separator + 2);
            const type = block.match(/^event: (.+)$/m)?.[1];
            const data = block.match(/^data: (.+)$/m)?.[1];
            if (type === name && data) return JSON.parse(data);
          }
          const next = await reader.read();
          if (next.done) throw new Error("SSE stream ended before the expected event.");
          buffer += decoder.decode(next.value, { stream: true });
        }
      } finally { clearTimeout(timeout); }
    },
  };
}
