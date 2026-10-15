import assert from "node:assert/strict";
import test from "node:test";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { request as rawRequest } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fixture, fakeSession, until, eventReader } from "./helpers.mjs";
import { JsonPeer } from "../src/wire.mjs";
import { startWebServer } from "../src/server.mjs";
import { issueCookie } from "../src/auth.mjs";

test("HTTP requires authentication and same-origin controls, validates hosts and renders a secret-free static shell", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/api/sessions")).status, 401);
    assert.equal((await f.request("/api/login", { method: "POST", value: { token: f.token }, headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await f.request("/api/login", { method: "POST", value: { token: f.token }, headers: { Origin: "" } })).status, 403);
    assert.equal((await f.request("/api/login", { method: "POST", value: { token: "invalid" } })).status, 401);
    const login = await f.login();
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.equal((await f.request("/api/me")).status, 200);
    const rejectedHost = await new Promise((resolve, reject) => {
      const request = rawRequest(`${f.origin}/api/sessions`, { headers: { Host: "evil.example", Cookie: f.cookie() } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.once("error", reject); request.end();
    });
    assert.equal(rejectedHost, 421);
    assert.equal((await f.request("/api/sessions", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    const page = await f.request("/");
    assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const html = await page.text(); assert(!html.includes(f.token)); assert.match(html, /type="module" src="\/app.js"/);
    assert.equal((await f.request("/api/logout", { method: "POST", value: {} })).status, 200);
    assert.equal((await f.request("/not-a-file")).status, 404);
    assert.equal((await lstat(f.server.socketPath)).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test("Tailscale mode needs no browser token, restricts accounts, rejects fallback credentials and keeps SSE authenticated", { timeout: 10000 }, async () => {
  const origin = "https://fixture.test.ts.net:8443";
  const f = await fixture({ origin, token: undefined, authentication: { mode: "tailscale", allowedUsers: ["owner@example.com"] }, heartbeatInterval: 25 });
  const headers = { "Tailscale-User-Login": "owner@example.com", "X-Forwarded-Host": new URL(origin).host, "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.2" };
  let session, events;
  try {
    const denied = await f.request("/api/me");
    assert.equal(denied.status, 403); assert.equal((await denied.json()).code, "TAILSCALE_REQUIRED");
    assert.equal((await f.request("/api/sessions", { headers: { Cookie: issueCookie(f.token, true).split(";")[0] } })).status, 403, "Legacy cookies cannot bypass the Tailscale identity check.");
    assert.equal((await f.request("/api/me", { headers: { ...headers, "Tailscale-User-Login": "other@example.com" } })).status, 403);
    assert.equal((await f.request("/api/me", { headers: { ...headers, "Tailscale-Funnel-Request": "?1" } })).status, 403);
    const me = await f.request("/api/me", { headers });
    assert.equal(me.status, 200); assert.equal(me.headers.get("set-cookie"), null);
    assert.deepEqual(await me.json(), { ok: true, authentication: "tailscale" });
    assert.equal((await f.request("/api/login", { method: "POST", value: { token: f.token }, headers })).status, 404, "Token login must be disabled, not retained as a fallback.");
    assert.equal((await f.request("/api/logout", { method: "POST", value: {}, headers })).status, 405);
    assert.equal((await f.request("/api/sessions", { headers: { ...headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
    session = await fakeSession(f.server, { respond: () => ({ submissionId: 42, status: "placed" }) });
    events = await eventReader({ request: (path, options = {}) => f.request(path, { ...options, headers: { ...headers, ...options.headers } }) }, session.id);
    assert.equal((await events.next("state")).sessionId, session.id);
    await new Promise((resolve) => setTimeout(resolve, 100)); // Multiple fast heartbeats; no cookie-based expiry in Tailscale mode.
    session.peer.send({ type: "state", state: { sessionId: session.id, tailId: 1, live: { busy: false, partial: "Still connected without a cookie" } } });
    assert.equal((await events.next("state")).live.partial, "Still connected without a cookie");
    const input = { content: "From an allowed account", mode: "reject", requestId: randomUUID() };
    assert.equal((await f.request(`/api/sessions/${session.id}/input`, { method: "POST", value: input, headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
    assert.equal((await f.request(`/api/sessions/${session.id}/input`, { method: "POST", value: input, headers: { ...headers, Origin: "" } })).status, 403);
    const accepted = await f.request(`/api/sessions/${session.id}/input`, { method: "POST", value: input, headers });
    assert.equal(accepted.status, 200); assert.equal(session.requests.length, 1);
    assert.deepEqual(session.requests[0].params, input);
  } finally { events?.close(); await session?.close(); await f.cleanup(); }
});

test("two store-local root IDs route by distinct UUIDs, push selected live state, and never queue inputs for an offline session", { timeout: 10000 }, async () => {
  const f = await fixture(); await f.login();
  let first, second, events;
  try {
    first = await fakeSession(f.server, { name: "Alpha", respond: (frame) => frame.method === "input" ? { submissionId: 42, status: "placed" } : { entries: [], hasMore: false } });
    second = await fakeSession(f.server, { name: "Beta", respond: () => ({ submissionId: 84, status: "placed" }) });
    const list = await until(f.list, (items) => items.length === 2);
    assert.notEqual(list[0].id, list[1].id);
    events = await eventReader(f, first.id);
    assert.equal((await events.next("sessions")).length, 2);
    assert.equal((await events.next("state")).sessionId, first.id);
    second.peer.send({ type: "state", state: { sessionId: second.id, name: "Beta", live: { busy: true, partial: "NOT-ALPHA" } } });
    first.peer.send({ type: "state", state: { sessionId: first.id, name: "Alpha", live: { busy: true, partial: "ALPHA-LIVE" } } });
    assert.equal((await events.next("state")).live.partial, "ALPHA-LIVE");
    const input = { content: "Remote input", mode: "steer", requestId: randomUUID() };
    const response = await f.request(`/api/sessions/${first.id}/input`, { method: "POST", value: input });
    assert.deepEqual(await response.json(), { submissionId: 42, status: "placed" });
    assert.equal(first.requests.at(-1).params.content, "Remote input"); assert.equal(second.requests.length, 0);
    assert.equal((await f.request(`/api/sessions/${first.id}/input`, { method: "POST", value: { ...input, mode: "bad" } })).status, 400);
    assert.equal((await f.request(`/api/sessions/${first.id}/history?before=3&after=1`)).status, 400);
    assert.equal((await f.request(`/api/sessions/${first.id}/history?limit=1000`)).status, 400);
    assert.equal((await f.request(`/api/sessions/${first.id}/history?after=${Number.MAX_SAFE_INTEGER}`)).status, 400);
    await first.close();
    assert.equal((await events.next("offline")).sessionId, first.id);
    const rejected = await f.request(`/api/sessions/${first.id}/input`, { method: "POST", value: input });
    assert.equal(rejected.status, 503);
    const rebound = await fakeSession(f.server, { id: first.id, name: "Alpha", respond: () => ({}) });
    assert.equal(rebound.requests.length, 0, "An offline request must not be replayed on reconnect.");
    await rebound.close();
  } finally { events?.close(); await first?.close(); await second?.close(); await f.cleanup(); }
});

test("duplicate session connections cannot steal a binding and a second server cannot replace an active socket", { timeout: 10000 }, async () => {
  const f = await fixture(); await f.login();
  const first = await fakeSession(f.server, { respond: () => ({ original: true }) });
  let duplicate;
  try {
    const socket = createConnection(f.server.socketPath); duplicate = new JsonPeer(socket); await once(socket, "connect");
    duplicate.send({ type: "hello", protocol: 1, sessionId: first.id, name: "Imposter", conversationId: 0 });
    await duplicate.closed;
    const response = await f.request(`/api/sessions/${first.id}/state`);
    assert.deepEqual(await response.json(), { original: true });
    await assert.rejects(startWebServer({ home: f.home, token: f.token, port: 0 }), /already owns/);
    assert.equal((await f.request(`/api/sessions/${first.id}/state`)).status, 200);
  } finally { duplicate?.destroy(); await first.close(); await f.cleanup(); }
});

test("lost or timed-out RPC responses are reported as uncertain rather than retried", { timeout: 10000 }, async () => {
  const f = await fixture({ rpcTimeout: 70 }); await f.login();
  const session = await fakeSession(f.server);
  try {
    const response = await f.request(`/api/sessions/${session.id}/input`, { method: "POST", value: { content: "Once", mode: "followUp", requestId: randomUUID() } });
    assert.equal(response.status, 504);
    assert.match((await response.json()).error, /Delivery may be unknown/);
    assert.equal(session.requests.length, 1);
  } finally { await session.close(); await f.cleanup(); }
});
