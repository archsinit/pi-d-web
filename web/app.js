const $ = (id) => document.getElementById(id);
const match = location.pathname.match(/^\/s\/([0-9a-f-]{36})$/i);
const sessionId = match?.[1] ?? null;
const endpoint = sessionId ? `/api/sessions/${sessionId}` : null;
const pendingKey = `pi-d-web:pending:${sessionId}`;
let signedIn = false;
let authentication = "token";
let source;
let online = false;
let busy = false;
let sending = false;
let pending;
let oldest = null;
let lastSeen = 0;
let initialized = false;
let hasOlder = true;
let refreshing = false;
let refreshAgain = false;
let growHistory = false;
const entries = new Map();

function notice(text = "") { $("notice").textContent = text; $("notice").hidden = !text; }
function storePending(value) {
  pending = value;
  try { if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingKey); } catch {}
  composeState();
}
try { pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null"); } catch {}
if (pending && (typeof pending.content !== "string" || typeof pending.requestId !== "string" || !["steer", "followUp", "reject"].includes(pending.mode))) pending = null;
if (pending) { $("message").value = pending.content; $("mode").value = pending.mode; }

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: "same-origin", headers: { "Content-Type": "application/json", ...options.headers } });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error ?? "Request failed."); error.status = response.status; error.code = result.code;
    if (error.code === "TAILSCALE_REQUIRED") showTailscaleRequired();
    else if (response.status === 401) showLogin();
    throw error;
  }
  if (path === "/api/me") authentication = result.authentication ?? "token";
  return result;
}

function showLogin() {
  signedIn = false; source?.close(); source = null;
  $("login").hidden = false; $("tailscale-required").hidden = true; $("session-list").hidden = true; $("session-view").hidden = true; $("logout").hidden = true;
  $("connection").textContent = "sign in";
}

function showTailscaleRequired() {
  signedIn = false; source?.close(); source = null;
  $("login").hidden = true; $("tailscale-required").hidden = false; $("session-list").hidden = true; $("session-view").hidden = true; $("logout").hidden = true;
  $("connection").textContent = "access denied";
}

function idleOnlyBlocked() { return !pending && busy && $("mode").value === "reject"; }

function composeState() {
  $("message").readOnly = Boolean(pending);
  $("mode").disabled = Boolean(pending);
  $("send").disabled = !signedIn || !online || sending || idleOnlyBlocked() || (!pending && !$("message").value.trim());
  $("send").textContent = sending ? "Sending…" : pending ? "Retry delivery" : "Send";
  $("pending-help").hidden = !pending || sending;
  $("interrupt").disabled = !online || !busy;
  const hint = !online ? "Offline · draft kept" : idleOnlyBlocked() ? "Session busy · draft kept. Choose Steer or Follow-up to send." : "";
  $("composer-state").textContent = hint;
  $("composer-state").hidden = !hint;
}

function activity(label, phase = "ready") {
  $("activity").textContent = `● ${label}`;
  $("activity").dataset.phase = phase;
}

function renderSessions(sessions) {
  $("empty-sessions").hidden = sessions.length > 0;
  const cards = sessions.map((session) => {
    const card = document.createElement("a"); card.className = `card${session.connected ? "" : " offline"}`; card.href = `/s/${session.id}`;
    const title = document.createElement("span"); title.className = "card-title"; title.textContent = session.name;
    const state = document.createElement("span"); state.className = "badge"; state.textContent = session.connected ? session.busy ? "● responding" : "● ready" : "○ offline";
    const meta = document.createElement("span"); meta.className = "muted"; meta.textContent = [session.cwd, session.model].filter(Boolean).join("\n");
    card.append(title, state, meta); return card;
  });
  $("session-cards").replaceChildren(...cards);
  if (sessionId) {
    const current = sessions.find((item) => item.id === sessionId);
    online = Boolean(current?.connected);
    if (current) {
      $("session-name").textContent = current.name;
      document.title = `${current.name} · pi-d remote`;
      $("session-meta").textContent = [current.cwd, sessionId.slice(0, 8)].filter(Boolean).join(" · ");
      $("model-name").textContent = current.model ?? "";
    }
    if (!online) { busy = false; activity("offline", "offline"); $("live-panel").hidden = true; }
    composeState();
  }
}

function pinned() { const pane = $("transcript"); return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100; }
function scrollDown() { $("transcript").scrollTop = $("transcript").scrollHeight; }

function paintBody(element, text, role) {
  if (role !== "assistant") { element.textContent = text; return; }
  // Style the bridge's plain-text block markers without parsing/executing HTML.
  const fragment = document.createDocumentFragment();
  const markers = /(^|\n)(\[Thinking\]|\[Tool: ([^\]\r\n]+)\])(?=\n|$)/g;
  let offset = 0;
  for (const match of text.matchAll(markers)) {
    fragment.append(text.slice(offset, match.index), match[1]);
    const marker = document.createElement("span");
    marker.className = match[3] ? "tool-label" : "thinking-label";
    marker.textContent = match[3] ? `  ↳ Tool call · ${match[3]}` : "  ┆ Thinking";
    fragment.append(marker);
    offset = match.index + match[0].length;
  }
  fragment.append(text.slice(offset));
  element.replaceChildren(fragment);
}

function addEntries(incoming) {
  for (const entry of incoming) {
    if (entries.has(entry.id)) continue; // Durable entries are immutable; retain expanded text.
    const article = document.createElement("article"); article.className = `entry ${entry.role}${entry.isError ? " error" : ""}`;
    const label = document.createElement("div"); label.className = "entry-label";
    const marker = document.createElement("span"); marker.className = "entry-marker"; marker.setAttribute("aria-hidden", "true");
    marker.textContent = entry.role === "user" ? "❯" : entry.role === "assistant" ? "●" : entry.role === "toolResult" ? "↳" : "◇";
    const title = document.createElement("span"); title.className = "entry-title";
    title.textContent = entry.role === "user" ? "You" : entry.role === "assistant" ? "Assistant" : entry.role === "toolResult" ? `${entry.isError ? "Tool failed" : "Tool result"} · ${entry.label ?? "tool"}` : entry.role === "summary" ? "compacted" : entry.role === "system" ? "context reset" : "note";
    const meta = document.createElement("span"); meta.className = "entry-meta";
    meta.textContent = `#${entry.id}${entry.stopReason === "aborted" ? " · interrupted" : ""}`;
    label.title = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "";
    label.append(marker, title, meta);
    const text = document.createElement("pre"); paintBody(text, entry.text, entry.role);
    article.append(label, text);
    const item = { entry, article, text, bodyText: entry.text };
    if (entry.nextOffset !== null) {
      const more = document.createElement("button"); more.className = "quiet read-more"; more.textContent = "Read more";
      more.addEventListener("click", async () => {
        more.disabled = true;
        try {
          const chunk = await api(`${endpoint}/entry/${entry.id}?offset=${item.entry.nextOffset}`);
          item.bodyText += chunk.text;
          paintBody(item.text, item.bodyText, entry.role);
          item.entry.nextOffset = chunk.nextOffset;
          if (chunk.nextOffset === null) more.remove();
        } catch (error) { notice(error.message); } finally { more.disabled = false; }
      });
      article.append(more);
    }
    entries.set(entry.id, item);
  }
  const ordered = [...entries.values()].sort((a, b) => a.entry.id - b.entry.id);
  if (!growHistory && ordered.length > 300) {
    const removed = ordered.splice(0, ordered.length - 300);
    for (const item of removed) entries.delete(item.entry.id);
    oldest = ordered[0].entry.id; hasOlder = true;
  }
  $("entries").replaceChildren(...ordered.map((item) => item.article));
}

async function refreshHistory() {
  if (!sessionId || !signedIn || !online) return;
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  const follow = pinned() || !initialized;
  try {
    do {
      refreshAgain = false;
      let more;
      do {
        const first = !initialized || !lastSeen;
        const page = await api(`${endpoint}/history${first ? "" : `?after=${lastSeen}`}`);
        if (first) { oldest = page.oldestId; hasOlder = page.hasMore; initialized = true; }
        if (page.newestId) lastSeen = Math.max(lastSeen, page.newestId);
        addEntries(page.entries);
        more = !first && page.hasMore;
      } while (more);
      $("older").disabled = !hasOlder || !oldest;
    } while (refreshAgain);
    if (follow) scrollDown();
  } catch (error) { notice(error.message); }
  finally { refreshing = false; }
}

function renderState(state) {
  online = true;
  const follow = pinned();
  const live = state.live ?? {};
  busy = Boolean(live.busy);
  const phase = live.retry ? "retrying" : live.tools?.some((tool) => tool.status !== "done") ? "executing" : busy ? "responding" : live.compacting ? "compacting" : "ready";
  activity(phase, busy || live.compacting ? "busy" : "ready");
  $("live-panel").hidden = !busy && !live.compacting && !live.compactionError;
  paintBody($("partial"), live.partial || (busy ? "Waiting for the next committed update…" : ""), "assistant");
  $("live-tools").hidden = !live.tools?.length;
  $("tool-output").textContent = (live.tools ?? []).map((tool) => `[${tool.name} · ${tool.status}]\n${tool.output ?? ""}`).join("\n\n");
  $("live-info").textContent = [live.retry ? `Retrying: ${live.retry.error}` : "", live.compacting ? "Context compaction is running." : "", live.compactionError ? `Compaction: ${live.compactionError}` : ""].filter(Boolean).join(" ");
  $("queue-panel").hidden = !live.queueCount;
  $("queue-title").textContent = `${live.queueCount ?? 0} queued input(s)`;
  $("queue-count").textContent = live.queueCount ? `q${live.queueCount}` : "";
  $("queue-content").textContent = (live.queue ?? []).map((item) => `[${item.mode} · #${item.id}] ${item.text}`).join("\n\n");
  composeState();
  if (follow) scrollDown();
  if (!initialized || state.tailId > lastSeen) void refreshHistory();
}

function connect() {
  signedIn = true; $("login").hidden = true; $("tailscale-required").hidden = true; $("logout").hidden = authentication === "tailscale";
  $("session-list").hidden = Boolean(sessionId); $("session-view").hidden = !sessionId;
  source?.close();
  source = new EventSource(`/api/events${sessionId ? `?session=${sessionId}` : ""}`);
  source.onopen = () => { $("connection").textContent = authentication === "tailscale" ? "tailscale" : "connected"; };
  source.onerror = () => { $("connection").textContent = "reconnecting…"; };
  source.addEventListener("sessions", (event) => renderSessions(JSON.parse(event.data)));
  source.addEventListener("state", (event) => renderState(JSON.parse(event.data)));
  source.addEventListener("offline", () => { online = false; busy = false; activity("offline", "offline"); $("live-panel").hidden = true; composeState(); });
  source.addEventListener("auth_required", () => { showLogin(); notice("Your login expired. Please sign in again."); });
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("login-button").disabled = true;
  const token = $("token").value.trim(); $("token").value = "";
  try { await api("/api/login", { method: "POST", body: JSON.stringify({ token }) }); notice(); connect(); }
  catch (error) { notice(error.message); }
  finally { $("login-button").disabled = false; }
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    entries.clear(); $("entries").replaceChildren(); initialized = false; oldest = null; lastSeen = 0;
    storePending(null); $("message").value = ""; $("mode").value = "reject"; showLogin(); notice();
  } catch (error) { notice(error.message); }
});
$("message").addEventListener("input", composeState);
$("mode").addEventListener("change", composeState);
$("message").addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat && !$("send").disabled) $("compose").requestSubmit($("send"));
});
$("compose").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!signedIn || !online || sending || idleOnlyBlocked() || (!pending && !$("message").value.trim())) return;
  if (!pending) storePending({ requestId: crypto.randomUUID(), content: $("message").value, mode: $("mode").value });
  sending = true; composeState(); notice();
  try {
    const result = await api(`${endpoint}/input`, { method: "POST", body: JSON.stringify(pending) });
    storePending(null); $("message").value = "";
    $("delivery").textContent = `Accepted · #${result.submissionId} · ${result.status}`;
    void refreshHistory();
  } catch (error) {
    if ([400, 409, 413, 415, 429].includes(error.status)) storePending(null); // These errors admitted nothing.
    notice(`${error.message}${pending ? " Your message is retained; retry uses the same request ID." : ""}`);
    $("delivery").textContent = pending ? "Unconfirmed delivery" : "Not sent";
  } finally { sending = false; composeState(); }
});
$("interrupt").addEventListener("click", async () => {
  if (!confirm("Interrupt foreground work and withdraw queued inputs? Existing file changes and background tasks will remain.")) return;
  $("interrupt").disabled = true;
  try { await api(`${endpoint}/interrupt`, { method: "POST", body: "{}" }); notice("Foreground work interrupted. File effects and background tasks are not undone."); }
  catch (error) { notice(`${error.message} Stop requests are not retried automatically; check the session before trying again.`); }
  finally { composeState(); }
});
$("older").addEventListener("click", async () => {
  if (!oldest || !hasOlder || !online) return;
  $("older").disabled = true;
  const pane = $("transcript"); const height = pane.scrollHeight; const top = pane.scrollTop;
  try {
    const page = await api(`${endpoint}/history?before=${oldest}`);
    growHistory = true; addEntries(page.entries); oldest = page.oldestId ?? oldest; hasOlder = page.hasMore;
    pane.scrollTop = top + pane.scrollHeight - height;
  } catch (error) { notice(error.message); }
  finally { $("older").disabled = !hasOlder; }
});
$("refresh").addEventListener("click", async () => {
  notice();
  try { renderState(await api(`${endpoint}/state`)); await refreshHistory(); } catch (error) { notice(error.message); }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && signedIn) void refreshHistory(); });
window.addEventListener("pagehide", () => source?.close());
window.addEventListener("pageshow", (event) => { if (event.persisted && signedIn) connect(); });

try { await api("/api/me"); connect(); } catch (error) { if (error.code !== "TAILSCALE_REQUIRED") showLogin(); if (error.status !== 401) notice(error.message); }
composeState();
