/**
 * Extract the real client IP — both for Express requests and raw WebSocket
 * upgrade requests.
 *
 * Behind a reverse proxy (EasyPanel/Traefik, nginx, Caddy) the TCP peer is the
 * proxy, so the genuine client address arrives in `X-Forwarded-For`. We trust that
 * header only when `TRUST_PROXY` is on (default), and otherwise fall back to the
 * socket peer. The IPv4-mapped IPv6 prefix (`::ffff:`) is stripped for readability.
 */

import type { IncomingMessage } from "http";
import { config } from "./config";

export function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(",")[0]?.trim();
    if (first) return normalize(first);
  }
  return normalize(req.socket.remoteAddress ?? "unknown");
}

function normalize(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}
