/**
 * `WSS /relay/<session_id>` — the dumb byte pipe (`RMM/docs/07`, `09` §5).
 *
 * Both the agent (`role=agent`) and the browser's noVNC (`role=viewer`) dial in with
 * the single-use session token. The relay validates, waits for both roles, then
 * forwards binary frames verbatim — it never parses RFB.
 *
 * Ordering matters: the RFB server speaks first, so the agent may push bytes before
 * the viewer has connected. Anything that arrives before the peer is present is
 * buffered per session and flushed on pairing, so no handshake bytes are lost.
 */

import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { clientIp } from "../ip";
import { logger } from "../log";
import * as registry from "../registry";
import type { Session } from "../registry";

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

type Role = "agent" | "viewer";

/** Validate the session token + role at upgrade, then attach the socket. */
export function handleRelayUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pathname: string,
  query: URLSearchParams,
): void {
  const sessionId = pathname.slice("/relay/".length);
  const token = query.get("token") ?? "";
  const role = query.get("role");

  const session = registry.sessionById(sessionId);
  const valid =
    session !== undefined &&
    session.session_token === token &&
    (role === "agent" || role === "viewer");

  if (!valid) {
    reject(socket, "403 Forbidden");
    return;
  }

  // One agent and one viewer per session (MVP single-viewer policy).
  if ((role === "agent" && session.agent) || (role === "viewer" && session.viewer)) {
    reject(socket, "409 Conflict");
    return;
  }

  const ip = clientIp(req);
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, session, role as Role, ip));
}

function onConnection(ws: WebSocket, session: Session, role: Role, ip: string): void {
  ws.binaryType = "nodebuffer";
  if (role === "agent") session.agent = ws;
  else session.viewer = ws;
  logger.info(`relay ${session.session_id}: ${role} connected from ${ip}`);

  const peerSocket = (): WebSocket | undefined =>
    role === "agent" ? session.viewer : session.agent;
  const peerBuffer = (): Buffer[] =>
    role === "agent" ? session.bufferToViewer : session.bufferToAgent;

  ws.on("message", (data: RawData) => {
    const chunk = toBuffer(data);
    const peer = peerSocket();
    if (peer && peer.readyState === WebSocket.OPEN) {
      peer.send(chunk, { binary: true });
    } else {
      // Peer not here yet — hold the bytes until pairing flushes them.
      peerBuffer().push(chunk);
    }
  });

  ws.on("close", () => {
    logger.info(`relay ${session.session_id}: ${role} closed`);
    const peer = peerSocket();
    if (peer) {
      try {
        peer.close();
      } catch {
        /* ignore */
      }
    }
    registry.deleteSession(session.session_id);
  });

  ws.on("error", (err) => {
    logger.warn(`relay ${session.session_id} ${role} error: ${err.message}`);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });

  // Both present → flush anything buffered while we waited.
  if (session.agent && session.viewer) {
    session.paired = true;
    flush(session.bufferToViewer, session.viewer);
    flush(session.bufferToAgent, session.agent);
    logger.info(`relay ${session.session_id}: PAIRED`);
  }
}

function flush(buffer: Buffer[], target: WebSocket | undefined): void {
  if (!target || target.readyState !== WebSocket.OPEN) {
    buffer.length = 0;
    return;
  }
  for (const chunk of buffer) target.send(chunk, { binary: true });
  buffer.length = 0;
}

/** Normalize ws `RawData` (Buffer | ArrayBuffer | Buffer[]) to a single Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
