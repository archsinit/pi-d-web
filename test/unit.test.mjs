import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, chmod, lstat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { defaultHome, initialize, readPrivate, readSettings, readToken, socketPath, validateSettings } from "../src/config.mjs";
import { authorized, equalSecret, issueCookie, tailscaleAuthorized, validateAuthentication } from "../src/auth.mjs";
import { entryText, presentEntry, presentLive } from "../src/transcript.mjs";
import { JsonPeer, MAX_FRAME_BYTES } from "../src/wire.mjs";

const generated = () => randomBytes(32).toString("base64url");

test("private configuration is repeatable, validates origins, and refuses unsafe files", async () => {
  const home = await mkdtemp("/tmp/pi-d-web-config-");
  try {
    await initialize(home, { origin: "https://device.example:8443" });
    const token = await readToken(home);
    assert.equal(token.length, 43);
    assert.equal((await lstat(home)).mode & 0o777, 0o700);
    for (const file of ["config.json", "access-token"]) assert.equal((await lstat(join(home, file))).mode & 0o777, 0o600);
    await initialize(home, { port: 8788 });
    assert.equal(await readToken(home), token, "Reinitialization must preserve the secret.");
    assert.deepEqual(await readSettings(home), { port: 8788, origin: "https://device.example:8443" });
    assert.throws(() => defaultHome({ PI_D_WEB_HOME: "relative" }), /absolute/);
    assert.throws(() => socketPath(`/${"a".repeat(100)}`), /too long/);
    for (const origin of ["http://device.example", "https://user:password@device.example", "https://device.example/path", "https://device.example/?token=bad"]) {
      assert.throws(() => validateSettings({ port: 8787, origin }));
    }
    await symlink(join(home, "access-token"), join(home, "token-link"));
    await assert.rejects(readPrivate(join(home, "token-link")));
    await chmod(join(home, "access-token"), 0o644);
    await assert.rejects(readToken(home), /private/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Tailscale settings require explicit accounts and HTTPS; reinitialization preserves the mode without a token file", async () => {
  const home = await mkdtemp("/tmp/pi-d-web-tailscale-config-");
  const origin = "https://fixture.test.ts.net:8443";
  const authentication = { mode: "tailscale", allowedUsers: ["Owner@Example.com", "owner@example.com"] };
  const expected = { mode: "tailscale", allowedUsers: ["owner@example.com"] };
  try {
    await initialize(home, { origin, authentication });
    await assert.rejects(lstat(join(home, "access-token")), { code: "ENOENT" });
    assert.deepEqual((await readSettings(home)).authentication, expected);
    await initialize(home, { port: 8788 });
    assert.deepEqual(await readSettings(home), { port: 8788, origin, authentication: expected });
    assert.equal((await lstat(join(home, "config.json"))).mode & 0o777, 0o600);
    assert.deepEqual(validateAuthentication(undefined), { mode: "token" });
    for (const authentication of [null, "none", { mode: "none" }, { mode: "tailscale" }, { mode: "tailscale", allowedUsers: [] }, { mode: "tailscale", allowedUsers: [""] }, { mode: "tailscale", allowedUsers: ["invalid\nuser"] }, { mode: "token", allowedUsers: ["owner@example.com"] }]) {
      assert.throws(() => validateSettings({ port: 8787, origin, authentication }));
    }
    for (const origin of ["https://example.com", "http://127.0.0.1:8787"]) assert.throws(() => validateSettings({ port: 8787, origin, authentication }), /HTTPS .ts.net/);
    await initialize(home, { authentication: { mode: "token" } });
    assert.equal((await readToken(home)).length, 43);
    assert.deepEqual((await readSettings(home)).authentication, { mode: "token" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Tailscale authentication accepts only a loopback Serve identity from an allowed account and refuses Funnel", () => {
  const origin = "https://fixture.test.ts.net:8443";
  const authentication = validateAuthentication({ mode: "tailscale", allowedUsers: ["owner@example.com"] }, origin);
  const headers = { "tailscale-user-login": "owner@example.com", "x-forwarded-host": "fixture.test.ts.net:8443", "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.2" };
  const request = (extra = {}, remoteAddress = "127.0.0.1") => ({ headers: { ...headers, ...extra }, socket: { remoteAddress } });
  assert(tailscaleAuthorized(request(), authentication, origin));
  assert(tailscaleAuthorized(request({ "tailscale-user-login": "OWNER@EXAMPLE.COM", "x-forwarded-for": "fd7a:115c:a1e0::1234" }), authentication, origin));
  assert(!tailscaleAuthorized(request({}, "100.64.0.2"), authentication, origin));
  for (const extra of [
    { "tailscale-user-login": undefined }, { "tailscale-user-login": "other@example.com" }, { "tailscale-user-login": "owner@example.com, other@example.com" },
    { "x-forwarded-host": "evil.example" }, { "x-forwarded-host": undefined }, { "x-forwarded-proto": "http" },
    { "x-forwarded-for": "203.0.113.1" }, { "x-forwarded-for": "100.128.0.1" }, { "x-forwarded-for": "100.64.0.2, 127.0.0.1" },
    { "x-forwarded-for": "::1" }, { "x-forwarded-for": undefined }, { "tailscale-funnel-request": "?1" },
  ]) assert(!tailscaleAuthorized(request(extra), authentication, origin));
});

test("cookies are signed, expire, and cannot be used with a rotated secret", () => {
  const secret = generated(), other = generated(), now = 1700000000000;
  const cookie = issueCookie(secret, true, now);
  assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /; Secure$/);
  assert(authorized(cookie, secret, now));
  assert(!authorized(cookie, other, now));
  assert(!authorized(cookie, secret, now + 12 * 60 * 60 * 1000));
  assert(!authorized(cookie.replace(/=\d/, "=9"), secret, now));
  assert(!authorized(undefined, secret, now));
  assert(equalSecret(secret, secret)); assert(!equalSecret(secret, "")); assert(!equalSecret(null, secret));
});

test("history excludes system prompts and image payloads but retains thinking, tools and full text in chunks", () => {
  const entry = { id: 4, kind: "pi.assistant", model: [{ role: "assistant", timestamp: 1, content: [
    { type: "thinking", thinking: "Reasoning", thinkingSignature: "not-for-display" },
    { type: "text", text: "x".repeat(70000) },
    { type: "toolCall", name: "read", arguments: { path: "fixture" } },
    { type: "image", mimeType: "image/png", data: "hidden-image-payload" },
  ] }] };
  const complete = entryText(entry);
  assert.match(complete, /Reasoning/); assert.match(complete, /Tool: read/);
  assert(!complete.includes("not-for-display")); assert(!complete.includes("hidden-image-payload"));
  const preview = presentEntry(entry);
  assert.equal(preview.text.length, 6000);
  let assembled = preview.text, offset = preview.nextOffset;
  while (offset !== null) { const chunk = presentEntry(entry, offset, 48000); assembled += chunk.text; offset = chunk.nextOffset; }
  assert.equal(assembled, complete);
  assert.equal(presentEntry({ id: 5, kind: "pi.system", model: [{ role: "system", content: "private instructions" }] }), null);
  assert.match(presentEntry({ id: 6, kind: "pi.reset" }).text, /Earlier history/);
  const live = presentLive({ run: {}, generation: { message: { content: [{ type: "text", text: "t".repeat(50000) }] } }, tools: [{ name: "bash", output: "o".repeat(20000) }] }, { items: [{ id: 2, mode: "steer", content: "queued" }] });
  assert.equal(live.partial.length, 24000); assert.equal(live.tools[0].output.length, 4000); assert.equal(live.queueCount, 1);
  const escaped = presentLive({
    generation: { message: { content: [{ type: "text", text: "\u0000".repeat(50000) }] } },
    tools: Array.from({ length: 20 }, () => ({ name: "bash", output: "\u0000".repeat(20000) })),
  }, { items: Array.from({ length: 20 }, () => ({ id: 1, mode: "steer", content: "\u0000".repeat(2000) })) });
  assert(Buffer.byteLength(JSON.stringify(escaped)) < MAX_FRAME_BYTES, "Even heavily escaped live text must fit an IPC frame.");
});

test("IPC frames handle fragmentation and reject invalid or oversized input", async () => {
  const socket = new PassThrough(); const peer = new JsonPeer(socket); const frames = [];
  peer.on("message", (value) => frames.push(value));
  socket.write('{"text":"hello'); socket.write(' world"}\n{"n":2}\n');
  assert.deepEqual(frames, [{ text: "hello world" }, { n: 2 }]);
  socket.write("not-json\n"); await peer.closed; assert(socket.destroyed);
  const large = new PassThrough(); const second = new JsonPeer(large);
  large.write("x".repeat(MAX_FRAME_BYTES + 1)); await second.closed; assert(large.destroyed);
});
