import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initialize, socketPath } from "../src/config.mjs";
import { serviceStatus, startService, stopService } from "../src/service.mjs";
import { fakeSession, fixture, until } from "./helpers.mjs";

async function configuration() {
  const home = await mkdtemp("/tmp/pi-d-web-managed-");
  const probe = createNetServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  await initialize(home, { port });
  return { home, port };
}

test("private status identifies the actual service; externally supervised services are never killed", { timeout: 10000 }, async () => {
  const f = await fixture();
  let session;
  try {
    await initialize(f.home, { port: f.server.port, origin: f.origin });
    session = await fakeSession(f.server);
    const status = await serviceStatus(f.home);
    assert.equal(status.running, true); assert.equal(status.managed, false);
    assert.equal(status.pid, process.pid); assert.equal(status.port, f.server.port);
    assert.deepEqual(status.sessionIds, [session.id]);
    assert(!JSON.stringify(status).includes(f.token));
    if (process.platform === "darwin") {
      assert.equal((await startService(f.home)).started, false);
      await assert.rejects(stopService(f.home), /unmanaged process/);
    }
    await f.login(); assert.equal((await f.request("/api/me")).status, 200);
    assert.equal((await f.request("/api/service-status")).status, 404, "Process control must not be exposed through the browser API.");
  } finally { await session?.close(); await f.cleanup(); }
});

test("managed service start/stop is duplicate-safe, survives its caller and recovers an exited job/stale socket", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  const { home, port } = await configuration();
  try {
    assert.equal((await serviceStatus(home)).running, false);
    const [first, second] = await Promise.all([startService(home), startService(home)]);
    assert.equal(first.pid, second.pid); assert.equal(first.instanceId, second.instanceId);
    assert.equal(first.managed, true); assert.equal((await startService(home)).started, false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 401);
    for (const file of ["service.log", "service-error.log"]) assert.equal((await lstat(join(home, file))).mode & 0o777, 0o600);
    process.kill(first.pid, "SIGKILL"); // Only this test's verified, isolated service process.
    await until(async () => { const status = await serviceStatus(home); return !status.running && status.state === "stopped"; });
    const recovered = await startService(home);
    assert.notEqual(recovered.instanceId, first.instanceId); assert.equal(recovered.managed, true);
    const stopped = await stopService(home); assert.equal(stopped.running, false); assert.equal(stopped.loaded, false);
    assert.equal((await stopService(home)).stopped, false);
    await assert.rejects(lstat(socketPath(home)), { code: "ENOENT" });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/me`));
  } finally { await stopService(home); await rm(home, { recursive: true, force: true }); }
});

test("managed startup never stops an unrelated port owner and refuses unsafe log files", { skip: process.platform !== "darwin", timeout: 20000 }, async () => {
  const { home, port } = await configuration();
  const unrelated = createServer((_request, response) => response.end("unrelated"));
  unrelated.listen(port, "127.0.0.1"); await once(unrelated, "listening");
  try {
    await assert.rejects(startService(home), /did not become ready/);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "unrelated");
    await stopService(home);
    await new Promise((resolve) => unrelated.close(resolve));
    await rm(join(home, "service.log"));
    const target = join(home, "do-not-touch"); await writeFile(target, "fixture", { mode: 0o600 });
    await symlink(target, join(home, "service.log"));
    await assert.rejects(startService(home));
    assert.equal((await serviceStatus(home)).loaded, false);
  } finally {
    await stopService(home); unrelated.closeAllConnections();
    if (unrelated.listening) await new Promise((resolve) => unrelated.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("cancelling a status probe closes its private socket and leaves no invocation-owned connection", { timeout: 10000 }, async () => {
  const { home } = await configuration();
  const sockets = new Set();
  const server = createNetServer((socket) => { sockets.add(socket); socket.resume(); socket.on("close", () => sockets.delete(socket)); });
  server.listen(socketPath(home)); await once(server, "listening"); await chmod(socketPath(home), 0o600);
  try {
    const abort = new AbortController();
    const status = serviceStatus(home, { signal: abort.signal });
    await until(() => sockets.size === 1);
    abort.abort(new Error("Fixture cancelled"));
    await assert.rejects(status, /Fixture cancelled/);
    await until(() => sockets.size === 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve)); await rm(home, { recursive: true, force: true });
  }
});
