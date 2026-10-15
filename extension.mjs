import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { once } from "node:events";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, InboxDoc, LiveDoc, defineDoc, defineTask, defineTool, section } from "@earendil-works/pi-durable";
import { defineChatExtension } from "pi-d-chat/extensions";
import { defaultHome, readSettings, socketPath } from "./src/config.mjs";
import { JsonPeer, isId } from "./src/wire.mjs";
import { presentEntry, presentLive } from "./src/transcript.mjs";
import { serviceStatus, startService, stopService } from "./src/service.mjs";

// IDs in Durable are store-local numbers (the root ID is shared by stores).
// This extension-owned UUID provides a stable, globally unambiguous web URL.
export const WebLink = defineDoc({
  kind: "pi-d-web.link", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ id: "", name: "", enabled: false, taskId: 0 }),
});

async function history(runtime, params, context) {
  const { before, after } = params;
  const limit = params.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 80 || (before !== undefined && after !== undefined)) throw new Error("Invalid history query");
  for (const id of [before, after]) if (id !== undefined && (!Number.isSafeInteger(id) || id < 1 || id >= Number.MAX_SAFE_INTEGER)) throw new Error("Invalid entry ID");
  let page;
  await runtime.commit(async (tx) => {
    page = await tx.scanEntries({
      conversationId: runtime.conversationId,
      order: after === undefined ? "descending" : "ascending",
      ...(before === undefined ? {} : { maxEntryId: before - 1 }),
      ...(after === undefined ? {} : { minEntryId: after + 1 }),
    }, limit);
  }, context);
  const ids = [];
  const entries = [];
  let bytes = 0;
  for (const entry of page.items) {
    const presented = presentEntry(entry);
    const size = presented ? Buffer.byteLength(JSON.stringify(presented)) : 0;
    if (ids.length && bytes + size > 600 * 1024) break;
    ids.push(entry.id);
    if (presented) entries.push(presented);
    bytes += size;
  }
  return {
    entries: entries.sort((a, b) => a.id - b.id),
    oldestId: ids.length ? Math.min(...ids) : null,
    newestId: ids.length ? Math.max(...ids) : null,
    hasMore: Boolean(page.next) || ids.length < page.items.length,
  };
}

async function currentState(runtime, context) {
  const [link, live, inbox, agent] = await Promise.all([
    runtime.snapshot(WebLink, runtime.conversationId, context),
    runtime.snapshot(LiveDoc, runtime.conversationId, context),
    runtime.snapshot(InboxDoc, runtime.conversationId, context),
    runtime.snapshot(AgentDoc, runtime.conversationId, context),
  ]);
  let tailId = 0;
  await runtime.commit(async (tx) => {
    tailId = (await tx.scanEntries({ conversationId: runtime.conversationId }, 1)).items[0]?.id ?? 0;
  }, context);
  return {
    sessionId: link.id, name: link.name, conversationId: runtime.conversationId,
    cwd: agent?.cwd ?? "", model: agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : "",
    tailId, live: presentLive(live, inbox),
  };
}

async function dispatch(runtime, method, params, context) {
  if (method === "history") return history(runtime, params, context);
  if (method === "state") return currentState(runtime, context);
  if (method === "entry") {
    if (!Number.isSafeInteger(params.id) || params.id < 1 || !Number.isSafeInteger(params.offset ?? 0) || (params.offset ?? 0) < 0) throw new Error("Invalid entry query");
    const entry = await runtime.entry(params.id, context);
    if (!entry) throw new Error("Entry is not visible in this conversation");
    return presentEntry(entry, params.offset ?? 0, 48000);
  }
  const conversation = await runtime.conversation(runtime.conversationId, context);
  if (!conversation) throw new Error("Conversation is unavailable");
  if (method === "input") {
    if (typeof params.content !== "string" || !params.content.trim() || Buffer.byteLength(params.content) > 65536 || !isId(params.requestId) || !["steer", "followUp", "reject"].includes(params.mode)) throw new Error("Invalid input");
    const submission = await conversation.submit({
      type: "input", content: params.content, whenBusy: params.mode,
      requestId: `pi-d-web:${params.requestId}`,
    }, context);
    const record = await submission.status(context);
    return { submissionId: submission.id, status: record.status };
  }
  if (method === "interrupt") {
    await conversation.abort(context); // Foreground only; this background bridge survives.
    return { interrupted: true };
  }
  throw new Error("Unknown bridge method");
}

async function connected(runtime, link, home, signal, context) {
  const socket = createConnection({ path: socketPath(home), signal });
  const peer = new JsonPeer(socket);
  const connection = new AbortController();
  const connectionSignal = AbortSignal.any([signal, connection.signal]);
  const connectionContext = withAbortSignal(connectionSignal, context);
  const watches = [];
  let commands = Promise.resolve();
  let commandCount = 0;
  let publisher = Promise.resolve();
  let dirty = true;
  let wake;
  const changed = () => { dirty = true; wake?.(); wake = undefined; };
  const cancelled = () => { changed(); peer.destroy(); };
  connectionSignal.addEventListener("abort", cancelled, { once: true });
  try {
    await once(socket, "connect", { signal: connectionSignal });
    const state = await currentState(runtime, connectionContext);
    peer.send({ type: "hello", protocol: 1, ...state, sessionId: link.id });
    peer.on("message", (frame) => {
      if (frame.type !== "request" || !isId(frame.id) || typeof frame.method !== "string" || !frame.params || typeof frame.params !== "object" || Array.isArray(frame.params)) return;
      if (++commandCount > 32) { peer.destroy(); return; }
      commands = commands.then(async () => {
        if (connectionSignal.aborted) return;
        try {
          const result = await dispatch(runtime, frame.method, frame.params, connectionContext);
          peer.send({ type: "response", id: frame.id, ok: true, result });
          changed();
        } catch (error) {
          peer.send({ type: "response", id: frame.id, ok: false,
            code: error.name === "ConversationBusy" ? "BUSY" : "FAILED",
            message: error.name === "ConversationBusy" ? "Session is busy; choose Steer or Follow-up." : "The session could not complete this request. Check its terminal status." });
        } finally { commandCount--; }
      }).catch(() => { peer.destroy(); });
    });
    for (const doc of [LiveDoc, InboxDoc, AgentDoc, WebLink]) {
      const watch = await runtime.watchDoc(doc, runtime.conversationId, connectionContext);
      if (watch) { watches.push(watch); watch.start(async () => { changed(); }); }
    }
    publisher = (async () => {
      while (!connectionSignal.aborted) {
        if (!dirty) await new Promise((resolve) => { wake = resolve; });
        if (connectionSignal.aborted) break;
        dirty = false;
        peer.send({ type: "state", state: await currentState(runtime, connectionContext) });
        // Coalesce committed token/tool updates. No idle polling or transcript cache.
        await delay(200, undefined, { signal: connectionSignal });
      }
    })().catch(() => { peer.destroy(); });
    await peer.closed;
  } finally {
    connection.abort();
    peer.destroy();
    await Promise.all(watches.map((watch) => watch.stop()));
    await Promise.all([publisher, commands]);
    connectionSignal.removeEventListener("abort", cancelled);
  }
}

export const WebBridgeTask = defineTask({
  name: "pi-d-web.bridge", version: 1,
  initial: () => ({ phase: "serve" }),
  phases: {
    serve: async (task, runtime, context) => {
      const stop = new AbortController();
      const signal = AbortSignal.any([runtime.signal, stop.signal, ...(context.abortSignal ? [context.abortSignal] : [])]);
      const watch = await runtime.watchDoc(WebLink, runtime.conversationId, context);
      watch?.start(async (link) => { if (!link?.enabled || link.taskId !== task.id) stop.abort(); });
      try {
        let backoff = 500;
        while (!signal.aborted) {
          const link = await runtime.snapshot(WebLink, runtime.conversationId, context);
          if (!link?.enabled || link.taskId !== task.id) break;
          const began = Date.now();
          try { await connected(runtime, link, task.input.home, signal, context); }
          catch { if (signal.aborted) break; }
          if (signal.aborted) break;
          if (Date.now() - began > 10000) backoff = 500;
          await delay(backoff, undefined, { signal }).catch(() => {});
          backoff = Math.min(backoff * 2, 10000);
        }
      } finally { stop.abort(); await watch?.stop(); }
      if (!runtime.signal.aborted && !context.abortSignal?.aborted) {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      }
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(async (tx) => {
      const link = await tx.doc(WebLink, runtime.conversationId);
      if (link.taskId === runtime.taskId) link.enabled = false;
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

// Both model tools and local commands use the owning Harness's native state/task APIs.
async function connectBridge(api, conversationId, name, cwd, context) {
  const home = defaultHome();
  const settings = await readSettings(home);
  let result;
  await api.commit(async (tx) => {
    const link = await tx.doc(WebLink, conversationId);
    const existing = link.taskId ? await tx.task(link.taskId) : undefined;
    if (existing && existing.state.status !== "terminal" && existing.abortRequested) throw new Error("Bridge is stopping; wait and retry.");
    const running = existing && !["terminal", "completing"].includes(existing.state.status);
    if (!link.id) link.id = randomUUID();
    link.name = name?.trim() || link.name || basename(cwd ?? "session") || "session";
    link.enabled = true;
    if (!running) link.taskId = await tx.createTask(WebBridgeTask, { home }, {
      conversationId, ownership: { kind: "conversation" }, background: true,
    });
    result = { sessionId: link.id, name: link.name, url: `${settings.origin}/s/${link.id}` };
  }, context);
  return result;
}

async function disconnectBridge(api, conversationId, context) {
  let id;
  await api.commit(async (tx) => {
    const link = await tx.doc(WebLink, conversationId);
    id = link.taskId;
    link.enabled = false;
  }, context);
  if (id) await api.waitForTask(id, context);
}

async function webStatus(api, conversationId, context) {
  const service = await serviceStatus(defaultHome(), { signal: context.abortSignal });
  const link = await api.snapshot(WebLink, conversationId, context);
  return { service, conversation: {
    enabled: Boolean(link?.enabled), connected: Boolean(link?.enabled && service.sessionIds.includes(link.id)),
    url: link?.id ? `${service.origin}/s/${link.id}` : null,
  } };
}

const WEB_USAGE = "Usage: /web start [name] | status | connect [name] | disconnect | stop --all";
const WEB_COMPLETIONS = [
  { value: "start", label: "start [name]", description: "Start/reuse the managed service and connect this conversation" },
  { value: "status", label: "status", description: "Read-only service and conversation status" },
  { value: "connect", label: "connect [name]", description: "Connect only this conversation to an existing service" },
  { value: "disconnect", label: "disconnect", description: "Disconnect only this conversation; keep the service running" },
  { value: "stop --all", label: "stop --all", description: "Stop the shared web server for ALL sessions" },
];

async function executeWebCommand(argument, { harness, conversation, signal, context, notify }) {
  signal.throwIfAborted();
  const match = argument.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const action = match?.[1] ?? "help", rest = match?.[2]?.trim() ?? "";
  if (action === "help" && !rest) { notify(WEB_USAGE); return; }
  if (action === "status" && !rest) {
    const status = await webStatus(harness, conversation.id, context);
    const state = !status.conversation.enabled ? "disabled" : status.conversation.connected ? "connected" : "enabled, offline";
    const owner = status.service.running ? status.service.managed ? " (managed)" : " (external)" : "";
    signal.throwIfAborted();
    notify(`Web service: ${status.service.state}${owner}. This conversation: ${state}.${status.conversation.url ? ` ${status.conversation.url}` : ""}`);
    return;
  }
  if (action === "stop" && rest !== "--all") throw new Error("Stopping affects ALL sessions. Use /web stop --all, or /web disconnect for only this conversation.");
  if (!["start", "connect", "disconnect", "stop"].includes(action) || (action === "disconnect" && rest)) throw new Error(WEB_USAGE);
  if (["start", "connect"].includes(action) && rest.length > 80) throw new Error("Web session names must be at most 80 characters.");
  // waitForTask() resumes the whole scheduler. Never bypass the host's auth/recovery gate.
  if ((await harness.inspect(context)).scheduling !== "running") throw new Error("Session scheduling is paused or closing. Use /status and resolve authentication/recovery first. /web status remains read-only.");
  if (action === "start" || action === "connect") {
    const agent = await conversation.agent(context);
    if (action === "start") await startService(defaultHome(), { signal });
    const link = await connectBridge(harness, conversation.id, rest || undefined, agent.cwd, context);
    signal.throwIfAborted();
    notify(`Web bridge enabled: ${link.url}`);
    return;
  }
  if (action === "disconnect") {
    await disconnectBridge(harness, conversation.id, context);
    signal.throwIfAborted();
    notify("Web bridge disconnected. The shared service and stable session URL are retained.");
    return;
  }
  const home = defaultHome();
  const current = await serviceStatus(home, { signal });
  if (current.running && !current.managed) throw new Error("The web service is owned by another supervisor; refusing to stop it. Use /web disconnect for only this conversation.");
  await disconnectBridge(harness, conversation.id, context);
  await stopService(home, { signal });
  signal.throwIfAborted();
  notify("Shared web service stopped for ALL sessions. pi-d and foreground work were not stopped.");
}

export default defineChatExtension({
  name: "pi-d-web",
  tasks: [WebBridgeTask],
  piD: { commands: [{
    name: "web", description: "Control private web access locally, without a model call",
    argumentHint: "start [name] | status | connect [name] | disconnect | stop --all",
    complete: (prefix) => WEB_COMPLETIONS.filter((item) => item.value.startsWith(prefix.trimStart())),
    execute: executeWebCommand,
  }] },
  sections: [section("web_remote", () => "Use web_start (managed macOS service plus this conversation's bridge) or web_connect (bridge only) only when the user explicitly asks for web access. web_status reports service and conversation status. web_disconnect disables only this conversation; web_stop requires explicit permission to stop the shared service for ALL sessions. No Tailscale routes or login-startup services are installed. The bridge is a native background task: disconnect before changing models, settings or switching sessions in this pi-d process. Remote messages are ordinary user input, not local slash commands.")],
  tools: [
    defineTool({
      name: "web_start", description: "Start the shared macOS pi-d-web service and enable this conversation's web bridge. Only at the user's request. Idempotent; no duplicate service, login-startup installation or Tailscale route changes.",
      replay: "safe", executionMode: "sequential", parameters: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) }),
      execute: async (args, api, context) => {
        const service = await startService(defaultHome(), { signal: context.abortSignal });
        const connection = await api.executeTool("web_connect", args, context, { key: "connect" });
        if (connection.isError) throw new Error("The web service is running, but this conversation could not connect. Check web_status before retrying.");
        return { output: [{ type: "text", text: `${JSON.stringify({ service })}\n${typeof connection.structuredOutput === "string" ? connection.structuredOutput : "Web bridge enabled."}` }] };
      },
    }),
    defineTool({
      name: "web_status", description: "Report whether the shared web service is running/managed and whether this conversation is enabled and connected. Does not start, stop or opt in a conversation.",
      replay: "safe", parameters: Type.Object({}),
      execute: async (_args, api, context) => {
        return { output: [{ type: "text", text: JSON.stringify(await webStatus(api, api.conversationId, context)) }] };
      },
    }),
    defineTool({
      name: "web_stop", description: "Disconnect this conversation and stop the shared managed macOS web service for ALL sessions. Requires explicit user permission for a global stop. Does not stop pi-d/model work or change Tailscale routes. Use web_disconnect for just this session; a browser connection cannot restart its stopped server.",
      replay: "safe", executionMode: "sequential", parameters: Type.Object({ allSessions: Type.Literal(true) }),
      execute: async (_args, api, context) => {
        const home = defaultHome();
        const current = await serviceStatus(home, { signal: context.abortSignal });
        if (current.running && !current.managed) throw new Error("The web service is owned by another supervisor; refusing to stop it. Use web_disconnect to disable only this conversation.");
        const disconnected = await api.executeTool("web_disconnect", {}, context, { key: "disconnect" });
        if (disconnected.isError) throw new Error("Could not join this conversation's bridge. The shared service was left running.");
        const service = await stopService(home, { signal: context.abortSignal });
        return { output: [{ type: "text", text: `${JSON.stringify({ service })}\nShared web service stopped. Other enabled bridges reconnect when it starts again; this conversation can be re-enabled with web_start. pi-d and foreground work were not stopped.` }] };
      },
    }),
    defineTool({
      name: "web_connect", description: "Explicitly opt this conversation into the private pi-d-web service, with a stable session URL. Start only at the user's request. Safe to call again; the bridge recovers on reopen with the same extension.",
      replay: "safe", parameters: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) }),
      execute: async (args, api, context) => {
        const result = await connectBridge(api, api.conversationId, args.name, api.env?.cwd, context);
        return { output: [{ type: "text", text: `${JSON.stringify(result)}\nWeb bridge enabled. It reconnects automatically while this pi-d session is running. The separate web service must also be running.` }] };
      },
    }),
    defineTool({
      name: "web_disconnect", description: "Disable this conversation's web bridge and join its background task. Do this before changing models/settings or switching sessions. Does not interrupt foreground model work.",
      replay: "safe", parameters: Type.Object({}),
      execute: async (_args, api, context) => {
        await disconnectBridge(api, api.conversationId, context);
        return { output: [{ type: "text", text: "Web bridge disconnected. Its stable session URL is retained for the next web_connect." }] };
      },
    }),
  ],
});
