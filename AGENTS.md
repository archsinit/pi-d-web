# pi-d-web

This is a separate, explicitly trusted Durable extension and its companion web service.
Never modify the sibling `pi-d` checkout to implement features here.

- Node.js 22.19+; use built-in modules and browser APIs, with no runtime dependencies.
- Extensions use stock pi-durable 1.2.0, not Pi's ExtensionAPI.
- No sockets, processes, watchers or timers at extension module scope. Own them in a native background task and clean them up on cancellation.
- Do not open a session database from the web service. Use the owning extension's native conversation/transaction APIs.
- Keep the HTTP listener on 127.0.0.1. Tailscale Serve supplies private HTTPS; do not use Funnel or overwrite existing Serve routes.
- Never print access tokens or include them in URLs, logs, tests or source.
- Use `npm run check` and `npm test`. Integration tests use temporary stores and the sibling host's pinned SDK (`PI_D_ROOT` can override its location).
- Test with faux models, never live credentials or user sessions.
