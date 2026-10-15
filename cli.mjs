#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join } from "node:path";
import { defaultHome, initialize, readSettings, readToken, socketPath } from "./src/config.mjs";
import { startWebServer } from "./src/server.mjs";
import { serviceStatus, startService, stopService } from "./src/service.mjs";

const HELP = `pi-d-web — private mobile access to opt-in pi-d sessions

  node cli.mjs init [--origin https://device.tailnet.ts.net:8443] [--port 8787]
                   [--auth tailscale --allow-user LOGIN] [--auth token]
  node cli.mjs start | stop | status   # managed macOS service; no login-startup install
  node cli.mjs serve                   # foreground/manual supervisor
  node cli.mjs paths

Configuration: ~/.config/pi-d-web (or absolute PI_D_WEB_HOME).
The HTTP listener always binds to 127.0.0.1. Use Tailscale Serve, not Funnel.
Tailscale authentication removes the code prompt and requires an account allowlist.
Token mode remains available; secrets are never printed or embedded in URLs.
See README.md for extension activation and existing Tailscale route safety.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, origin: { type: "string" }, port: { type: "string" },
    auth: { type: "string" }, "allow-user": { type: "string", multiple: true },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(HELP); return; }
  if (positionals.length !== 1) throw new Error("Expected one command. Use --help.");
  const home = defaultHome();
  if (command !== "init" && (values.origin !== undefined || values.port !== undefined || values.auth !== undefined || values["allow-user"] !== undefined)) throw new Error("Use init to change configuration.");
  if (values["allow-user"] !== undefined && values.auth !== "tailscale") throw new Error("Use --auth tailscale with --allow-user.");
  if (command === "init") {
    const authentication = values.auth === undefined ? undefined : { mode: values.auth, ...(values["allow-user"] === undefined ? {} : { allowedUsers: values["allow-user"] }) };
    const settings = await initialize(home, { origin: values.origin, port: values.port === undefined ? undefined : Number(values.port), authentication });
    const access = settings.authentication?.mode === "tailscale" ? `Authentication: Tailscale Serve; allowed accounts: ${settings.authentication.allowedUsers.join(", ")}\nNo browser access code is required.` : `Private access-token file: ${settings.tokenPath}\nExisting tokens are preserved.`;
    console.log(`Configuration ready: ${home}\n${access}\nBrowser address: ${settings.origin}\nLocal HTTP: http://127.0.0.1:${settings.port}\nNo service or Tailscale route was started.`);
  } else if (command === "paths") {
    console.log(`Configuration: ${join(home, "config.json")}\nAccess token: ${join(home, "access-token")}\nPrivate bridge socket: ${socketPath(home)}`);
  } else if (["start", "stop", "status"].includes(command)) {
    const action = { start: startService, stop: stopService, status: serviceStatus }[command];
    console.log(JSON.stringify(await action(home), null, 2));
  } else if (command === "serve") {
    const settings = await readSettings(home);
    const token = settings.authentication?.mode === "tailscale" ? undefined : await readToken(home);
    const server = await startWebServer({ home, token, ...settings });
    console.log(`pi-d-web listening on 127.0.0.1:${server.port}\nBrowser address: ${server.origin}\nPress Ctrl+C to stop. No transcript copies are stored by this service.`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try { await server.close(); } catch { process.exitCode = 1; console.error("Service cleanup failed."); }
    };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  } else throw new Error(`Unknown command: ${command}. Use --help.`);
}

main().catch((error) => { console.error(`pi-d-web: ${error.message}`); process.exitCode = 1; });
