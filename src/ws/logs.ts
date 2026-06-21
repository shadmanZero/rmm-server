/**
 * `WSS /admin/logs` — the operator-only live log tail behind the dashboard's
 * `/logs` page.
 *
 * Auth is the operator's signed session cookie, validated at the WebSocket upgrade
 * (same trust as the dashboard pages). On connect the server replays the buffered
 * backlog, then streams every new {@link LogEntry} — server lines and agent traces
 * alike — until the socket closes. It is strictly server→browser; inbound frames
 * are ignored.
 */

import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import { readSessionCookie } from "../auth/cookies";
import { validateSession } from "../auth/sessions";
import { snapshot, subscribe, type LogEntry } from "../log";

const wss = new WebSocketServer({ noServer: true });

/** Validate the operator session at upgrade time, then hand off to the WS server. */
export async function handleLogsUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  let authed = false;
  try {
    const sessionId = readSessionCookie(req.headers.cookie);
    if (sessionId) authed = (await validateSession(sessionId)) !== null;
  } catch {
    authed = false;
  }

  if (!authed) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
}

function onConnection(ws: WebSocket): void {
  send(ws, { type: "backlog", entries: snapshot() });

  const unsubscribe = subscribe((entry) => send(ws, { type: "log", entry }));
  ws.on("close", unsubscribe);
  ws.on("error", unsubscribe);
  // The tail is read-only; we never act on client frames.
}

type Outbound =
  | { type: "backlog"; entries: readonly LogEntry[] }
  | { type: "log"; entry: LogEntry };

/**
 * Drop live log lines once a tail's outbound buffer exceeds this — a dashboard on a
 * slow link (or many reconnecting at once after an outage) must never balloon the
 * server's memory. The one-shot backlog is always sent; only the unbounded live stream
 * is shed.
 */
const DROP_ABOVE_BYTES = 1 * 1024 * 1024;

function send(ws: WebSocket, message: Outbound): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (message.type === "log" && ws.bufferedAmount > DROP_ABOVE_BYTES) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Best-effort; a failed send just means this tail missed a line.
  }
}
