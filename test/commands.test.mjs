import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { initialize, socketPath } from "../src/config.mjs";
import { serviceStatus, stopService } from "../src/service.mjs";
import { fixture, until } from "./helpers.mjs";
import { bridgeTasks, call, context, executeExtensionCommand, extensionCommands, fauxAssistantMessage, fauxProvider, openFixtureSession, sdk } from "./sdk.mjs";

function useHome(home) {
  const previous = process.env.PI_D_WEB_HOME;
  process.env.PI_D_WEB_HOME = home;
  return () => {
    if (previous === undefined) delete process.env.PI_D_WEB_HOME;
    else process.env.PI_D_WEB_HOME = previous;
  };
}

async function command(session, argument, signal = new AbortController().signal) {
  let notice;
  assert.equal(await executeExtensionCommand(session, "web", argument, { setNotice: (value) => { notice = value; } }, signal), true);
  return notice;
}

async function unusedPort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("slash help works before configuration and invalid commands have no effects", async () => {
  const home = await mkdtemp("/tmp/pi-d-web-command-config-");
  const directory = await mkdtemp("/tmp/pi-d-web-command-help-");
  const restore = useHome(home);
  let session;
  try {
    session = await openFixtureSession(directory);
    assert.match(await command(session, ""), /Usage: \/web start/);
    assert.match(await command(session, "help"), /stop --all/);
    for (const argument of ["unknown", "help extra", "status extra", "disconnect --all"]) {
      await assert.rejects(command(session, argument), /Usage: \/web/);
    }
    for (const argument of ["stop", "stop extra", "stop --all extra", "stop --all --all"]) {
      await assert.rejects(command(session, argument), /Stopping affects ALL sessions/);
    }
    for (const action of ["start", "connect"]) {
      await assert.rejects(command(session, `${action} ${"n".repeat(81)}`), /at most 80/);
    }
    await assert.rejects(command(session, "status"), { code: "ENOENT" });
    assert.deepEqual(await readdir(home), [], "Help and invalid commands must not initialize private configuration.");
    assert.equal((await session.harness.inspect(context)).scheduling, "paused");
    assert.equal((await session.harness.inspect(context)).tasks.length, 0);
    assert.equal((await session.conversation.context(context)).entries.length, 0);
    assert.equal(session.faux.state.callCount, 0);
  } finally {
    await session?.harness.close(context); restore();
    await rm(home, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true });
  }
});

test("host registration, completion and status are selected-only, model-free and preserve paused scheduling", async () => {
  const f = await fixture();
  const directory = await mkdtemp("/tmp/pi-d-web-command-status-");
  const restore = useHome(f.home);
  let session;
  try {
    session = await openFixtureSession(directory);
    const signal = new AbortController().signal;
    const commands = await extensionCommands(session, signal);
    const web = commands.find((item) => item.name === "web");
    assert(web); assert.match(web.argumentHint, /stop --all/);
    assert.deepEqual((await web.getArgumentCompletions("st")).map((item) => item.value), ["start", "status", "stop --all"]);
    assert.deepEqual((await web.getArgumentCompletions("stop ")).map((item) => item.value), ["stop --all"]);
    assert.deepEqual(await web.getArgumentCompletions("connect My project"), []);
    assert.match(await command(session, "status"), /running \(external\).*disabled/);
    for (const action of ["start", "connect", "disconnect", "stop --all"]) {
      await assert.rejects(command(session, action), /Session scheduling is paused/);
    }
    assert.equal((await session.harness.inspect(context)).scheduling, "paused", "Local controls must not bypass the host's auth/recovery gate.");
    assert.equal((await session.harness.inspect(context)).tasks.length, 0);
    assert.equal((await session.conversation.context(context)).entries.length, 0);
    assert.equal(session.faux.state.callCount, 0);
    assert.deepEqual((await serviceStatus(f.home)).sessionIds, []);
    await session.conversation.configure({ extensions: [] }, context);
    assert(!(await extensionCommands(session, signal)).some((item) => item.name === "web"));
    assert.equal(await executeExtensionCommand(session, "web", "status", { setNotice: () => assert.fail("Deselected command ran") }, signal), false);
  } finally {
    await session?.harness.close(context); await f.cleanup(); restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("slash bridges recover, share native tasks with model tools and disconnect during foreground work without interrupting it", { timeout: 20000 }, async () => {
  const f = await fixture(); await f.login();
  await initialize(f.home, { port: f.server.port, origin: f.origin });
  const directory = await mkdtemp("/tmp/pi-d-web-command-bridge-");
  const restore = useHome(f.home);
  const faux = fauxProvider({ tokensPerSecond: 250, tokenSize: { min: 1, max: 1 } });
  let session;
  try {
    session = await openFixtureSession(directory, [], { faux });
    session.harness.resume(); // Simulate the host having completed its normal readiness check.
    const notice = await command(session, "connect My project");
    const list = await until(f.list, (items) => items.length === 1 && items[0].connected);
    const id = list[0].id, url = `${f.origin}/s/${id}`;
    assert.equal(list[0].name, "My project"); assert(notice.includes(url));
    const originalTask = (await bridgeTasks(session.harness))[0].record;
    assert.equal(originalTask.background, true);
    await command(session, "connect My project");
    assert.deepEqual((await bridgeTasks(session.harness)).map((item) => item.record.id), [originalTask.id]);
    assert.equal(faux.state.callCount, 0); assert.equal((await session.conversation.context(context)).entries.length, 0);

    await assert.rejects(command(session, "stop"), /Stopping affects ALL sessions/);
    await assert.rejects(command(session, "stop --all"), /another supervisor/);
    assert((await f.list())[0].connected, "Refusing an external service stop must not disconnect the conversation.");
    const cancelled = new AbortController(); cancelled.abort(new Error("Fixture cancelled"));
    await assert.rejects(command(session, "disconnect", cancelled.signal), /Fixture cancelled/);
    assert.equal((await bridgeTasks(session.harness)).length, 1);

    const file = session.file;
    await session.harness.close(context); session = undefined;
    await until(f.list, (items) => !items[0].connected);
    session = await openFixtureSession(directory, [], { file, faux });
    assert.match(await command(session, "status"), /enabled, offline/);
    assert.equal((await session.harness.inspect(context)).scheduling, "paused");
    session.harness.resume();
    await until(f.list, (items) => items[0].id === id && items[0].connected);
    assert.equal((await bridgeTasks(session.harness))[0].record.id, originalTask.id);

    faux.appendResponses([call("web_connect", { name: "My project" }), fauxAssistantMessage("Still connected.")]);
    assert.equal((await session.run("Connect again with the model tool")).status, "done");
    assert.equal((await bridgeTasks(session.harness))[0].record.id, originalTask.id);
    assert.equal((await bridgeTasks(session.harness)).length, 1);
    const results = (await session.conversation.context(context)).messages.filter((message) => message.role === "toolResult");
    assert(results.some((message) => message.toolName === "web_connect" && !message.isError));

    faux.appendResponses([fauxAssistantMessage("Long foreground output. ".repeat(300))]);
    await session.conversation.submit({ type: "input", content: "Keep working while local controls run" }, context);
    await until(() => session.harness.snapshot(sdk.LiveDoc, session.conversation.id, context), (live) => live?.run && live.generation?.message);
    const calls = faux.state.callCount;
    assert.match(await command(session, "status"), /This conversation: connected/);
    assert.match(await command(session, "disconnect"), /disconnected/);
    await until(f.list, (items) => !items[0].connected);
    assert.equal((await bridgeTasks(session.harness)).length, 0);
    assert((await session.harness.snapshot(sdk.LiveDoc, session.conversation.id, context)).run, "Disconnect must leave foreground model work running.");
    assert((await command(session, "connect")).includes(url), "Reconnecting must retain the stable URL.");
    await until(f.list, (items) => items[0].id === id && items[0].connected);
    assert.equal(faux.state.callCount, calls, "Local controls must not make another model request.");
    await session.conversation.abort(context);
    assert.equal((await bridgeTasks(session.harness)).length, 1, "Foreground interruption must not stop a command-created bridge.");
    await command(session, "disconnect");
    assert.equal((await session.harness.inspect(context)).tasks.length, 0);
  } finally {
    await session?.harness.close(context); await f.cleanup(); restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("slash status cancellation closes its invocation-owned IPC socket and never resumes or notifies late", { timeout: 10000 }, async () => {
  const home = await mkdtemp("/tmp/pi-d-web-command-cancel-");
  const directory = await mkdtemp("/tmp/pi-d-web-command-context-");
  await initialize(home);
  const restore = useHome(home), sockets = new Set();
  const server = createServer((socket) => { sockets.add(socket); socket.resume(); socket.on("close", () => sockets.delete(socket)); });
  let session;
  try {
    server.listen(socketPath(home)); await once(server, "listening"); await chmod(socketPath(home), 0o600);
    session = await openFixtureSession(directory);
    const abort = new AbortController();
    const pending = executeExtensionCommand(session, "web", "status", { setNotice: () => assert.fail("Cancelled status notified late") }, abort.signal);
    await until(() => sockets.size === 1);
    abort.abort(new Error("Fixture cancelled"));
    await assert.rejects(pending, /Fixture cancelled/);
    await until(() => sockets.size === 0);
    assert.equal((await session.harness.inspect(context)).scheduling, "paused");
    assert.equal((await session.harness.inspect(context)).tasks.length, 0);
    assert.equal((await session.conversation.context(context)).entries.length, 0);
    assert.equal(session.faux.state.callCount, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await session?.harness.close(context); restore();
    await rm(home, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true });
  }
});

test("managed slash start/stop are model-free, idempotent and explicitly scoped across two sessions", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  const home = await mkdtemp("/tmp/pi-d-web-command-managed-");
  const directoryA = await mkdtemp("/tmp/pi-d-web-command-owner-");
  const directoryB = await mkdtemp("/tmp/pi-d-web-command-other-");
  await initialize(home, { port: await unusedPort(), origin: "https://fixture.test.ts.net:8443", authentication: { mode: "tailscale", allowedUsers: ["owner@example.com"] } });
  const restore = useHome(home);
  let a, b;
  try {
    a = await openFixtureSession(directoryA); b = await openFixtureSession(directoryB);
    a.harness.resume(); b.harness.resume();
    assert.match(await command(a, "status"), /stopped.*disabled/);
    const notice = await command(a, "start Managed project");
    const first = await until(() => serviceStatus(home), (status) => status.managed && status.sessionIds.length === 1);
    const idA = first.sessionIds[0]; assert(notice.includes(`/s/${idA}`));
    await command(a, "start");
    assert.equal((await serviceStatus(home)).instanceId, first.instanceId);
    assert.equal((await bridgeTasks(a.harness)).length, 1);
    await command(b, "start Other project");
    const both = await until(() => serviceStatus(home), (status) => status.sessionIds.length === 2);
    assert.equal(both.instanceId, first.instanceId);
    const idB = both.sessionIds.find((id) => id !== idA), taskB = (await bridgeTasks(b.harness))[0].record.id;
    await assert.rejects(command(a, "stop"), /Stopping affects ALL sessions/);
    assert.equal((await serviceStatus(home)).sessionIds.length, 2);
    await command(a, "disconnect");
    const other = await until(() => serviceStatus(home), (status) => status.sessionIds.length === 1);
    assert.deepEqual(other.sessionIds, [idB]); assert.equal(other.instanceId, first.instanceId);
    assert.equal((await bridgeTasks(a.harness)).length, 0); assert.equal((await bridgeTasks(b.harness)).length, 1);
    assert((await command(a, "start")).includes(`/s/${idA}`));
    await until(() => serviceStatus(home), (status) => status.sessionIds.length === 2);
    assert.match(await command(a, "stop --all"), /stopped for ALL sessions/);
    assert.equal((await serviceStatus(home)).running, false);
    assert.equal((await bridgeTasks(a.harness)).length, 0); assert.equal((await bridgeTasks(b.harness)).length, 1);
    assert.match(await command(a, "status"), /stopped.*disabled/);
    await command(a, "start");
    const restarted = await until(() => serviceStatus(home), (status) => status.managed && status.sessionIds.length === 2);
    assert.notEqual(restarted.instanceId, first.instanceId);
    assert.deepEqual(new Set(restarted.sessionIds), new Set([idA, idB]));
    assert.equal((await bridgeTasks(b.harness))[0].record.id, taskB);
    for (const session of [a, b]) {
      assert.equal(session.faux.state.callCount, 0);
      assert.equal((await session.conversation.context(context)).entries.length, 0);
    }
    await a.harness.close(context); a = undefined;
    assert.equal((await serviceStatus(home)).running, true, "The shared service must outlive a command's owning session.");
  } finally {
    await a?.harness.close(context); await b?.harness.close(context); await stopService(home); restore();
    await rm(home, { recursive: true, force: true });
    await rm(directoryA, { recursive: true, force: true }); await rm(directoryB, { recursive: true, force: true });
  }
});
