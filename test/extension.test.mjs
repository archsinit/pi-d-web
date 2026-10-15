import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { startWebServer } from "../src/server.mjs";
import { fixture, until } from "./helpers.mjs";
import { createServer } from "node:net";
import { once } from "node:events";
import { initialize } from "../src/config.mjs";
import { serviceStatus, stopService } from "../src/service.mjs";
import { bridgeTasks, call, context, fauxAssistantMessage, fauxProvider, openFixtureSession, sdk } from "./sdk.mjs";

async function input(f, id, content, mode = "followUp", requestId = randomUUID()) {
  const response = await f.request(`/api/sessions/${id}/input`, { method: "POST", value: { content, mode, requestId } });
  return { status: response.status, value: await response.json(), requestId };
}
const setup = (name) => [call("web_connect", { name }), fauxAssistantMessage("Bridge enabled.")];

test("real host-loaded extension routes two native sessions, deduplicates retries and reads archived history without another store owner", { timeout: 20000 }, async () => {
  const f = await fixture(); await f.login();
  const previous = process.env.PI_D_WEB_HOME; process.env.PI_D_WEB_HOME = f.home;
  const directoryA = await mkdtemp("/tmp/pi-d-web-session-a-");
  const directoryB = await mkdtemp("/tmp/pi-d-web-session-b-");
  let a, b;
  try {
    a = await openFixtureSession(directoryA, [...setup("Alpha"), fauxAssistantMessage("Reply from Alpha")]);
    b = await openFixtureSession(directoryB, [...setup("Beta"), fauxAssistantMessage("Reply from Beta")]);
    assert.equal((await a.run("Enable web access as Alpha")).status, "done");
    assert.equal((await b.run("Enable web access as Beta")).status, "done");
    const list = await until(f.list, (sessions) => sessions.length === 2 && sessions.every((session) => session.connected));
    const idA = list.find((session) => session.name === "Alpha").id;
    const idB = list.find((session) => session.name === "Beta").id;
    assert.equal(a.conversation.id, b.conversation.id, "Store-local conversation IDs should collide, unlike web IDs.");
    assert.notEqual(idA, idB);
    const sentA = await input(f, idA, "Question for Alpha");
    assert.equal(sentA.status, 200);
    await a.conversation.waitForIdle(context);
    const again = await input(f, idA, "Question for Alpha", "followUp", sentA.requestId);
    assert.equal(again.status, 200); assert.equal(again.value.submissionId, sentA.value.submissionId);
    assert.equal(a.faux.state.callCount, 3, "A duplicate request must not call the model again.");
    const sentB = await input(f, idB, "Question for Beta"); assert.equal(sentB.status, 200);
    await b.conversation.waitForIdle(context);
    const messagesA = (await a.conversation.context(context)).messages;
    const messagesB = (await b.conversation.context(context)).messages;
    assert.equal(messagesA.filter((message) => message.role === "user" && message.content === "Question for Alpha").length, 1);
    assert(!JSON.stringify(messagesA).includes("Question for Beta"));
    assert(!JSON.stringify(messagesB).includes("Question for Alpha"));
    const long = "Archived text. ".repeat(6000);
    await a.conversation.submit({ type: "write", entry: { kind: "fixture.note", data: long } }, context);
    await a.conversation.reset(undefined, context);
    const page = await (await f.request(`/api/sessions/${idA}/history`)).json();
    assert(page.entries.some((entry) => entry.text.includes("Question for Alpha")), "Reset must not hide stored raw history.");
    const note = page.entries.find((entry) => entry.kind === "fixture.note");
    assert(note.nextOffset !== null);
    let complete = note.text, offset = note.nextOffset;
    while (offset !== null) {
      const chunk = await (await f.request(`/api/sessions/${idA}/entry/${note.id}?offset=${offset}`)).json();
      complete += chunk.text; offset = chunk.nextOffset;
    }
    assert.equal(complete, long);
    const earlier = await (await f.request(`/api/sessions/${idA}/history?before=${note.id}&limit=2`)).json();
    assert(earlier.entries.every((entry) => entry.id < note.id));
    const child = await a.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await child.submit({ type: "write", entry: { kind: "fixture.private", data: "A different conversation" } }, context);
    const childEntry = (await child.entries({}, 1, undefined, context)).items[0];
    const forbidden = await f.request(`/api/sessions/${idA}/entry/${childEntry.id}`);
    assert.equal(forbidden.status, 502, "Entry reads must remain scoped to the linked conversation.");
    await a.conversation.commit(async (tx) => {
      for (let i = 0; i < 40; i++) await tx.appendEntry(a.conversation.id, { kind: "fixture.control-text", data: "\u0000".repeat(6000) });
    }, context);
    const collected = new Set();
    let before;
    for (let i = 0; i < 10; i++) {
      const response = await f.request(`/api/sessions/${idA}/history?limit=80${before ? `&before=${before}` : ""}`);
      assert.equal(response.status, 200, "Long escaped pages must fit the IPC frame budget.");
      const text = await response.text(); assert(Buffer.byteLength(text) < 650 * 1024);
      const page = JSON.parse(text);
      for (const entry of page.entries) if (entry.kind === "fixture.control-text") collected.add(entry.id);
      if (!page.hasMore) break;
      before = page.oldestId;
    }
    assert.equal(collected.size, 40, "Byte-limited pagination must neither skip nor repeat entries.");
    assert.equal((await bridgeTasks(a.harness)).length, 1);
    assert.deepEqual((await readdir(f.home)).sort(), ["access-token", "bridge.sock", "config.json"], "Service must not create transcript files or open session DBs.");
  } finally {
    await a?.harness.close(context); await b?.harness.close(context); await f.cleanup();
    if (previous === undefined) delete process.env.PI_D_WEB_HOME; else process.env.PI_D_WEB_HOME = previous;
    await rm(directoryA, { recursive: true, force: true }); await rm(directoryB, { recursive: true, force: true });
  }
});

test("native background bridge survives foreground interrupt, withdraws queued input, recovers with the same UUID, and explicitly disconnects", { timeout: 20000 }, async () => {
  const f = await fixture(); await f.login();
  const previous = process.env.PI_D_WEB_HOME; process.env.PI_D_WEB_HOME = f.home;
  const directory = await mkdtemp("/tmp/pi-d-web-recovery-");
  const faux = fauxProvider({ tokensPerSecond: 250, tokenSize: { min: 1, max: 1 } });
  let session, replacement;
  try {
    session = await openFixtureSession(directory, [...setup("Recoverable"), fauxAssistantMessage("Slow output. ".repeat(400))], { faux });
    assert.equal((await session.run("Enable web access")).status, "done");
    const list = await until(f.list, (sessions) => sessions.length === 1 && sessions[0].connected);
    const id = list[0].id;
    const originalTask = (await bridgeTasks(session.harness))[0].record.id;
    assert.equal((await input(f, id, "Long request")).status, 200);
    await until(() => session.harness.snapshot(sdk.LiveDoc, session.conversation.id, context), (live) => live?.run && live.generation?.message);
    assert.equal((await input(f, id, "Must be rejected", "reject")).status, 409);
    assert.equal((await input(f, id, "Steer request", "steer")).status, 200);
    assert.equal((await input(f, id, "Follow-up request", "followUp")).status, 200);
    const inbox = await session.harness.snapshot(sdk.InboxDoc, session.conversation.id, context);
    assert.deepEqual(inbox.items.map((item) => item.mode), ["steer", "followUp"]);
    const stopped = await f.request(`/api/sessions/${id}/interrupt`, { method: "POST", value: {} });
    assert.equal(stopped.status, 200);
    await session.conversation.waitForIdle(context);
    assert.equal((await session.harness.snapshot(sdk.InboxDoc, session.conversation.id, context)).items.length, 0);
    assert.equal((await bridgeTasks(session.harness))[0].record.id, originalTask);
    assert((await f.list())[0].connected, "Foreground interruption must not stop the background bridge.");
    const file = session.file;
    await session.harness.close(context); session = undefined;
    await until(f.list, (sessions) => !sessions[0].connected);
    session = await openFixtureSession(directory, [], { file, faux });
    session.harness.resume();
    await until(f.list, (sessions) => sessions[0].id === id && sessions[0].connected);
    assert.equal((await bridgeTasks(session.harness))[0].record.id, originalTask);
    faux.appendResponses([call("web_connect", { name: "Recoverable" }), fauxAssistantMessage("Still connected.")]);
    assert.equal((await session.run("Enable web access again")).status, "done");
    assert.equal((await bridgeTasks(session.harness)).length, 1, "Repeated connection must not create another task.");
    await f.server.close();
    replacement = await startWebServer({ home: f.home, token: f.token, port: f.server.port });
    await until(f.list, (sessions) => sessions.length === 1 && sessions[0].id === id && sessions[0].connected);
    assert.equal((await bridgeTasks(session.harness))[0].record.id, originalTask, "A service restart must reuse the native bridge.");
    faux.appendResponses([call("web_disconnect"), fauxAssistantMessage("Disconnected.")]);
    assert.equal((await session.run("Disable web access")).status, "done");
    await until(f.list, (sessions) => !sessions[0].connected);
    assert.equal((await bridgeTasks(session.harness)).length, 0);
    assert.equal((await session.harness.inspect(context)).tasks.length, 0);
    assert.equal((await f.request(`/api/sessions/${id}/state`)).status, 503);
  } finally {
    await session?.harness.close(context); await replacement?.close(); await f.cleanup();
    if (previous === undefined) delete process.env.PI_D_WEB_HOME; else process.env.PI_D_WEB_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("native web_start/status/stop manage the shared service, reuse a bridge and retain its URL across restarts", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  const home = await mkdtemp("/tmp/pi-d-web-native-managed-");
  const directory = await mkdtemp("/tmp/pi-d-web-native-controls-");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  await initialize(home, { port, origin: "https://fixture.test.ts.net:8443", authentication: { mode: "tailscale", allowedUsers: ["owner@example.com"] } });
  const previous = process.env.PI_D_WEB_HOME; process.env.PI_D_WEB_HOME = home;
  let session;
  try {
    session = await openFixtureSession(directory, [call("web_status"), call("web_start", { name: "Managed" }), fauxAssistantMessage("Web access started.")]);
    assert.equal((await session.run("Start web access" )).status, "done");
    const first = await until(() => serviceStatus(home), (status) => status.managed && status.sessionIds.length === 1);
    const id = first.sessionIds[0];
    assert.equal((await bridgeTasks(session.harness)).length, 1);
    session.faux.appendResponses([call("web_start"), call("web_status"), fauxAssistantMessage("Already running.")]);
    assert.equal((await session.run("Start web access again and check status")).status, "done");
    assert.equal((await serviceStatus(home)).instanceId, first.instanceId);
    assert.equal((await bridgeTasks(session.harness)).length, 1);
    session.faux.appendResponses([call("web_stop", { allSessions: true }), fauxAssistantMessage("Shared server stopped.")]);
    assert.equal((await session.run("Stop the shared web service for all sessions")).status, "done");
    assert.equal((await serviceStatus(home)).running, false);
    assert.equal((await bridgeTasks(session.harness)).length, 0);
    assert.equal((await session.harness.inspect(context)).tasks.length, 0);
    session.faux.appendResponses([call("web_start"), fauxAssistantMessage("Web access restarted.")]);
    assert.equal((await session.run("Start web access again")).status, "done");
    const next = await until(() => serviceStatus(home), (status) => status.managed && status.sessionIds.length === 1);
    assert.deepEqual(next.sessionIds, [id]); assert.notEqual(next.instanceId, first.instanceId);
    const results = (await session.conversation.context(context)).messages.filter((message) => message.role === "toolResult");
    assert(results.every((message) => !message.isError), "Every start/status/stop tool must succeed, not merely be followed by a faux final answer.");
    const initialStatus = results.find((message) => message.toolName === "web_status");
    const reported = JSON.parse(initialStatus.content.find((block) => block.type === "text").text);
    assert.equal(reported.service.running, false); assert.equal(reported.conversation.enabled, false);
    await session.harness.close(context); session = undefined;
    assert.equal((await serviceStatus(home)).running, true, "The shared OS-managed service must not belong to one pi-d process.");
  } finally {
    await session?.harness.close(context); await stopService(home);
    if (previous === undefined) delete process.env.PI_D_WEB_HOME; else process.env.PI_D_WEB_HOME = previous;
    await rm(home, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true });
  }
});
