/**
 * `POST /sessions` — start a Connect, and a couple of small admin helpers.
 *
 * When the frontend clicks Connect, the broker (this handler) mints a session +
 * single-use token, signals the agent over the control channel with `start_session`,
 * and hands the browser back a `viewer_ws_url` to point noVNC at (`RMM/docs/09` §4).
 * Both sides then meet on `/relay/<session_id>`.
 */

import type { Request, Response } from "express";
import { clientIp } from "../ip";
import { logger } from "../log";
import * as registry from "../registry";
import { sendToAgent } from "../ws/control";
import { publicBases } from "../urls";

export function createSessionHandler(req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const deviceId = String(body.device_id ?? "").trim();
  const viewOnly = body.view_only === true;

  if (!deviceId) {
    res.status(400).json({ error: { code: "bad_request", message: "device_id is required" } });
    return;
  }

  const device = registry.deviceById(deviceId);
  if (!device) {
    res.status(404).json({ error: { code: "device_not_found", message: "no such device" } });
    return;
  }
  if (!device.online || !device.control) {
    res.status(409).json({ error: { code: "device_offline", message: "device is offline" } });
    return;
  }

  const session = registry.createSession(device, viewOnly);
  const { wsBase } = publicBases(req);

  // Tell the agent to dial the relay (it appends ?token=...&role=agent itself).
  const relayUrl = `${wsBase}/relay/${session.session_id}`;
  const delivered = sendToAgent(device, {
    type: "start_session",
    session_id: session.session_id,
    relay_url: relayUrl,
    session_token: session.session_token,
    view_only: session.view_only,
  });

  if (!delivered) {
    registry.deleteSession(session.session_id);
    res.status(409).json({ error: { code: "device_offline", message: "control channel not writable" } });
    return;
  }

  device.active_session = true;
  logger.info(
    `session ${session.session_id} → ${device.device_name} for viewer ${clientIp(req)} (view_only=${session.view_only})`,
  );

  // The browser points noVNC here; token + role embedded, single-use.
  const viewerWsUrl =
    `${wsBase}/relay/${session.session_id}` +
    `?token=${encodeURIComponent(session.session_token)}&role=viewer`;

  res.json({
    session_id: session.session_id,
    viewer_ws_url: viewerWsUrl,
    expires_in: Math.max(0, Math.round((session.expires_at - Date.now()) / 1000)),
  });
}

/** `POST /api/devices/:deviceId/disconnect` — ask the agent to end its session. */
export function disconnectHandler(req: Request, res: Response): void {
  const deviceId = String(req.params.deviceId ?? "").trim();
  const device = registry.deviceById(deviceId);
  if (!device) {
    res.status(404).json({ error: { code: "device_not_found", message: "no such device" } });
    return;
  }
  if (device.online && device.control) {
    sendToAgent(device, { type: "stop_session", session_id: "*" });
  }
  device.active_session = false;
  res.json({ ok: true });
}
