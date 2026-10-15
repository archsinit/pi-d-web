import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createConnection } from "node:net";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { privateDirectory, readSettings, socketPath } from "./config.mjs";
import { isId, JsonPeer } from "./wire.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

export function serviceLabel(home) {
  return `local.pi-d-web.${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 24)}`;
}

async function launchctl(args, signal) {
  signal?.throwIfAborted();
  return execute("/bin/launchctl", args, { signal, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
}

async function jobFor(home, signal) {
  if (process.platform !== "darwin") return null;
  let output;
  try { output = (await launchctl(["list"], signal)).stdout; }
  catch { signal?.throwIfAborted(); throw new Error("Cannot query this user's macOS service manager."); }
  const label = serviceLabel(home);
  for (const line of output.split("\n")) {
    const [pid, status, name] = line.trim().split(/\s+/);
    if (name === label) return { pid: /^\d+$/.test(pid) ? Number(pid) : null, exitStatus: Number(status) };
  }
  return null;
}

// Private, bounded, invocation-owned IPC; never query HTTP/session history for service control.
async function probe(home, signal) {
  signal?.throwIfAborted();
  const path = socketPath(home);
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("Refusing an unexpected or non-private service socket.");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 1000);
  const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  const socket = createConnection({ path, signal: combined });
  const peer = new JsonPeer(socket);
  try {
    await once(socket, "connect", { signal: combined });
    const reply = Promise.race([
      once(peer, "message", { signal: combined }).then(([frame]) => frame),
      peer.closed.then(() => { throw new Error("Service connection closed."); }),
    ]);
    peer.send({ type: "service-status", protocol: 1 });
    const frame = await reply;
    if (frame.type !== "service-status" || frame.protocol !== 1 || frame.service !== "pi-d-web" || !isId(frame.instanceId)
      || !Number.isSafeInteger(frame.pid) || frame.pid < 1 || !Number.isInteger(frame.port) || frame.port < 1024 || frame.port > 65535
      || typeof frame.origin !== "string" || new URL(frame.origin).origin !== frame.origin
      || !Array.isArray(frame.sessionIds) || frame.sessionIds.length > 64 || !frame.sessionIds.every(isId)) throw new Error("Unexpected service identity.");
    return { pid: frame.pid, instanceId: frame.instanceId, port: frame.port, origin: frame.origin, sessionIds: frame.sessionIds };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === "ENOENT" || error.code === "ECONNREFUSED") return null;
    throw new Error("The private socket did not identify a compatible pi-d-web service; refusing to control an unknown process.");
  } finally {
    clearTimeout(timer); deadline.abort(); peer.destroy(); await peer.closed;
  }
}

export async function serviceStatus(home, { signal } = {}) {
  const settings = await readSettings(home);
  await privateDirectory(home);
  let instance;
  try { instance = await probe(home, signal); }
  catch {
    signal?.throwIfAborted();
    // A process can exit (or finish chmod) between lstat and connect. Retry once,
    // then fail closed rather than treating an unknown live socket as our service.
    await delay(50, undefined, { signal });
    instance = await probe(home, signal);
  }
  const job = await jobFor(home, signal);
  return {
    state: instance ? "running" : job?.pid ? "starting" : "stopped",
    running: Boolean(instance), managed: Boolean(instance && job?.pid === instance.pid),
    loaded: Boolean(job), label: serviceLabel(home), management: process.platform === "darwin" ? "launchctl" : "manual",
    port: settings.port, origin: settings.origin, sessionIds: [], ...instance,
  };
}

function requireManager() {
  if (process.platform !== "darwin") throw new Error("Managed start/stop currently requires macOS. Run 'node cli.mjs serve' under your own supervisor on other systems.");
}

async function privateLog(path) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("Service logs must be private, account-owned regular files.");
  } finally { await file.close(); }
}

async function ready(home, signal) {
  const began = Date.now();
  while (Date.now() - began < 10000) {
    const status = await serviceStatus(home, { signal });
    if (status.running) {
      if (!status.managed) throw new Error("A different supervisor owns the running service; it was not replaced.");
      return status;
    }
    const job = await jobFor(home, signal);
    if (!job || (!job.pid && job.exitStatus !== 0)) break;
    await delay(100, undefined, { signal });
  }
  throw new Error("Web service did not become ready. Check the private service-error.log; no unrelated process was stopped.");
}

export async function startService(home, { signal } = {}) {
  requireManager();
  const current = await serviceStatus(home, { signal });
  if (current.running) {
    const settings = await readSettings(home);
    if (current.port !== settings.port || current.origin !== settings.origin) throw new Error("The running service has different settings. Stop it through its supervisor before starting again.");
    return { ...current, started: false };
  }
  if (current.state === "starting") return { ...await ready(home, signal), started: false };
  // An exited job with our home-scoped label can be replaced; never kill a PID or a port owner.
  if (current.loaded) await launchctl(["remove", current.label], signal);
  const output = join(home, "service.log"), errors = join(home, "service-error.log");
  await privateLog(output); await privateLog(errors);
  let submitted = true;
  try {
    await launchctl(["submit", "-l", current.label, "-o", output, "-e", errors, "--", "/usr/bin/env", `PI_D_WEB_HOME=${resolve(home)}`, process.execPath, cli, "serve"], signal);
  } catch {
    signal?.throwIfAborted();
    // Another pi-d process may have won the same atomic launchctl label.
    if (!await jobFor(home, signal)) throw new Error("Could not submit the pi-d-web service to the macOS service manager.");
    submitted = false;
  }
  return { ...await ready(home, signal), started: submitted };
}

export async function stopService(home, { signal } = {}) {
  requireManager();
  let current = await serviceStatus(home, { signal });
  if (current.state === "starting") current = await ready(home, signal);
  if (current.running && !current.managed) throw new Error("This service belongs to another supervisor. Stop it there; refusing to kill an unmanaged process.");
  if (!current.loaded) return { ...current, stopped: false };
  try { await launchctl(["remove", current.label], signal); }
  catch {
    signal?.throwIfAborted();
    if (await jobFor(home, signal)) throw new Error("The macOS service manager could not stop pi-d-web.");
  }
  const began = Date.now();
  while (Date.now() - began < 10000) {
    const status = await serviceStatus(home, { signal });
    if (!status.running && !status.loaded) return { ...status, stopped: true };
    if (status.running && current.instanceId && status.instanceId !== current.instanceId) throw new Error("Another client restarted the service while it was stopping; the new instance was left alone.");
    await delay(100, undefined, { signal });
  }
  throw new Error("The service has not finished stopping. Check status before retrying.");
}
