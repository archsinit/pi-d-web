import { constants } from "node:fs";
import { chmod, mkdir, open, rename, lstat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { validateAuthentication } from "./auth.mjs";

export function defaultHome(env = process.env) {
  if (env.PI_D_WEB_HOME) {
    if (!isAbsolute(env.PI_D_WEB_HOME)) throw new Error("PI_D_WEB_HOME must be absolute.");
    return env.PI_D_WEB_HOME;
  }
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(base, "pi-d-web");
}

export function socketPath(home) {
  const path = join(home, "bridge.sock");
  if (Buffer.byteLength(path) > 100) throw new Error("PI_D_WEB_HOME is too long for a Unix socket; use a shorter private path.");
  return path;
}

export async function privateDirectory(home) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error(`Use an account-owned, non-symlink directory with mode 700: ${home}`);
  }
}

export async function readPrivate(path) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 65536) {
      throw new Error(`Expected a private, account-owned file with mode 600: ${path}`);
    }
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

export function validateSettings(value) {
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error("Port must be between 1024 and 65535.");
  const origin = new URL(value.origin);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Origin must be a bare HTTP(S) origin, without a path or credentials.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) throw new Error("Remote access requires an HTTPS origin (use Tailscale Serve).");
  const authentication = validateAuthentication(value.authentication, origin.origin);
  return { port: value.port, origin: origin.origin, ...(value.authentication === undefined ? {} : { authentication }) };
}

export async function readSettings(home = defaultHome()) {
  return validateSettings(JSON.parse(await readPrivate(join(home, "config.json"))));
}

export async function readToken(home = defaultHome()) {
  const token = (await readPrivate(join(home, "access-token"))).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid access token file; expected a generated 32-byte token.");
  return token;
}

export async function initialize(home = defaultHome(), options = {}) {
  await privateDirectory(home);
  socketPath(home);
  let previous;
  try { previous = await readSettings(home); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const port = options.port ?? previous?.port ?? 8787;
  const settings = validateSettings({ port, origin: options.origin ?? previous?.origin ?? `http://127.0.0.1:${port}`,
    authentication: options.authentication === undefined ? previous?.authentication : options.authentication });
  const tokenPath = join(home, "access-token");
  if (settings.authentication?.mode !== "tailscale") {
    try {
      const file = await open(tokenPath, "wx", 0o600);
      try { await file.writeFile(`${randomBytes(32).toString("base64url")}\n`); } finally { await file.close(); }
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    await readToken(home);
  }
  const temporary = join(home, `config.${randomBytes(8).toString("hex")}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
    await file.close();
    await rename(temporary, join(home, "config.json"));
  } finally { await file.close(); await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  await chmod(join(home, "config.json"), 0o600);
  return { ...settings, home, tokenPath };
}
