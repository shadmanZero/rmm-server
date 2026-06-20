// rackoona — viewer network statistics.
//
// noVNC exposes no per-frame hooks, so we measure the RFB stream itself by wrapping
// the WebSocket *before* noVNC constructs it. Everything is derived from two cheap
// signals, with no parsing of the (large, multi-chunk) server→client pixel stream:
//
//   • Outgoing client messages are small and always start on a message boundary in
//     one `send()`, so we walk them to spot FramebufferUpdateRequests (type 3).
//   • Each request is answered by exactly one frame (noVNC requests the next frame
//     only after rendering the current one), so request rate ≈ FPS, and the gap
//     from a request to the first response bytes ≈ round-trip latency.
//   • Inbound byte volume gives bandwidth.
//
// Idle-held requests (our server holds an unchanged incremental request open until
// the screen changes) would otherwise report the idle gap as "latency", so samples
// longer than `MAX_RTT_MS` are discarded as not-a-measurement.

/** Discard RTT samples longer than this (ms) — they reflect an idle-held request,
 *  not network latency. */
const MAX_RTT_MS = 1500;

/** Client→server RFB message sizes (RFC 6143 §7.5); `null` = variable length. */
const FBU_REQUEST = 3;

/** Coerce a WebSocket `send()` / `message` payload to a `Uint8Array`, or `null`. */
function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null; // string (rare for RFB) — ignore
}

/** Byte length of an inbound message payload. */
function inboundLength(data) {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data && typeof data.size === "number") return data.size; // Blob fallback
  return 0;
}

/**
 * Create a network-stats collector. Call {@link NetStats.install} before noVNC
 * opens its socket, {@link NetStats.sample} on a timer to read+reset counters, and
 * {@link NetStats.uninstall} on teardown.
 */
export function createNetStats() {
  const OriginalWebSocket = window.WebSocket;
  let installed = false;

  const state = {
    inBytes: 0, // inbound bytes since last sample
    totalIn: 0, // inbound bytes for the whole session
    frames: 0, // FramebufferUpdateRequests since last sample (≈ frames)
    pendingReqAt: null, // perf time of the oldest unanswered request
    latencyMs: null, // smoothed round-trip latency
  };
  let lastSampleAt = performance.now();

  // Walk the complete client messages in one outgoing `send()` buffer, counting
  // FramebufferUpdateRequests. On an unknown type we stop (the next send() resyncs
  // on a fresh message boundary), so a desync can never persist.
  function scanOutgoing(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.byteLength;
    let off = 0;
    while (off < len) {
      const type = view.getUint8(off);
      let size;
      switch (type) {
        case 0: // SetPixelFormat
          size = 20;
          break;
        case 2: // SetEncodings: 4 + count*4
          if (off + 4 > len) return;
          size = 4 + view.getUint16(off + 2) * 4;
          break;
        case FBU_REQUEST: // FramebufferUpdateRequest
          size = 10;
          state.frames += 1;
          if (state.pendingReqAt === null) state.pendingReqAt = performance.now();
          break;
        case 4: // KeyEvent
          size = 8;
          break;
        case 5: // PointerEvent
          size = 6;
          break;
        case 6: // ClientCutText: 8 + length
          if (off + 8 > len) return;
          size = 8 + view.getUint32(off + 4);
          break;
        default:
          return; // unknown/extension message — stop scanning this buffer
      }
      if (size <= 0) return;
      off += size;
    }
  }

  function onInbound(byteCount) {
    state.inBytes += byteCount;
    state.totalIn += byteCount;
    if (state.pendingReqAt !== null) {
      const rtt = performance.now() - state.pendingReqAt;
      state.pendingReqAt = null;
      if (rtt <= MAX_RTT_MS) {
        // Exponential moving average — steady reading without lag spikes.
        state.latencyMs = state.latencyMs === null ? rtt : state.latencyMs * 0.6 + rtt * 0.4;
      }
    }
  }

  function install() {
    if (installed) return;
    installed = true;
    // IMPORTANT: do NOT `class extends WebSocket`. noVNC's `Websock.attach()`
    // validates the channel by inspecting only the instance's *immediate* prototype
    // (`Object.getPrototypeOf(channel)`). A subclass inserts an extra prototype level
    // whose own names are just `constructor`/`send`, hiding WebSocket.prototype's
    // `close`/`binaryType`/… from that one-level check — so noVNC throws
    // "Raw channel missing property: close" and the RFB session never starts (a black
    // screen stuck on "connecting…"). Instead return a REAL WebSocket and patch the
    // instance, leaving the prototype chain exactly as noVNC expects.
    const nativeSend = OriginalWebSocket.prototype.send;
    function SniffingWebSocket(...args) {
      const ws = new OriginalWebSocket(...args);
      ws.addEventListener("message", (ev) => onInbound(inboundLength(ev.data)));
      ws.send = function (data) {
        const bytes = toBytes(data);
        if (bytes) {
          try {
            scanOutgoing(bytes);
          } catch {
            /* never let instrumentation break the session */
          }
        }
        return nativeSend.call(ws, data);
      };
      return ws; // a genuine WebSocket: its prototype is WebSocket.prototype
    }
    // Keep `instanceof` and the readyState constants working for any caller.
    SniffingWebSocket.prototype = OriginalWebSocket.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      SniffingWebSocket[k] = OriginalWebSocket[k];
    }
    window.WebSocket = SniffingWebSocket;
  }

  function uninstall() {
    if (installed) window.WebSocket = OriginalWebSocket;
    installed = false;
  }

  // Read the counters accumulated since the previous call and reset the windowed
  // ones. Rates are normalised by the actual elapsed time, so an irregular timer
  // still reports correctly.
  function sample() {
    const now = performance.now();
    const dt = Math.max((now - lastSampleAt) / 1000, 1e-3);
    lastSampleAt = now;
    const out = {
      fps: state.frames / dt,
      kbps: state.inBytes / 1024 / dt,
      latencyMs: state.latencyMs,
      totalBytes: state.totalIn,
    };
    state.frames = 0;
    state.inBytes = 0;
    return out;
  }

  return { install, uninstall, sample };
}
