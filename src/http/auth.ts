/**
 * Authentication endpoints for the dashboard.
 *
 *   POST /auth/login   { username, password }  → sets the session cookie
 *   POST /auth/logout                          → destroys the session + clears cookie
 *   GET  /auth/me                              → the signed-in identity (or 401)
 *
 * Login failures are deliberately indistinguishable (same status + message whether
 * the username is unknown or the password is wrong) so the endpoint can't be used to
 * enumerate accounts, and they are rate-limited per client IP.
 */

import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../db/schema";
import { clientIp } from "../ip";
import { logger } from "../log";
import { verifyPassword } from "../auth/password";
import { createSession, destroySession } from "../auth/sessions";
import { setSessionCookie, clearSessionCookie } from "../auth/cookies";
import { createRateLimiter } from "../auth/rate-limit";

/** 10 attempts per IP per 5 minutes — generous for humans, hostile to brute force. */
const loginLimiter = createRateLimiter(10, 5 * 60_000);

const INVALID = { code: "invalid_credentials", message: "invalid username or password" };

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const ip = clientIp(req);
  const limit = loginLimiter.hit(ip);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    res.status(429).json({
      error: { code: "rate_limited", message: "too many attempts, try again later" },
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  if (!username || !password) {
    res.status(400).json({
      error: { code: "bad_request", message: "username and password are required" },
    });
    return;
  }

  const found = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const user = found[0];

  // Always run a verify (against a real or, if absent, a throwaway hash) so the
  // response time doesn't betray whether the username exists.
  const hash = user?.passwordHash ?? DUMMY_HASH;
  const ok = await verifyPassword(password, hash);

  if (!user || !ok) {
    logger.warn(`login failed for "${username}" from ${ip}`);
    res.status(401).json({ error: INVALID });
    return;
  }

  const session = await createSession(user.id);
  setSessionCookie(res, session.id, session.expiresAt);
  logger.info(`login: ${user.name} (${user.username}) from ${ip}`);
  res.json({ ok: true, user: { username: user.username, name: user.name } });
}

export async function logoutHandler(req: Request, res: Response): Promise<void> {
  if (req.auth) await destroySession(req.auth.sessionId);
  clearSessionCookie(res);
  res.json({ ok: true });
}

export function meHandler(req: Request, res: Response): void {
  if (!req.auth) {
    res.status(401).json({ error: { code: "unauthorized", message: "not signed in" } });
    return;
  }
  res.json({ user: { username: req.auth.user.username, name: req.auth.user.name } });
}

/**
 * A precomputed scrypt hash of a random string. Verifying against it for unknown
 * usernames costs the same as a real check, equalizing timing. (It never matches.)
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$0123456789abcdef0123456789abcdef$" +
  "b9c2f3a4d5e6f7081928374655647382b9c2f3a4d5e6f7081928374655647382" +
  "b9c2f3a4d5e6f7081928374655647382b9c2f3a4d5e6f7081928374655647382";
