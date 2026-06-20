/**
 * `POST /enroll` — zero-touch device registration (`RMM/docs/09` §2).
 *
 * The agent sends its inventory and a stable `device_id`; the **server mints** the
 * device token and returns it along with the control-channel URL. There is no
 * pre-shared enroll-token check in this MVP (the brief is explicitly "no auth"):
 * the agent touches nothing, just hits this endpoint and gets a token back.
 * Idempotent on `device_id`, so reconnects/reinstalls reuse the same record.
 */

import type { Request, Response } from "express";
import { config } from "../config";
import { clientIp } from "../ip";
import { logger } from "../log";
import * as registry from "../registry";
import { publicBases } from "../urls";

export function enrollHandler(req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const deviceId = String(body.device_id ?? "").trim();

  if (!deviceId) {
    res.status(400).json({
      error: { code: "bad_request", message: "device_id is required" },
    });
    return;
  }

  const ip = clientIp(req);
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
