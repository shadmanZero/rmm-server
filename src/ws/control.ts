/**
 * `WSS /agent/control` — the persistent control channel (`RMM/docs/06` §5, `09` §3).
 *
 * Auth is the device token as `Authorization: Bearer <token>`, validated at the
 * WebSocket upgrade. While the socket is open the device is ONLINE; on close it goes
 * OFFLINE. The agent sends `hello` then `heartbeat`s and session acks; the server
 * pushes `start_session` / `stop_session` / `ping` down the same socket.
 */

import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import { clientIp } from "../ip";
import { logger } from "../log";
import * as registry from "../registry";
import type { Device } from "../registry";

const wss = new WebSocketServer({ noServer: true });

/** Messages the server sends down to an agent (`RMM/docs/09` §3.2). */
export type ServerToAgent =
  | {
      type: "start_session";
      session_id: string;
      relay_url: string;
      session_token: string;
      view_only: boolean;
    }
  | { type: "stop_session"; session_id: string }
  | { type: "set_privacy"; enable: boolean }
  | { type: "rotate_token"; device_token: string }
  | { type: "config"; heartbeat_interval?: number; default_view_only?: boolean }
  | { type: "ping" };

/** Validate the bearer token at upgrade time, then hand off to the WS server. */
export function handleControlUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const device = token ? registry.deviceByToken(token) : undefined;

  if (!device) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const ip = clientIp(req);
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, device, ip));
}

function onConnection(ws: WebSocket, device: Device, ip: string): void {
  // A reconnect supersedes any stale socket for the same device.
  if (device.control && device.control !== ws) {
    try {
      device.control.close();
    } catch {
      /* ignore */
    }
  }
  registry.setOnline(device, ws, ip);
  logger.info(`device ONLINE: ${device.device_name} (${device.device_id}) from ${ip}`);

  ws.on("message", (data) => handleMessage(device, data.toString()));
  ws.on("close", () => {
    // Only flip offline if this is still the device's current socket.
    if (device.control === ws) {
      registry.setOffline(device);
      logger.info(`device OFFLINE: ${device.device_name} (${device.device_id})`);
    }
  });
  ws.on("error", (err) => logger.warn(`control error ${device.device_id}: ${err.message}`));
}

function handleMessage(device: Device, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    logger.warn(`control: unparseable message from ${device.device_id}`);
    return;
  }

  device.last_seen = Date.now();

  switch (msg.type) {
    case "hello":
      logger.info(
        `hello from ${device.device_id}: agent ${String(msg.agent_version ?? "?")} caps=${JSON.stringify(msg.capabilities ?? [])}`,
      );
      break;
    case "heartbeat": {
      device.active_session = msg.active_session === true;
      const metrics = msg.metrics as { fps?: number; kbps?: number } | undefined;
      if (metrics) {
        device.metrics = { fps: Number(metrics.fps ?? 0), kbps: Number(metrics.kbps ?? 0) };
      }
      break;
    }
    case "session_ready":
      logger.info(`session_ready ${String(msg.session_id ?? "?")} on ${device.device_id}`);
      break;
    case "session_failed":
      device.active_session = false;
      logger.warn(
        `session_failed ${String(msg.session_id ?? "?")} on ${device.device_id}: ${String(msg.reason ?? "?")}`,
      );
      break;
    case "pong":
      break;
    default:
      // Forward-compat: ignore unknown agent message types.
      break;
  }
}

/** Send a server→agent message. Returns false if the device has no live socket. */
export function sendToAgent(device: Device, message: ServerToAgent): boolean {
  const ws = device.control;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (err) {
    logger.warn(`control send to ${device.device_id} failed: ${(err as Error).message}`);
    return false;
  }
}
