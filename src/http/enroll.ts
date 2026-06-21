/**
 * `POST /enroll` — device registration (`RMM/docs/09` §2).
 *
 * The agent sends its inventory and a stable `device_id`; the **server mints** the
 * device token and returns it along with the control-channel URL. Idempotent on
 * `device_id`, so reconnects/reinstalls reuse the same record.
 *
 * Enrollment is rate-limited per IP. If `ENROLL_TOKEN` is configured, a matching
 * `enroll_token` is required (a rogue host can no longer mint a device token); when it
 * is unset, enrollment stays open for backward compatibility.
 */

import { timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { config } from "../config";
import { clientIp } from "../ip";
import { logger } from "../log";
import * as registry from "../registry";
import { createRateLimiter } from "../auth/rate-limit";
import { publicBases } from "../urls";

/** 10 enrollments per IP per 10 minutes — generous for real reinstalls, hostile to
 *  registry-flooding. */
const enrollLimiter = createRateLimiter(10, 10 * 60_000);

/** Constant-time string compare that also guards against length leaks. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function enrollHandler(req: Request, res: Response): void {
  const ip = clientIp(req);
  const limit = enrollLimiter.hit(ip);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    res.status(429).json({ error: { code: "rate_limited", message: "too many enrollments" } });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const deviceId = String(body.device_id ?? "").trim();

  if (!deviceId) {
    res.status(400).json({
      error: { code: "bad_request", message: "device_id is required" },
    });
    return;
  }

  // Opt-in pre-shared token gate: enforced only when ENROLL_TOKEN is configured.
  if (config.enrollToken && !tokensMatch(String(body.enroll_token ?? ""), config.enrollToken)) {
    logger.warn(`enroll rejected (bad enroll_token) for "${deviceId}" from ${ip}`);
    res.status(401).json({ error: { code: "unauthorized", message: "invalid enroll token" } });
    return;
  }

  const device = registry.enroll(
    {
      device_id: deviceId,
      hostname: str(body.hostname, "unknown-host"),
      os: str(body.os, "unknown"),
      os_version: str(body.os_version, "unknown"),
      arch: str(body.arch, "unknown"),
      agent_version: str(body.agent_version, "unknown"),
    },
    ip,
  );

  const { wsBase } = publicBases(req);

  logger.info(
    `enroll: ${device.device_name} (${device.device_id}) from ${ip} — ${device.os}/${device.arch} agent ${device.agent_version}`,
  );

  res.json({
    device_token: device.device_token,
    control_url: `${wsBase}/agent/control`,
    heartbeat_interval: config.heartbeatInterval,
    tenant_id: device.tenant_id,
    device_name: device.device_name,
  });
}

/** Coerce an unknown body field to a trimmed string, falling back when empty. */
function str(value: unknown, fallback: string): string {
  const out = String(value ?? "").trim();
  return out === "" ? fallback : out;
}
