/**
 * In-memory registry of devices and live sessions.
 *
 * This MVP keeps everything in process memory — no database, no auth (per the brief:
 * "zero-touch, no authentication"). A device record is created the first time an
 * agent enrolls and reused on every re-enroll (idempotent on `device_id`, exactly as
 * `RMM/docs/06` §2 specifies). Live WebSocket handles (control socket, relay sockets)
 * are attached to these records but never serialized to clients.
 *
 * Restarting the server forgets devices; agents simply re-enroll on their next
 * reconnect and reappear. That's an acceptable trade for the MVP.
 */

import type { WebSocket } from "ws";
import { config } from "./config";
import { newDeviceToken, newSessionId, newSessionToken, newTenantId } from "./ids";

/** Hardware / inventory facts an agent reports at enrollment. */
export interface DeviceInfo {
  device_id: string;
  hostname: string;
  os: string;
  os_version: string;
  arch: string;
  agent_version: string;
}

/** A registered device and its live presence. */
export interface Device extends DeviceInfo {
  device_token: string;
  device_name: string;
  tenant_id: string;
  online: boolean;
  last_seen: number;
  enrolled_at: number;
  active_session: boolean;
  metrics: { fps: number; kbps: number };
  /** Most recent client IP seen (enroll or control channel). */
  last_ip: string;
  /** Live control-channel socket while ONLINE (never serialized). */
  control?: WebSocket;
}

/** A pairing between one agent and one viewer over the relay. */
export interface Session {
  session_id: string;
  device_id: string;
  session_token: string;
  view_only: boolean;
  created_at: number;
  expires_at: number;
  paired: boolean;
  agent?: WebSocket;
  viewer?: WebSocket;
  /** Bytes buffered for the viewer that arrived before it connected. */
  bufferToViewer: Buffer[];
  /** Bytes buffered for the agent that arrived before it connected. */
  bufferToAgent: Buffer[];
}

/** The client-safe projection of a device (no token, no sockets). */
export interface DeviceView {
  device_id: string;
  device_name: string;
  hostname: string;
  os: string;
  os_version: string;
  arch: string;
  agent_version: string;
  tenant_id: string;
  online: boolean;
  active_session: boolean;
  last_seen: number;
  enrolled_at: number;
  last_ip: string;
}

const devicesById = new Map<string, Device>();
const devicesByToken = new Map<string, Device>();
const sessionsById = new Map<string, Session>();

/**
 * Create or refresh a device record for an enrolling agent. Idempotent on
 * `device_id`: re-enrolling keeps the same record and device token.
 */
export function enroll(info: DeviceInfo, ip: string): Device {
  const existing = devicesById.get(info.device_id);
  const now = Date.now();

  if (existing) {
    existing.hostname = info.hostname;
    existing.os = info.os;
    existing.os_version = info.os_version;
    existing.arch = info.arch;
    existing.agent_version = info.agent_version;
    existing.device_name = info.hostname || existing.device_name;
    existing.last_seen = now;
    existing.last_ip = ip;
    return existing;
  }

  const device: Device = {
    ...info,
    device_token: newDeviceToken(),
    device_name: info.hostname || info.device_id,
    tenant_id: config.tenantId || newTenantId(),
    online: false,
    last_seen: now,
    enrolled_at: now,
    active_session: false,
    metrics: { fps: 0, kbps: 0 },
    last_ip: ip,
  };
  devicesById.set(device.device_id, device);
  devicesByToken.set(device.device_token, device);
  return device;
}

export function deviceByToken(token: string): Device | undefined {
  return devicesByToken.get(token);
}

export function deviceById(id: string): Device | undefined {
  return devicesById.get(id);
}

/** All devices, newest-enrolled first, as client-safe views. */
export function listDevices(): DeviceView[] {
  return [...devicesById.values()]
    .sort((a, b) => b.enrolled_at - a.enrolled_at)
    .map(toView);
}

export function toView(device: Device): DeviceView {
  return {
    device_id: device.device_id,
    device_name: device.device_name,
    hostname: device.hostname,
    os: device.os,
    os_version: device.os_version,
    arch: device.arch,
    agent_version: device.agent_version,
    tenant_id: device.tenant_id,
    online: device.online,
    active_session: device.active_session,
    last_seen: device.last_seen,
    enrolled_at: device.enrolled_at,
    last_ip: device.last_ip,
  };
}

export function setOnline(device: Device, control: WebSocket, ip: string): void {
  device.online = true;
  device.control = control;
  device.last_seen = Date.now();
  device.last_ip = ip;
}

export function setOffline(device: Device): void {
  device.online = false;
  device.active_session = false;
  device.control = undefined;
  device.last_seen = Date.now();
}

/** Mint a new session for a device (does not yet contact the agent). */
export function createSession(device: Device, viewOnly: boolean): Session {
  const now = Date.now();
  const session: Session = {
    session_id: newSessionId(),
    device_id: device.device_id,
    session_token: newSessionToken(),
    view_only: viewOnly,
    created_at: now,
    expires_at: now + config.sessionTtl * 1000,
    paired: false,
    bufferToViewer: [],
    bufferToAgent: [],
  };
  sessionsById.set(session.session_id, session);
  return session;
}

export function sessionById(id: string): Session | undefined {
  return sessionsById.get(id);
}

export function deleteSession(id: string): void {
  sessionsById.delete(id);
}

/** Reap sessions that never paired before their TTL — keeps the map from leaking. */
export function reapExpiredSessions(): number {
  const now = Date.now();
  let reaped = 0;
  for (const session of sessionsById.values()) {
    if (!session.paired && now > session.expires_at) {
      try {
        session.agent?.close();
        session.viewer?.close();
      } catch {
        /* best effort */
      }
      sessionsById.delete(session.session_id);
      reaped += 1;
    }
  }
  return reaped;
}
