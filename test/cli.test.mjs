import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readSettings, readToken, socketPath } from "../src/config.mjs";
import { until } from "./helpers.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const execute = promisify(execFile);

test("CLI setup never prints the generated token; service shuts down cleanly and reclaims only its stale socket", { timeout: 15000 }, async () => {
  const home = await mkdtemp("/tmp/pi-d-web-cli-");
  const env = { ...process.env, PI_D_WEB_HOME: home };
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  let running;
  function start() {
    const child = spawn(process.execPath, [cli, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
    child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-8192); });
    let failure;
    const exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (error) => { failure = error; resolve({ code: 1 }); });
    });
    return { child, exited, output: () => output, errors: () => errors, async ready() {
      await until(() => {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("CLI service exited before it was ready.");
        return output.includes("listening on 127.0.0.1");
      });
    } };
  }
  async function stop(signal = "SIGTERM") {
    if (!running) return;
    running.child.kill(signal);
    const result = await running.exited;
    running = undefined;
    return result;
  }
  try {
    const initialized = await execute(process.execPath, [cli, "init", "--port", String(port)], { env });
    const token = await readToken(home);
    assert(!initialized.stdout.includes(token)); assert(!initialized.stderr.includes(token));
    running = start(); await running.ready();
    assert(!running.output().includes(token)); assert(!running.errors().includes(token));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 401);
    assert.equal((await stop()).code, 0);
    await assert.rejects(lstat(socketPath(home)), { code: "ENOENT" });
    running = start(); await running.ready(); await stop("SIGKILL");
    running = start(); await running.ready();
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 401);
    assert.equal((await stop()).code, 0);
  } finally { await stop("SIGKILL"); await rm(home, { recursive: true, force: true }); }
});

test("CLI enables allowlisted Tailscale authentication and serves without generating or requiring an access code", { timeout: 15000 }, async () => {
  const home = await mkdtemp("/tmp/pi-d-web-cli-tailscale-");
  const env = { ...process.env, PI_D_WEB_HOME: home };
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  let child, exited;
  try {
    const initialized = await execute(process.execPath, [cli, "init", "--port", String(port), "--origin", "https://fixture.test.ts.net:8443", "--auth", "tailscale", "--allow-user", "owner@example.com"], { env });
    assert.match(initialized.stdout, /No browser access code is required/);
    await assert.rejects(lstat(join(home, "access-token")), { code: "ENOENT" });
    await execute(process.execPath, [cli, "init", "--port", String(port)], { env });
    assert.deepEqual((await readSettings(home)).authentication, { mode: "tailscale", allowedUsers: ["owner@example.com"] });
    await assert.rejects(execute(process.execPath, [cli, "init", "--auth", "tailscale"], { env }), /allowlist/);
    child = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    exited = once(child, "exit");
    await until(async () => {
      if (child.exitCode !== null) throw new Error("CLI Tailscale service exited before it was ready.");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/me`);
        return response.status === 403 && (await response.json()).code === "TAILSCALE_REQUIRED";
      } catch { return false; }
    });
    await assert.rejects(lstat(join(home, "access-token")), { code: "ENOENT" });
    child.kill("SIGTERM"); assert.equal((await exited)[0], 0);
  } finally {
    if (child?.exitCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI start/status/stop manage one private, home-scoped service without a terminal or login-startup install", { skip: process.platform !== "darwin", timeout: 20000 }, async () => {
  const home = await mkdtemp("/tmp/pi-d-web-cli-controls-");
  const env = { ...process.env, PI_D_WEB_HOME: home };
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const invoke = async (command) => JSON.parse((await execute(process.execPath, [cli, command], { env })).stdout);
  try {
    await execute(process.execPath, [cli, "init", "--port", String(port), "--origin", "https://fixture.test.ts.net:8443", "--auth", "tailscale", "--allow-user", "owner@example.com"], { env });
    assert.equal((await invoke("status")).state, "stopped");
    const started = await invoke("start"); assert.equal(started.running, true); assert.equal(started.managed, true);
    const again = await invoke("start"); assert.equal(again.pid, started.pid); assert.equal(again.started, false);
    assert.equal((await invoke("status")).instanceId, started.instanceId);
    assert.equal((await invoke("stop")).running, false);
    assert.equal((await invoke("stop")).stopped, false);
    await assert.rejects(lstat(join(home, "access-token")), { code: "ENOENT" });
    await assert.rejects(lstat(socketPath(home)), { code: "ENOENT" });
  } finally {
    await execute(process.execPath, [cli, "stop"], { env });
    await rm(home, { recursive: true, force: true });
  }
});
