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

/** Verbose byte-ledger tracing toggle (env `RACKOONA_DEBUG`), matching the agent. */
const DEBUG = !!process.env.RACKOONA_DEBUG && process.env.RACKOONA_DEBUG !== "0";

/**
 * Keepalive ping interval. An idle remote desktop sends no bytes (the agent only
 * pushes on change), so without periodic traffic a reverse proxy in front of the
 * relay will close the WebSocket on its idle timeout (commonly ~60s) — the
 * "disconnected in between" symptom. A WS ping every 25s keeps each hop warm.
 */
const KEEPALIVE_MS = 25_000;

/**
 * Backpressure thresholds (bytes). In continuous-update (push) mode the agent
 * free-runs frames; if the viewer can't keep up, the peer's send buffer grows
 * unbounded. When it crosses HIGH we pause reading from the *sender* (so its RFB
 * writer blocks via TCP backpressure, bounding memory) and resume below LOW.
 */
const BACKPRESSURE_HIGH = 8 * 1024 * 1024;
const BACKPRESSURE_LOW = 1 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 50;

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

  const otherRole = role === "agent" ? "viewer" : "agent";

  ws.on("message", (data: RawData) => {
    const chunk = toBuffer(data);
    const peer = peerSocket();
    const forwarded = !!peer && peer.readyState === WebSocket.OPEN;
    if (forwarded) {
      peer!.send(chunk, { binary: true });
      applyBackpressure(ws, peer!);
    } else {
      // Peer not here yet — hold the bytes until pairing flushes them.
      peerBuffer().push(chunk);
    }
    if (DEBUG) {
      logger.info(
        `relay ${session.session_id}: ${role}->${otherRole} ${chunk.length}B ${forwarded ? "forwarded" : "BUFFERED(peer absent)"}`,
      );
    }
  });

  // Keepalive so an idle session isn't dropped by a proxy idle timeout.
  ws.on("pong", () => {});
  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {
        /* socket closing */
      }
    }
  }, KEEPALIVE_MS);

  ws.on("close", (code: number, reason: Buffer) => {
    clearInterval(keepalive);
    clearBackpressure(ws);
    logger.info(
      `relay ${session.session_id}: ${role} closed code=${code} reason=${reason?.toString() || ""}`,
    );
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

/** Per-socket resume timer, attached while the socket is paused for backpressure. */
type Throttled = WebSocket & { _resumeTimer?: ReturnType<typeof setInterval> };

/**
 * If `peer`'s outbound buffer is over the high-water mark, pause reading from
 * `source` (its underlying TCP socket) so the sender's RFB writer blocks — bounding
 * relay memory in push mode. A poll timer resumes `source` once `peer` drains.
 */
function applyBackpressure(source: WebSocket, peer: WebSocket): void {
  if (peer.bufferedAmount <= BACKPRESSURE_HIGH) return;
  const sock = (source as unknown as { _socket?: import("net").Socket })._socket;
  if (!sock || sock.isPaused()) return;
  sock.pause();
  const s = source as Throttled;
  if (s._resumeTimer) return;
  s._resumeTimer = setInterval(() => {
    const drained = peer.bufferedAmount < BACKPRESSURE_LOW;
    const gone = peer.readyState !== WebSocket.OPEN || source.readyState !== WebSocket.OPEN;
    if (drained || gone) {
      try {
        if (sock.isPaused()) sock.resume();
      } catch {
        /* socket closing */
      }
      clearBackpressure(source);
    }
  }, BACKPRESSURE_POLL_MS);
}

/** Cancel any pending resume timer (on drain or close). */
function clearBackpressure(source: WebSocket): void {
  const s = source as Throttled;
  if (s._resumeTimer) {
    clearInterval(s._resumeTimer);
    s._resumeTimer = undefined;
  }
}

function flush(buffer: Buffer[], target: WebSocket | undefined): void {
  if (DEBUG) {
    const bytes = buffer.reduce((n, c) => n + c.length, 0);
    logger.info(`relay flush -> ${target ? "open" : "no-target"}: ${buffer.length} chunks, ${bytes}B`);
  }
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
