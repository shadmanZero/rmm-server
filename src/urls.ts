/**
 * Derive the public HTTP and WebSocket base URLs the agent and browser should use.
 *
 * Priority:
 *  1. `PUBLIC_URL` env (explicit) — best for production.
 *  2. Request `X-Forwarded-Proto` / `X-Forwarded-Host` (behind a reverse proxy).
 *  3. The request's own scheme + `Host` header (direct/localhost).
 *
 * This is what makes the same build work on localhost (`ws://`) and on a VPS behind
 * nginx/TLS (`wss://`) with no code change.
 */

import type { IncomingMessage } from "http";
import { config } from "./config";

export interface PublicBases {
  /** e.g. `https://rmm.example.com` */
  httpBase: string;
  /** e.g. `wss://rmm.example.com` */
  wsBase: string;
}

export function publicBases(req: IncomingMessage): PublicBases {
  if (config.publicUrl) {
    const url = new URL(config.publicUrl);
    const wsScheme = url.protocol === "https:" ? "wss" : "ws";
    return {
      httpBase: `${url.protocol}//${url.host}`,
      wsBase: `${wsScheme}://${url.host}`,
    };
  }

  const forwardedProto = config.trustProxy
    ? firstHeader(req.headers["x-forwarded-proto"])
    : undefined;
  const proto =
    forwardedProto ?? ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");

  const forwardedHost = config.trustProxy
    ? firstHeader(req.headers["x-forwarded-host"])
    : undefined;
  const host = forwardedHost ?? req.headers.host ?? `localhost:${config.port}`;

  const wsScheme = proto === "https" ? "wss" : "ws";
  return { httpBase: `${proto}://${host}`, wsBase: `${wsScheme}://${host}` };
}

/** Take the first value of a possibly comma-joined / array-valued header. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw.split(",")[0]?.trim();
  return first ? first : undefined;
}
