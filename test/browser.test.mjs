import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fixture, fakeSession, until } from "./helpers.mjs";
import { presentEntry } from "../src/transcript.mjs";

let browser;
for (const candidate of [process.env.PI_D_WEB_BROWSER, "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(Boolean)) {
  try { await access(candidate, constants.X_OK); browser = candidate; break; } catch {}
}

async function chromium() {
  const profile = await mkdtemp("/tmp/pi-d-web-browser-");
  const child = spawn(browser, [
    "--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-extensions", "--disable-breakpad", "--disable-crash-reporter", "--disable-features=MediaRouter,OptimizationHints,Translate",
    "--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost,EXCLUDE 127.0.0.1", "about:blank",
  ], { stdio: "ignore" });
  let launchError;
  child.once("error", (error) => { launchError = error; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let socket;
  const pending = new Map();
  let nextId = 0;
  const errors = [];
  async function close() {
    socket?.close();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Browser closed.")); }
    pending.clear();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await exited; } finally { clearTimeout(kill); }
    }
    await rm(profile, { recursive: true, force: true });
  }
  try {
    const active = await until(async () => {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error("Isolated Chromium exited during startup.");
      try { return await readFile(join(profile, "DevToolsActivePort"), "utf8"); } catch { return null; }
    }, Boolean, 10000);
    const port = Number(active.split("\n")[0]);
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, "open");
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(event.data);
      if (value.method === "Runtime.exceptionThrown") errors.push("Browser exception");
      const item = pending.get(value.id);
      if (!item) return;
      pending.delete(value.id); clearTimeout(item.timer);
      if (value.error) item.reject(new Error("Browser protocol request failed.")); else item.resolve(value.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser protocol timeout: ${method}`)); }, 8000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) throw new Error("Browser evaluation failed.");
      return result.result.value;
    };
    const wait = (expression) => until(() => evaluate(expression).catch(() => false));
    await call("Page.enable"); await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const enter = async ({ shift = false, repeat = false } = {}) => {
      const modifiers = shift ? 8 : 0;
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r", modifiers, autoRepeat: repeat });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers });
    };
    return { call, evaluate, wait, enter, errors, close };
  } catch (error) { await close(); throw error; }
}

test("isolated mobile Chromium signs in, renders safe history/live output, retries the same input ID, and interrupts", { skip: !browser, timeout: 30000 }, async () => {
  const f = await fixture();
  const records = Array.from({ length: 35 }, (_, index) => ({
    id: index + 1, kind: "pi.assistant", model: [{ role: "assistant", timestamp: 1700000000000, content: [{ type: "text", text: `History ${index + 1}` }] }],
  }));
  records[33].model[0].content[0].text = '<img src=x onerror="window.__pwned=1"> This must remain plain text.';
  records[34].model[0].content[0].text = "Long message " + "z".repeat(10000);
  let session, chrome;
  let loseFirstAck = true;
  const submissions = new Map();
  const inputs = [];
  const interrupts = [];
  const state = () => ({ sessionId: session.id, name: "Mobile fixture", cwd: "/fixture/project", model: "faux/faux-1", tailId: records.at(-1).id, live: { busy: false, partial: "", tools: [], queueCount: 0, queue: [] } });
  function respond(frame) {
    if (frame.method === "history") {
      let selected = records.filter((record) => (frame.params.before === undefined || record.id < frame.params.before) && (frame.params.after === undefined || record.id > frame.params.after));
      if (frame.params.after === undefined) selected = [...selected].reverse();
      const page = selected.slice(0, frame.params.limit ?? 30);
      return { entries: page.map((record) => presentEntry(record)).sort((a, b) => a.id - b.id), oldestId: page.length ? Math.min(...page.map((record) => record.id)) : null, newestId: page.length ? Math.max(...page.map((record) => record.id)) : null, hasMore: selected.length > page.length };
    }
    if (frame.method === "entry") return presentEntry(records.find((record) => record.id === frame.params.id), frame.params.offset, 48000);
    if (frame.method === "state") return state();
    if (frame.method === "input") {
      inputs.push(frame.params);
      if (!submissions.has(frame.params.requestId)) {
        const id = records.at(-1).id + 1;
        records.push({ id, kind: "pi.user", model: [{ role: "user", timestamp: Date.now(), content: frame.params.content }] });
        records.push({ id: id + 1, kind: "pi.assistant", model: [{ role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "Reply to mobile message" }] }] });
        submissions.set(frame.params.requestId, { submissionId: id, status: "placed" });
      }
      if (loseFirstAck) { loseFirstAck = false; session.peer.destroy(); }
      else session.peer.send({ type: "state", state: state() });
      return submissions.get(frame.params.requestId);
    }
    if (frame.method === "interrupt") { interrupts.push(frame); session.peer.send({ type: "state", state: state() }); return { interrupted: true }; }
  }
  try {
    session = await fakeSession(f.server, { name: "Mobile fixture", respond });
    chrome = await chromium();
    await chrome.call("Page.navigate", { url: `${f.origin}/s/${session.id}` });
    await chrome.wait("document.getElementById('login') && !document.getElementById('login').hidden");
    await chrome.evaluate(`document.getElementById('token').value = ${JSON.stringify(f.token)}; document.getElementById('login-form').requestSubmit()`);
    await chrome.wait("!document.getElementById('session-view').hidden && document.querySelectorAll('#entries article').length === 30");
    assert.equal(await chrome.evaluate("document.getElementById('token').value"), "");
    assert.equal(await chrome.evaluate("document.cookie.includes('pi_d_web')"), false, "Cookie must be HttpOnly.");
    assert.equal(await chrome.evaluate("document.querySelectorAll('#entries img').length"), 0);
    assert.equal(await chrome.evaluate("window.__pwned === undefined"), true);
    assert.equal(await chrome.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "Mobile page must not scroll sideways.");
    await chrome.evaluate("document.querySelector('.read-more').click()");
    await chrome.wait("!document.querySelector('.read-more')");
    assert.equal(await chrome.evaluate("document.querySelector('#entries article:last-child pre').textContent.length"), records[34].model[0].content[0].text.length);
    await chrome.evaluate("document.getElementById('older').click()");
    await chrome.wait("document.querySelectorAll('#entries article').length === 35");
    session.peer.send({ type: "state", state: { ...state(), live: { busy: true, partial: "Live mobile output", tools: [{ name: "bash", status: "running", output: "Tool progress" }], queueCount: 1, queue: [{ id: 90, mode: "steer", text: "Queued guidance" }] } } });
    await chrome.wait("document.getElementById('partial').textContent === 'Live mobile output'");
    assert.match(await chrome.evaluate("document.getElementById('queue-content').textContent"), /Queued guidance/);
    await chrome.evaluate("document.getElementById('mode').value = 'followUp'; document.getElementById('mode').dispatchEvent(new Event('change')); document.getElementById('message').value = 'From my phone'; document.getElementById('message').dispatchEvent(new Event('input')); document.getElementById('compose').requestSubmit()");
    await chrome.wait("document.getElementById('send').textContent === 'Retry delivery'");
    assert.equal(await chrome.evaluate("document.getElementById('message').readOnly"), true);
    const id = session.id;
    await session.close();
    session = await fakeSession(f.server, { id, name: "Mobile fixture", respond });
    session.peer.send({ type: "state", state: state() });
    // Reload must retain the unconfirmed request UUID in this tab, not mint a new one.
    await chrome.call("Page.reload");
    await chrome.wait("document.getElementById('send').textContent === 'Retry delivery' && !document.getElementById('send').disabled");
    assert.equal(await chrome.evaluate("document.getElementById('mode').value"), "followUp", "The new idle-only default must not change an unconfirmed input's original mode.");
    await chrome.evaluate("document.getElementById('compose').requestSubmit()");
    await chrome.wait("document.getElementById('message').value === '' && document.getElementById('send').textContent === 'Send'");
    assert.equal(inputs.length, 2); assert.equal(inputs[0].requestId, inputs[1].requestId);
    assert.equal(inputs[0].mode, "followUp"); assert.equal(inputs[1].mode, "followUp");
    assert.equal(records.filter((record) => record.model[0].role === "user").length, 1);
    await chrome.wait("document.getElementById('entries').textContent.includes('Reply to mobile message')");
    session.peer.send({ type: "state", state: { ...state(), live: { busy: true, partial: "Waiting for remote instruction", tools: [], queueCount: 0, queue: [] } } });
    await chrome.wait("!document.getElementById('interrupt').disabled");
    await chrome.evaluate("window.confirm = () => true; document.getElementById('interrupt').click()");
    await until(() => interrupts.length);
    await chrome.wait("document.getElementById('notice').textContent.includes('Foreground work interrupted')");
    if (process.env.PI_D_WEB_SCREENSHOT) {
      const result = await chrome.call("Page.captureScreenshot", { format: "png" });
      await mkdir(dirname(process.env.PI_D_WEB_SCREENSHOT), { recursive: true });
      await writeFile(process.env.PI_D_WEB_SCREENSHOT, Buffer.from(result.data, "base64"));
    }
    assert.equal(chrome.errors.length, 0, "Browser must not report uncaught JavaScript exceptions.");
    await chrome.evaluate("document.getElementById('logout').click()");
    await chrome.wait("!document.getElementById('login').hidden");
  } finally { await chrome?.close(); await session?.close(); await f.cleanup(); }
});

test("compact terminal typography and pane spacing match pi-d; idle-only default and Enter preserve drafts, IME input and explicit queue modes", { skip: !browser, timeout: 30000 }, async () => {
  const f = await fixture();
  const records = [
    { id: 1, kind: "pi.user", model: [{ role: "user", content: "Inspect this workspace before making changes." }] },
    { id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "I’ll inspect the file first." }, { type: "toolCall", name: "read", arguments: { path: "src/example.ts" } }] }] },
    { id: 3, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "export const ready = true;" }] }] },
    { id: 4, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "The workspace is ready. No changes have been made.\n\nSend a message below to continue." }] }] },
  ];
  let session, chrome, busy = false;
  const inputs = [];
  const state = () => ({ sessionId: session.id, name: "workspace.sqlite", cwd: "/work/project", model: "faux/faux-1", tailId: records.at(-1).id, live: { busy, partial: busy ? "Waiting for the next response…" : "", tools: [], queueCount: 0, queue: [] } });
  const publish = () => session.peer.send({ type: "state", state: state() });
  function respond(frame) {
    if (frame.method === "history") {
      const selected = records.filter((record) => (frame.params.before === undefined || record.id < frame.params.before) && (frame.params.after === undefined || record.id > frame.params.after));
      return { entries: selected.map((record) => presentEntry(record)), oldestId: selected[0]?.id ?? null, newestId: selected.at(-1)?.id ?? null, hasMore: false };
    }
    if (frame.method === "state") return state();
    if (frame.method === "input") {
      inputs.push(frame.params); busy = false;
      const id = records.at(-1).id + 1;
      records.push({ id, kind: "pi.user", model: [{ role: "user", content: frame.params.content }] });
      publish();
      return { submissionId: id, status: "placed" };
    }
  }
  async function draft(text) {
    await chrome.evaluate(`document.getElementById('message').value = ${JSON.stringify(text)}; document.getElementById('message').focus(); document.getElementById('message').setSelectionRange(${text.length}, ${text.length}); document.getElementById('message').dispatchEvent(new Event('input'))`);
  }
  async function mode(value) {
    await chrome.evaluate(`document.getElementById('mode').value = ${JSON.stringify(value)}; document.getElementById('mode').dispatchEvent(new Event('change'))`);
  }
  try {
    session = await fakeSession(f.server, { name: "workspace.sqlite", respond }); publish();
    chrome = await chromium();
    await chrome.call("Page.navigate", { url: `${f.origin}/s/${session.id}` });
    await chrome.wait("document.getElementById('login') && !document.getElementById('login').hidden");
    await chrome.evaluate(`document.getElementById('token').value = ${JSON.stringify(f.token)}; document.getElementById('login-form').requestSubmit()`);
    await chrome.wait("!document.getElementById('session-view').hidden && document.querySelectorAll('#entries article').length === 4");
    assert.equal(await chrome.evaluate("document.getElementById('mode').value"), "reject");
    assert.equal(await chrome.evaluate("document.getElementById('message').getAttribute('enterkeyhint')"), "send");
    assert.match(await chrome.evaluate("document.getElementById('composer-help').textContent"), /Shift\+Enter newline/);
    const colors = await chrome.evaluate(`({
      background: getComputedStyle(document.documentElement).backgroundColor,
      font: getComputedStyle(document.body).fontFamily,
      frame: getComputedStyle(document.querySelector('.chat-frame')).borderLeftColor,
      composer: getComputedStyle(document.getElementById('compose')).borderLeftColor,
      user: getComputedStyle(document.querySelector('.entry.user .entry-label')).color,
      assistant: getComputedStyle(document.querySelector('.entry.assistant .entry-marker')).color,
      tool: getComputedStyle(document.querySelector('.entry.toolResult .entry-label')).color,
      messageBorder: getComputedStyle(document.querySelector('.entry')).borderTopWidth
    })`);
    assert.equal(colors.background, "rgb(0, 0, 0)"); assert.match(colors.font, /monospace/);
    assert.equal(colors.frame, "rgb(85, 109, 89)"); assert.equal(colors.composer, "rgb(108, 108, 75)");
    assert.equal(colors.user, "rgb(116, 230, 252)"); assert.equal(colors.assistant, "rgb(119, 202, 155)");
    assert.equal(colors.tool, "rgb(176, 169, 222)"); assert.equal(colors.messageBorder, "0px");
    assert.equal(await chrome.evaluate("document.querySelector('.thinking-label').textContent"), "  ┆ Thinking");
    assert.match(await chrome.evaluate("document.querySelector('.tool-label').textContent"), /↳ Tool call · read/);
    for (const viewport of [{ width: 390, height: 844, mobile: true, name: "mobile" }, { width: 1440, height: 900, mobile: false, name: "desktop" }]) {
      await chrome.call("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
      assert.equal(await chrome.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "Terminal frames must fit the viewport.");
      assert.equal(await chrome.evaluate("document.getElementById('compose').getBoundingClientRect().bottom < innerHeight"), true);
      assert.equal(await chrome.evaluate("document.getElementById('transcript').clientHeight > 200"), true);
      const typography = await chrome.evaluate(`({
        message: getComputedStyle(document.querySelector('#entries pre')).fontSize,
        role: getComputedStyle(document.querySelector('.entry-label')).fontSize,
        tool: getComputedStyle(document.querySelector('.entry.toolResult .entry-label')).fontSize,
        live: getComputedStyle(document.getElementById('partial')).fontSize,
        editor: getComputedStyle(document.getElementById('message')).fontSize,
        gap: document.getElementById('compose').getBoundingClientRect().top - document.querySelector('.chat-frame').getBoundingClientRect().bottom,
        hintGap: document.getElementById('composer-help').getBoundingClientRect().top - document.querySelector('.chat-frame').getBoundingClientRect().bottom
      })`);
      for (const field of ['message', 'role', 'tool', 'live']) assert.equal(typography[field], '12px', `${viewport.name}: ${field} text must use the compact reading size.`);
      assert.equal(typography.editor, viewport.mobile ? '16px' : '12px', 'Mobile editing must not trigger Safari focus zoom.');
      assert.equal(typography.gap, 20, 'Reading and input frames must be separated by 20px.');
      assert(typography.hintGap >= 8, 'The keyboard hint must not touch the reading frame.');
      if (process.env.PI_D_WEB_SCREENSHOT) {
        const image = await chrome.call("Page.captureScreenshot", { format: "png" });
        const path = join(dirname(process.env.PI_D_WEB_SCREENSHOT), `terminal-${viewport.name}.png`);
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.from(image.data, "base64"));
      }
    }
    await draft(""); await chrome.enter(); assert.equal(inputs.length, 0, "Empty Enter must not submit.");
    await draft("First line"); await chrome.enter({ shift: true });
    assert.equal(await chrome.evaluate("document.getElementById('message').value"), "First line\n", "Shift+Enter must insert a real newline.");
    await chrome.call("Input.insertText", { text: "Second line" });
    assert.equal(await chrome.evaluate("document.getElementById('message').value"), "First line\nSecond line");
    const composing = await chrome.evaluate("document.getElementById('message').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))");
    const legacyIme = await chrome.evaluate("document.getElementById('message').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))");
    assert.equal(composing, true); assert.equal(legacyIme, true); assert.equal(inputs.length, 0, "IME composition must not submit.");
    await chrome.enter({ repeat: true }); assert.equal(inputs.length, 0, "Held Enter must not repeat submissions.");
    await chrome.enter(); await until(() => inputs.length === 1); await chrome.wait("document.getElementById('message').value === ''");
    assert.equal(inputs[0].content, "First line\nSecond line"); assert.equal(inputs[0].mode, "reject");
    busy = true; publish();
    await chrome.wait("document.getElementById('activity').dataset.phase === 'busy'");
    await draft("Keep this draft");
    assert.equal(await chrome.evaluate("document.getElementById('send').disabled"), true);
    await chrome.enter(); await chrome.evaluate("document.getElementById('compose').requestSubmit()");
    assert.equal(inputs.length, 1, "Idle-only mode must not submit while busy, even through programmatic form submission.");
    assert.equal(await chrome.evaluate("document.getElementById('message').value"), "Keep this draft");
    assert.match(await chrome.evaluate("document.getElementById('composer-state').textContent"), /Session busy · draft kept/);
    await mode("steer");
    assert.equal(await chrome.evaluate("document.getElementById('send').disabled"), false);
    await chrome.enter(); await until(() => inputs.length === 2); await chrome.wait("document.getElementById('message').value === ''");
    assert.equal(inputs[1].mode, "steer");
    busy = true; publish(); await chrome.wait("document.getElementById('activity').dataset.phase === 'busy'");
    await mode("followUp"); await draft("Queue this follow-up"); await chrome.enter();
    await until(() => inputs.length === 3); await chrome.wait("document.getElementById('message').value === ''");
    assert.equal(inputs[2].mode, "followUp");
    await mode("reject"); await draft("Keep while offline");
    const id = session.id; await session.close();
    await chrome.wait("document.getElementById('activity').dataset.phase === 'offline'");
    await chrome.enter(); assert.equal(inputs.length, 3);
    assert.equal(await chrome.evaluate("document.getElementById('message').value"), "Keep while offline");
    session = await fakeSession(f.server, { id, name: "workspace.sqlite", respond }); publish();
    await chrome.wait("!document.getElementById('send').disabled");
    assert.equal(inputs.length, 3, "Reconnecting must not send a saved draft automatically.");
    await chrome.enter(); await until(() => inputs.length === 4); await chrome.wait("document.getElementById('message').value === ''");
    assert.equal(inputs[3].mode, "reject"); assert.equal(inputs[3].content, "Keep while offline");
    assert.equal(chrome.errors.length, 0);
  } finally { await chrome?.close(); await session?.close(); await f.cleanup(); }
});

test("Tailscale browsers open sessions without a code or cookie; disallowed and missing identities never see a token prompt", { skip: !browser, timeout: 30000 }, async () => {
  const origin = "https://fixture.test.ts.net:8443";
  const f = await fixture({ origin, token: undefined, authentication: { mode: "tailscale", allowedUsers: ["owner@example.com"] }, heartbeatInterval: 25 });
  const headers = { "Tailscale-User-Login": "owner@example.com", "X-Forwarded-Host": new URL(origin).host, "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.2" };
  const records = [{ id: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Connected using your Tailscale account." }] }] }];
  const inputs = [];
  let session, chrome;
  const state = () => ({ sessionId: session.id, name: "Tailscale fixture", cwd: "/fixture/project", model: "faux/faux-1", tailId: records.at(-1).id, live: { busy: false, partial: "", tools: [], queueCount: 0, queue: [] } });
  function respond(frame) {
    if (frame.method === "history") {
      const selected = records.filter((record) => frame.params.after === undefined || record.id > frame.params.after);
      return { entries: selected.map((record) => presentEntry(record)), oldestId: selected[0]?.id ?? null, newestId: selected.at(-1)?.id ?? null, hasMore: false };
    }
    if (frame.method === "state") return state();
    if (frame.method === "input") {
      inputs.push(frame.params);
      const id = records.at(-1).id + 1;
      records.push({ id, kind: "pi.user", model: [{ role: "user", content: frame.params.content }] });
      session.peer.send({ type: "state", state: state() });
      return { submissionId: id, status: "placed" };
    }
  }
  try {
    session = await fakeSession(f.server, { name: "Tailscale fixture", respond });
    session.peer.send({ type: "state", state: state() });
    chrome = await chromium();
    await chrome.call("Network.enable");
    // Simulate Serve's verified headers in an isolated profile, not a real tailnet/provider.
    await chrome.call("Network.setExtraHTTPHeaders", { headers });
    await chrome.call("Page.navigate", { url: `${f.origin}/s/${session.id}` });
    await chrome.wait("!document.getElementById('session-view').hidden && document.querySelectorAll('#entries article').length === 1");
    assert.equal(await chrome.evaluate("document.getElementById('login').hidden && document.getElementById('logout').hidden"), true);
    assert.equal(await chrome.evaluate("document.getElementById('connection').textContent"), "tailscale");
    assert.equal((await chrome.call("Network.getCookies", { urls: [f.origin] })).cookies.length, 0);
    await chrome.evaluate("document.getElementById('message').value = 'No code needed'; document.getElementById('message').focus(); document.getElementById('message').dispatchEvent(new Event('input'))");
    await chrome.enter(); await until(() => inputs.length === 1);
    await chrome.wait("document.getElementById('message').value === '' && document.querySelectorAll('#entries article').length === 2");
    assert.equal(inputs[0].content, "No code needed"); assert.equal(inputs[0].mode, "reject");
    for (const deniedHeaders of [{ ...headers, "Tailscale-User-Login": "other@example.com" }, {}]) {
      await chrome.call("Network.setExtraHTTPHeaders", { headers: deniedHeaders });
      await chrome.call("Page.reload");
      await chrome.wait("!document.getElementById('tailscale-required').hidden");
      assert.equal(await chrome.evaluate("document.getElementById('login').hidden && document.getElementById('logout').hidden && document.getElementById('session-view').hidden"), true);
      assert.equal(await chrome.evaluate("document.getElementById('connection').textContent"), "access denied");
    }
    await chrome.call("Network.setExtraHTTPHeaders", { headers }); await chrome.call("Page.reload");
    await chrome.wait("!document.getElementById('session-view').hidden && document.querySelectorAll('#entries article').length === 2");
    assert.equal(await chrome.evaluate("document.getElementById('login').hidden && document.getElementById('logout').hidden"), true);
    assert.equal(chrome.errors.length, 0);
  } finally { await chrome?.close(); await session?.close(); await f.cleanup(); }
});
