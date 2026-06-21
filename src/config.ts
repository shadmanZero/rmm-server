/**
 * Runtime configuration, read once from the environment.
 *
 * Operational knobs keep working defaults so the control-plane plumbing runs with
 * minimal setup. The two things that have **no** safe default — the database URL and
 * the session signing secret — are required and validated here, so the process fails
 * fast and loudly rather than starting up half-configured.
 */

import "dotenv/config";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

function required(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${name} is required — set it in .env (see .env.example).`);
  }
  return raw.trim();
}

const publicUrl = process.env.PUBLIC_URL ?? "";

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: int("PORT", 4000),
  /** Explicit public base URL (e.g. https://rmm.example.com); empty = derive per request. */
  publicUrl,
  /** Trust X-Forwarded-Proto / X-Forwarded-Host (true behind nginx/Caddy). */
  trustProxy: bool("TRUST_PROXY", true),
  /** Heartbeat cadence handed to the agent, seconds. */
  heartbeatInterval: int("HEARTBEAT_INTERVAL", 25),
  /** Pairing TTL for a freshly minted session, seconds. */
  sessionTtl: int("SESSION_TTL", 60),
  /** Informational tenant id stamped on enrolled devices. */
  tenantId: process.env.TENANT_ID ?? "default",
  /**
   * Optional pre-shared enrollment token. When set, `POST /enroll` requires a matching
   * `enroll_token` (closing the open-enrollment hole); when empty, enrollment stays
   * zero-touch/open so existing deployments keep working until a token is provisioned.
   */
  enrollToken: process.env.ENROLL_TOKEN ?? "",

  /** Postgres connection string used by Drizzle; required. */
  databaseUrl: required("DATABASE_URL"),

  /** Dashboard authentication. */
  auth: {
    /** HMAC key for signing session cookies; required (rotating it logs everyone out). */
    sessionSecret: required("SESSION_SECRET"),
    /** How long a login stays valid, hours. */
    sessionTtlHours: int("SESSION_TTL_HOURS", 168),
    /** Set the `Secure` cookie flag. Defaults on when the public URL is HTTPS. */
    cookieSecure: bool("AUTH_COOKIE_SECURE", publicUrl.startsWith("https")),
    /** Seed admin, applied by `npm run db:seed`. */
    admin: {
      name: process.env.AUTH_ADMIN_NAME ?? "shadmanZero",
      username: (process.env.AUTH_ADMIN_USERNAME ?? "shadmanzero").toLowerCase(),
      password: process.env.AUTH_ADMIN_PASSWORD ?? "",
    },
  },
} as const;
