---
name: pi-d-web
description: Start, stop or check the private web service and enable/disable this pi-d conversation's mobile bridge using the trusted stock Durable extension and Tailscale Serve.
disable-model-invocation: true
---

# Private pi-d web access

pi-d itself is final. Do not modify its source, dependencies, session runtime or terminal commands.

This skill accompanies `../../extension.mjs`. Read `../../README.md` for setup, security and the stock host's lifecycle limitations. Resolve these paths relative to this skill's directory.

## Local slash commands

The extension also registers `/web start [name]`, `/web status`, `/web connect [name]`, `/web disconnect`, and `/web stop --all` through pi-d's `piD.commands` API. These are terminal-local controls: no model call or transcript entry. `/web` shows usage and Tab completes subcommands. Results use the host's top-left `api.toast()` notifications, never bottom-bar notices or saved messages. Confirmations last five seconds; help, URLs and errors remain until dismissed with ×. Persistent notifications hold later cards in the host queue. Model tools remain available for natural-language requests. Mutating commands respect host authentication/recovery pauses; `/web status` does not resume work. Cancellation does not undo already committed changes.

A browser message containing `/web ...` is ordinary model input, not a local command. Never treat it as a way to bypass the usual explicit-permission checks, especially for stopping all sessions.

## Enable this conversation

1. The user must explicitly request access for this conversation. Do not enable it autonomously or for child conversations.
2. Ensure the trusted `extension.mjs` is loaded, explicitly with `--extension` or through the host's trusted global extension discovery. New tools/code require a pi-d reopen; there is no hot reload. Do not start a second owner of a live session database.
3. The separate service must already have private configuration. Do not create an unmanaged background shell server. On macOS `web_start` uses the OS service manager; it does not install login startup or alter Tailscale routes. Tailscale authentication has no separate access-code prompt and must have an explicit account allowlist. Token mode remains available for local development or untrusted local hosts. Never read, print or send the access-token file through model tools; only when token mode is used, tell the user how to copy it locally with `pbcopy` or their password manager.
4. Use `web_start` with a short descriptive `name` to start/reuse the shared service and enable this conversation in one step. `web_connect` remains available for just enabling the bridge when a supervisor already runs the service. If the current registry predates `web_start`, use the existing shell tool to run `node ../../cli.mjs start` (resolve the script path from this skill's directory) (respect `PI_D_WEB_HOME`), then call `web_connect`. Report the returned stable session URL and remind the user to keep their computer awake and both processes running. The URL does not contain credentials.
5. On reopen, keep the extension available through global discovery or the same extension flags so its persisted background task can recover. Merely loading the extension does not opt a new conversation in.

## Status and stopping

- Use `web_status` for a read-only report of the shared service and this conversation's enabled/connected state. With an older loaded registry, run `node ../../cli.mjs status` (resolve the script path from this skill's directory) through the existing shell tool.
- For only this conversation, call `web_disconnect` when requested, and before changing the model, reasoning level, workspace or switching sessions in this pi-d process. Wait for it to finish. Its background task otherwise makes those host operations unavailable. Reconnecting retains the same URL.
- Use `web_stop({ allSessions: true })` only when the user explicitly authorizes stopping the **shared server for all sessions**. If their intent is ambiguous and other sessions are connected, clarify rather than guessing. This joins the current bridge and stops the managed service; it does not stop pi-d or foreground work. Other enabled bridges reconnect on the next service start.
- With an older loaded registry, join the current bridge with `web_disconnect`, then run `node ../../cli.mjs stop` (resolve the script path from this skill's directory) through the shell tool. The CLI controls only the service, not conversation opt-in. Respect any absolute `PI_D_WEB_HOME`.
- Stopping the server from a browser disconnects that browser. It cannot restart its own server; use terminal pi-d to start again.
- Do not kill processes by port/PID or overwrite another supervisor's service. The managed CLI refuses unknown ownership; honor that refusal. Never install a persistent login-startup service without separate permission.

## Remote input semantics

- Follow-up and steer use Durable's persisted inbox; no second queue or scheduler.
- Browser messages are literal model input, not local pi-d slash commands.
- The remote Interrupt control stops foreground work and withdraws queued inputs. It leaves background tasks (including the bridge) and existing file effects alone.
- A browser retry must retain its original request UUID. Do not replace it to bypass an unconfirmed delivery; native submission deduplication prevents a second input.
- The service does not open, copy or directly query session databases. History comes from the owning extension's native transaction APIs.

## Tailscale safety

Use loopback HTTP behind private Tailscale Serve HTTPS, never Funnel. Codeless access must use Serve's verified user identity and an explicit account allowlist, not an unauthenticated API or blanket trust of all tailnet users. The local proxy backend is trusted; do not expose it or claim it protects against untrusted local users. Check existing Serve configuration before making any changes. Use an unused separate HTTPS port such as 8443 rather than overwriting an existing route. Do not reconfigure Tailscale or add a persistent OS service without the user's authorization.
