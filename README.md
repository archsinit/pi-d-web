# pi-d-web

A lightweight, private web interface for existing **pi-d** conversations. Follow sessions from your phone, send messages, and interrupt work without leaving your browser.

- Live messages, thinking, tool output, and earlier history.
- One stable URL per conversation, with explicit opt-in.
- Private HTTPS through Tailscale Serve and an account allowlist.
- No runtime dependencies or duplicate transcript database.

## Requirements

Node.js **22.19+**, a POSIX host, pi-d with its pinned **Durable 1.2.0** SDK, and Tailscale. Managed service start/stop supports **macOS**; other POSIX systems can run the service in the foreground.

## Setup

```sh
git clone https://github.com/archsinit/pi-d-web.git
cd pi-d-web

# Replace these examples with your Tailscale hostname and login identity.
node cli.mjs init --origin https://device.tailnet.ts.net:8443 \
  --auth tailscale --allow-user you@example.com

# Install the trusted extension for automatic loading.
install -d -m 700 "$HOME/.config/pi-d"
mkdir -p "$HOME/.config/pi-d/extensions"
ln -s "$PWD/extension.mjs" "$HOME/.config/pi-d/extensions/pi-d-web.mjs"
```

No `npm install` is needed. If pi-d uses an absolute `XDG_CONFIG_HOME`, install the extension under `$XDG_CONFIG_HOME/pi-d/extensions/` instead.

Check existing Tailscale routes before adding a listener:

```sh
tailscale serve status
# Run only if HTTPS port 8443 is unused. Preserve existing routes.
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

Use **Serve, never Funnel**. Tailscale authentication checks the configured account allowlist; there is no separate browser access code.

Restart pi-d and ask: **“Start web access for this session.”** Open the returned URL. Each conversation must be connected separately.

## Usage

| Ask pi-d | Tool |
| --- | --- |
| Start web access | `web_start` |
| Check web status | `web_status` |
| Disconnect this session | `web_disconnect` |
| Stop the web server for all sessions | `web_stop` |

On macOS, the CLI also provides `node cli.mjs start`, `status`, and `stop`. The service survives closing a terminal, but does not start automatically after login or reboot. On other POSIX systems, run `node cli.mjs serve` in a separate terminal and use `web_connect` to connect the conversation.

The browser supports idle-only messages, follow-ups, steering, and interruption. **Enter** sends; **Shift+Enter** inserts a newline.

## Important notes

- Keep the host awake and both pi-d and the web service running. Offline session history is unavailable.
- Disconnect the bridge before changing models, settings, or sessions in the same pi-d process. Restart pi-d after extension updates; there is no hot reload.
- Remote messages have the same permissions as local pi-d input: **there is no sandbox**. Only allow trusted accounts.
- HTTP binds only to `127.0.0.1:8787`. Tailscale mode trusts the local Serve proxy; do not use it on an untrusted multi-user host or expose the backend directly.
- Private configuration lives in `~/.config/pi-d-web/`. An absolute `PI_D_WEB_HOME` overrides it; use the same value for the service and pi-d. Never publish configuration, access tokens, or session databases.

## Development

```sh
npm run check
npm test
```

Tests use faux models and temporary stores, never live credentials or user sessions. They expect a pi-d checkout with its dependencies installed at `../pi-d`; set `PI_D_ROOT` to use another location. Browser tests use Chromium when available.
