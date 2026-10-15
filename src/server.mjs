import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, createConnection } from "node:net";
import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { privateDirectory, socketPath } from "./config.mjs";
import { authorized, clearCookie, equalSecret, issueCookie, tailscaleAuthorized, validateAuthentication } from "./auth.mjs";
import { JsonPeer, isId } from "./wire.mjs";

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function json(response, status, value, headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(value));
}

function body(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "Use application/json.");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    request.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > 400 * 1024) { failed = true; chunks.length = 0; reject(new HttpError(413, "Request body is too large.")); }
      else chunks.push(chunk);
    });
    request.once("end", () => {
      if (failed) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(new HttpError(400, "Invalid JSON object.")); }
    });
    request.once("error", reject);
    request.once("aborted", () => reject(new HttpError(400, "Request aborted.")));
  });
}

function integer(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new HttpError(400, "Invalid numeric parameter.");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new HttpError(400, "Numeric parameter is out of range.");
  return number;
}

async function prepareSocket(path) {
  let original;
  try { original = await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!original.isSocket() || original.uid !== process.getuid()) throw new Error("Refusing to replace an unexpected bridge socket path.");
  const active = await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error) => { socket.destroy(); if (error.code === "ECONNREFUSED") resolve(false); else reject(error); });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Cannot determine whether the existing bridge socket is active.")); });
  });
  if (active) throw new Error("A pi-d-web service already owns this bridge socket.");
  const current = await lstat(path);
  if (current.ino !== original.ino) throw new Error("Bridge socket changed during startup; try again.");
  await unlink(path); // Only a confirmed refused, account-owned stale socket.
}

export async function startWebServer({ home, token, port = 8787, origin, authentication, rpcTimeout = 15000, heartbeatInterval = 25000 }) {
  await privateDirectory(home);
  const auth = validateAuthentication(authentication, origin);
  if (auth.mode === "token" && (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))) throw new Error("A generated access token is required.");
  const assets = new Map(await Promise.all([
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
  ].map(async ([route, file, type]) => [route, { type, bytes: await readFile(new URL(`../web/${file}`, import.meta.url)) }])));
  const sessions = new Map();
  const instanceId = randomUUID();
  const peers = new Set();
  const viewers = new Set();
  let badLogins = [];
  let publicOrigin;
  let actualPort;
  let closing;
  const path = socketPath(home);

  const sessionList = () => [...sessions.values()].map((session) => ({
    id: session.id, name: session.name, cwd: session.cwd, model: session.model,
    connected: Boolean(session.peer), busy: Boolean(session.peer && session.state?.live?.busy),
  })).sort((a, b) => a.name.localeCompare(b.name));

  function event(viewer, name, value) {
    if (viewer.response.destroyed) return;
    if (viewer.response.writableLength > 256 * 1024) { viewer.response.destroy(); return; }
    viewer.response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  const publishSessions = () => { const list = sessionList(); for (const viewer of viewers) event(viewer, "sessions", list); };
  const publishState = (session) => { for (const viewer of viewers) if (viewer.id === session.id) event(viewer, "state", session.state); };

  function rpc(id, method, params) {
    const session = sessions.get(id);
    if (!session) throw new HttpError(404, "Session is not connected to this service.");
    if (!session.peer) throw new HttpError(503, "Session is offline. Keep its pi-d process running.");
    if (session.pending.size >= 32) throw new HttpError(429, "Too many pending requests for this session.");
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        reject(new HttpError(504, "Session response timed out. Delivery may be unknown; retry messages with the same request ID."));
      }, rpcTimeout);
      timer.unref();
      session.pending.set(requestId, { resolve, reject, timer });
      if (!session.peer.send({ type: "request", id: requestId, method, params })) {
        clearTimeout(timer); session.pending.delete(requestId);
        reject(new HttpError(503, "Session connection was lost. Message delivery may be unknown."));
      }
    });
  }

  const bridge = createNetServer((socket) => {
    const peer = new JsonPeer(socket);
    peers.add(peer);
    let session;
    const handshake = setTimeout(() => peer.destroy(), 3000);
    handshake.unref();
    peer.on("message", (frame) => {
      if (!session) {
        if (frame.type === "service-status" && frame.protocol === 1) {
          clearTimeout(handshake);
          peer.send({ type: "service-status", protocol: 1, service: "pi-d-web", instanceId, pid: process.pid, port: actualPort, origin: publicOrigin,
            sessionIds: [...sessions.values()].filter((item) => item.peer).map((item) => item.id) });
          socket.end(() => peer.destroy()); return;
        }
        if (frame.type !== "hello" || frame.protocol !== 1 || !isId(frame.sessionId)
          || typeof frame.name !== "string" || !frame.name.trim() || frame.name.length > 80
          || !Number.isSafeInteger(frame.conversationId) || frame.conversationId < 0) { peer.destroy(); return; }
        const previous = sessions.get(frame.sessionId);
        if (previous?.peer) { peer.destroy(); return; } // Never steal an existing binding.
        if (sessions.size >= 64 && !previous) {
          const offline = [...sessions.values()].find((item) => !item.peer);
          if (!offline) { peer.destroy(); return; }
          sessions.delete(offline.id);
        }
        clearTimeout(handshake);
        session = {
          id: frame.sessionId, name: frame.name, cwd: String(frame.cwd ?? "").slice(0, 4096), model: String(frame.model ?? "").slice(0, 256),
          peer, state: frame, pending: new Map(),
        };
        sessions.set(session.id, session);
        peer.send({ type: "ready" });
        publishSessions(); publishState(session);
        return;
      }
      if (frame.type === "state" && frame.state?.sessionId === session.id) {
        const state = frame.state;
        const oldBadge = `${session.name}\n${session.model}\n${session.cwd}\n${Boolean(session.state?.live?.busy)}`;
        session.state = state;
        session.name = String(state.name ?? session.name).slice(0, 80);
        session.cwd = String(state.cwd ?? session.cwd).slice(0, 4096);
        session.model = String(state.model ?? session.model).slice(0, 256);
        const badge = `${session.name}\n${session.model}\n${session.cwd}\n${Boolean(state.live?.busy)}`;
        if (badge !== oldBadge) publishSessions();
        publishState(session);
      } else if (frame.type === "response" && isId(frame.id)) {
        const pending = session.pending.get(frame.id);
        if (!pending) return;
        session.pending.delete(frame.id); clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new HttpError(frame.code === "BUSY" ? 409 : 502, String(frame.message ?? "Session request failed.").slice(0, 500)));
      }
    });
    peer.once("close", () => {
      clearTimeout(handshake); peers.delete(peer);
      if (!session || session.peer !== peer) return;
      session.peer = null;
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new HttpError(503, "Session disconnected. Message delivery may be unknown; retry with the same request ID."));
      }
      session.pending.clear();
      publishSessions();
      for (const viewer of viewers) if (viewer.id === session.id) event(viewer, "offline", { sessionId: session.id });
    });
  });
  bridge.maxConnections = 128;

  const http = createHttpServer((request, response) => {
    void (async () => {
      const host = request.headers.host?.toLowerCase();
      const allowedHosts = new Set([new URL(publicOrigin).host.toLowerCase(), `127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      if (!allowedHosts.has(host)) throw new HttpError(421, "Unrecognized host.");
      if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new HttpError(400, "Invalid request URL.");
      const url = new URL(request.url, publicOrigin);
      const allowedOrigins = new Set([publicOrigin, `http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);
      if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) throw new HttpError(403, "Origin is not allowed.");
      if (request.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Cross-site access is not allowed.");
      if (!["GET", "POST"].includes(request.method)) throw new HttpError(405, "Method is not allowed.");
      if (request.method === "POST" && !allowedOrigins.has(request.headers.origin)) throw new HttpError(403, "A same-origin request is required.");
      const secure = new URL(publicOrigin).protocol === "https:";
      if (auth.mode === "token" && request.method === "POST" && url.pathname === "/api/login") {
        const value = await body(request);
        badLogins = badLogins.filter((at) => at > Date.now() - 60000);
        if (badLogins.length >= 10) throw new HttpError(429, "Too many login attempts; wait one minute.");
        if (!equalSecret(value.token, token)) { badLogins.push(Date.now()); throw new HttpError(401, "Access token was not accepted."); }
        badLogins = [];
        json(response, 200, { ok: true }, { "Set-Cookie": issueCookie(token, secure) }); return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (auth.mode === "tailscale") {
          if (!tailscaleAuthorized(request, auth, publicOrigin)) throw new HttpError(403, "Open the private Tailscale HTTPS address from an allowed Tailscale account.", "TAILSCALE_REQUIRED");
        } else if (!authorized(request.headers.cookie, token)) throw new HttpError(401, "Sign in to access sessions.");
        if (request.method === "GET" && url.pathname === "/api/me") { json(response, 200, { ok: true, authentication: auth.mode }); return; }
        if (request.method === "POST" && url.pathname === "/api/logout") {
          if (auth.mode === "tailscale") throw new HttpError(405, "Tailscale manages your sign-in; there is no separate browser login.");
          await body(request); json(response, 200, { ok: true }, { "Set-Cookie": clearCookie(secure) }); return;
        }
        if (request.method === "GET" && url.pathname === "/api/sessions") { json(response, 200, sessionList()); return; }
        if (request.method === "GET" && url.pathname === "/api/events") {
          const id = url.searchParams.get("session");
          if (id !== null && !isId(id)) throw new HttpError(400, "Invalid session ID.");
          if (viewers.size >= 64) throw new HttpError(429, "Too many open browser connections.");
          response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
          response.write("retry: 3000\n\n");
          const viewer = { id, response, cookie: request.headers.cookie };
          viewers.add(viewer);
          response.once("close", () => viewers.delete(viewer));
          event(viewer, "sessions", sessionList());
          if (id && sessions.get(id)?.peer) event(viewer, "state", sessions.get(id).state);
          else if (id) event(viewer, "offline", { sessionId: id });
          return;
        }
        const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/(history|state|input|interrupt|entry\/\d+)$/i);
        if (!match || !isId(match[1])) throw new HttpError(404, "Endpoint not found.");
        const [, id, action] = match;
        let method = action;
        let params = {};
        if (request.method === "GET") {
          if (action === "history") {
            params = { limit: integer(url.searchParams.get("limit"), 30, 1, 80) };
            for (const key of ["before", "after"]) if (url.searchParams.has(key)) params[key] = integer(url.searchParams.get(key), undefined, 1, Number.MAX_SAFE_INTEGER - 1);
            if (params.before !== undefined && params.after !== undefined) throw new HttpError(400, "Use before or after, not both.");
          } else if (action.startsWith("entry/")) {
            method = "entry"; params = { id: integer(action.slice(6)), offset: integer(url.searchParams.get("offset"), 0, 0) };
          } else if (action !== "state") throw new HttpError(405, "Use POST for controls.");
        } else {
          params = await body(request);
          if (action === "input") {
            if (typeof params.content !== "string" || !params.content.trim() || Buffer.byteLength(params.content) > 65536 || !isId(params.requestId) || !["steer", "followUp", "reject"].includes(params.mode)) throw new HttpError(400, "Input requires text, a UUID requestId and a valid mode.");
            params = { content: params.content, requestId: params.requestId, mode: params.mode };
          } else if (action === "interrupt") params = {};
          else throw new HttpError(405, "Use GET for history and state.");
        }
        json(response, 200, await rpc(id, method, params)); return;
      }
      if (request.method !== "GET") throw new HttpError(405, "Use GET for this page.");
      const asset = assets.get(url.pathname) ?? (/^\/s\/[0-9a-f-]{36}$/i.test(url.pathname) ? assets.get("/") : null);
      if (!asset) throw new HttpError(404, "Page not found.");
      response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": asset.type }); response.end(asset.bytes);
    })().catch((error) => {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      json(response, error.status ?? 500, { error: error.status ? error.message : "The service could not complete this request.", ...(error.code === "TAILSCALE_REQUIRED" ? { code: error.code } : {}) });
    });
  });
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  http.maxConnections = 128;

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(heartbeat);
      for (const viewer of viewers) viewer.response.end();
      for (const peer of peers) peer.destroy();
      await Promise.all([
        new Promise((resolve) => { http.close(resolve); http.closeAllConnections(); }),
        new Promise((resolve) => bridge.close(resolve)),
      ]);
    })();
    return closing;
  }
  let heartbeat;
  try {
    http.listen(port, "127.0.0.1"); await once(http, "listening");
    actualPort = http.address().port;
    publicOrigin = origin ?? `http://127.0.0.1:${actualPort}`;
    // Validate before exposing a socket to session extensions.
    if (new URL(publicOrigin).origin !== publicOrigin) throw new Error("Expected a bare public origin.");
    await prepareSocket(path);
    bridge.listen(path); await once(bridge, "listening");
    await chmod(path, 0o600);
    heartbeat = setInterval(() => {
      for (const viewer of viewers) {
        if (auth.mode === "token" && !authorized(viewer.cookie, token)) { event(viewer, "auth_required", {}); viewer.response.end(); }
        else if (viewer.response.writableLength > 256 * 1024) viewer.response.destroy();
        else viewer.response.write(": keepalive\n\n");
      }
    }, heartbeatInterval);
    heartbeat.unref();
  } catch (error) { await close(); throw error; }
  return { origin: publicOrigin, port: actualPort, socketPath: path, close };
}
