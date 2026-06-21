/**
 * Server-side login sessions, backed by the `auth_sessions` table.
 *
 * A login row is the source of truth: the browser only holds the opaque, signed id.
 * Validation joins back to `users` so the request carries a fresh identity, and any
 * lookup that finds an expired row deletes it lazily. A periodic prune keeps the
 * table from accumulating dead rows from browsers that never logged out.
 */

import { randomBytes } from "crypto";
import { eq, lt } from "drizzle-orm";
import { db } from "../db/client";
import { authSessions, users } from "../db/schema";
import { config } from "../config";

/** The authenticated identity attached to a request. */
export interface AuthUser {
  id: string;
  username: string;
  name: string;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
}

const newSessionId = (): string => `sk_${randomBytes(24).toString("hex")}`;

export interface CreatedSession {
  id: string;
  expiresAt: Date;
}

/** Mint a fresh session for a user and persist it. */
export async function createSession(userId: string): Promise<CreatedSession> {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlHours * 3_600_000);
  await db.insert(authSessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

/** Resolve a session id to its user, or `null` if missing/expired. */
export async function validateSession(sessionId: string): Promise<AuthContext | null> {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      expiresAt: authSessions.expiresAt,
    })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(eq(authSessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await destroySession(sessionId);
    return null;
  }

  return {
    sessionId,
    user: { id: row.id, username: row.username, name: row.name },
  };
}

/** Delete a single session (logout). */
export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.id, sessionId));
}

/** Drop every expired session; returns how many were removed. */
export async function pruneExpiredSessions(): Promise<number> {
  const removed = await db
    .delete(authSessions)
    .where(lt(authSessions.expiresAt, new Date()))
    .returning({ id: authSessions.id });
  return removed.length;
}
