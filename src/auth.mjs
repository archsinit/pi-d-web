import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const COOKIE_NAME = "pi_d_web";
const TTL_SECONDS = 12 * 60 * 60;
const digest = (text) => createHash("sha256").update(text).digest();
export const equalSecret = (a, b) => typeof a === "string" && typeof b === "string" && timingSafeEqual(digest(a), digest(b));
const signature = (token, payload) => createHmac("sha256", token).update(payload).digest("base64url");

export function issueCookie(token, secure, now = Date.now()) {
  const payload = `${Math.floor(now / 1000) + TTL_SECONDS}.${randomBytes(16).toString("base64url")}`;
  return `${COOKIE_NAME}=${payload}.${signature(token, payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function authorized(cookieHeader, token, now = Date.now()) {
  if (typeof cookieHeader !== "string") return false;
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return false;
  const parts = cookie.slice(COOKIE_NAME.length + 1).split(".");
  if (parts.length !== 3 || !/^\d{10}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{22}$/.test(parts[1])) return false;
  const expires = Number(parts[0]);
  const seconds = Math.floor(now / 1000);
  return expires > seconds && expires <= seconds + TTL_SECONDS && equalSecret(parts[2], signature(token, `${parts[0]}.${parts[1]}`));
}

export function clearCookie(secure) {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function validateAuthentication(value, origin) {
  if (value === undefined) return { mode: "token" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Authentication must be a configuration object.");
  if (value.mode === "token") {
    if (value.allowedUsers !== undefined) throw new Error("An account allowlist requires Tailscale authentication.");
    return { mode: "token" };
  }
  if (value.mode !== "tailscale") throw new Error("Authentication mode must be token or tailscale.");
  const url = new URL(origin);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".ts.net") || url.origin !== origin) throw new Error("Tailscale authentication requires a bare HTTPS .ts.net origin.");
  if (!Array.isArray(value.allowedUsers) || value.allowedUsers.length < 1 || value.allowedUsers.length > 16
    || value.allowedUsers.some((user) => typeof user !== "string" || !/^[\x21-\x7e]{1,254}$/.test(user))) throw new Error("Tailscale authentication requires an explicit account allowlist (allowedUsers).");
  return { mode: "tailscale", allowedUsers: [...new Set(value.allowedUsers.map((user) => user.toLowerCase()))] };
}

export function tailscaleAuthorized(request, authentication, origin) {
  // Trust only the loopback Serve proxy, never identity headers on a public listener.
  // Serve strips client-supplied identity headers and supplies its own verified login.
  const headers = request.headers;
  const host = new URL(origin).host.toLowerCase();
  const login = headers["tailscale-user-login"];
  const ip = headers["x-forwarded-for"];
  if (request.socket.remoteAddress !== "127.0.0.1"
    || headers["x-forwarded-host"]?.toLowerCase() !== host || headers["x-forwarded-proto"] !== "https"
    || headers["tailscale-funnel-request"] !== undefined || typeof login !== "string" || typeof ip !== "string") return false;
  const family = isIP(ip);
  const [first, second] = family === 4 ? ip.split(".").map(Number) : [];
  const tailnetIP = family === 4 ? first === 100 && second >= 64 && second < 128 : family === 6 && ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
  return tailnetIP && authentication.allowedUsers.includes(login.toLowerCase());
}
