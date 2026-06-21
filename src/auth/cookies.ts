/**
 * Session cookie plumbing — minimal, fully-typed, no third-party cookie lib.
 *
 * The cookie value is the opaque session id, HMAC-signed with `SESSION_SECRET` so a
 * tampered or forged cookie is rejected before any database lookup. The cookie is
 * `HttpOnly` (no JS access), `SameSite=Lax` (sent on top-level navigations, blocks
 * CSRF on cross-site POSTs), and `Secure` when the deployment is served over HTTPS.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { Response } from "express";
import { config } from "../config";

export const COOKIE_NAME = "rk_session";

/** Sign `value` → `value.signature` (base64url HMAC-SHA256). */
function sign(value: string): string {
  const mac = createHmac("sha256", config.auth.sessionSecret).update(value).digest("base64url");
  return `${value}.${mac}`;
}

/** Verify a signed cookie value, returning the original id or `null` if invalid. */
function unsign(signed: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  const expected = createHmac("sha256", config.auth.sessionSecret)
    .update(value)
    .digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}

/** Pull the (verified) session id out of a request's `Cookie` header. */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const raw = decodeURIComponent(pair.slice(eq + 1).trim());
    return unsign(raw);
  }
  return null;
}

function serialize(value: string, maxAgeSeconds: number): string {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  if (config.auth.cookieSecure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Attach a signed session cookie that expires alongside the server-side session. */
export function setSessionCookie(res: Response, sessionId: string, expiresAt: Date): void {
  const maxAge = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000));
  res.append("Set-Cookie", serialize(sign(sessionId), maxAge));
}

/** Clear the session cookie (logout / invalid session). */
export function clearSessionCookie(res: Response): void {
  res.append("Set-Cookie", serialize("", 0));
}
