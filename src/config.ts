/**
 * Runtime configuration, read once from the environment.
 *
 * Everything has a working default so `npm start` runs with zero setup. For a VPS
 * deployment behind a TLS reverse proxy, set `PUBLIC_URL` (or just let the
 * X-Forwarded-* headers drive URL derivation — see {@link ./urls}).
 */

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

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: int("PORT", 4000),
  /** Explicit public base URL (e.g. https://rmm.example.com); empty = derive per request. */
  publicUrl: process.env.PUBLIC_URL ?? "",
  /** Trust X-Forwarded-Proto / X-Forwarded-Host (true behind nginx/Caddy). */
  trustProxy: bool("TRUST_PROXY", true),
  /** Heartbeat cadence handed to the agent, seconds. */
  heartbeatInterval: int("HEARTBEAT_INTERVAL", 25),
  /** Pairing TTL for a freshly minted session, seconds. */
  sessionTtl: int("SESSION_TTL", 60),
  /** Informational tenant id stamped on enrolled devices. */
  tenantId: process.env.TENANT_ID ?? "default",
} as const;
