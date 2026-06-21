// rackoona — viewer page.
//
// Reads ?device=<id>&name=<label> from the URL, asks the server to start a session
// (POST /sessions), then points noVNC at the returned relay URL. Leaving the page (or
// disconnect) returns to the device list. noVNC is vendored under /vendor/novnc.

import RFB from "/vendor/novnc/core/rfb.js";
import * as Log from "/vendor/novnc/core/util/logging.js";
import { createNetStats } from "/stats.js";

const params = new URLSearchParams(location.search);
// Open the viewer with `&debug` to turn on noVNC's internal RFB tracing in the
// browser console (handshake steps, rectangle decode, disconnect reasons) — pairs
// with the agent's RACKOONA_DEBUG trace for an end-to-end picture.
if (params.has("debug")) Log.initLogging("debug");
const deviceId = params.get("device");
const deviceName = params.get("name") || "device";

const els = {
  screen: document.getElementById("screen"),
  name: document.getElementById("viewer-name"),
  state: document.getElementById("viewer-state"),
  scaleToggle: document.getElementById("scale-toggle"),
  privacyBtn: document.getElementById("privacy-btn"),
  cadBtn: document.getElementById("cad-btn"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  toast: document.getElementById("toast"),
  stats: document.getElementById("viewer-stats"),
  statLatency: document.getElementById("stat-latency"),
  statLatencyVal: document.getElementById("stat-latency-val"),
  statFpsVal: document.getElementById("stat-fps-val"),
  statNetVal: document.getElementById("stat-net-val"),
  statResVal: document.getElementById("stat-res-val"),
};

let rfb = null;
let privacyOn = false;

// Network stats: install the WebSocket sniffer now, before noVNC opens its socket.
const netStats = createNetStats();
netStats.install();
let statsTimer = null;

els.name.textContent = deviceName;

function setState(text, kind) {
  els.state.textContent = text;
  els.state.className = `pill${kind ? ` pill--${kind}` : ""}`;
}

function showToast(html, isError = false) {
  els.toast.innerHTML = html;
  els.toast.className = `toast${isError ? " toast--error" : ""}`;
  els.toast.hidden = false;
}

function goHome() {
  teardown();
  location.href = "/";
}

function teardown() {
  stopStats();
  netStats.uninstall();
  if (rfb) {
    try {
      rfb.disconnect();
    } catch {
      /* already gone */
    }
    rfb = null;
  }
}

// --- Privacy screen ----------------------------------------------------------
// Toggles the endpoint's blank-screen overlay: the remote machine shows "being
// controlled" locally while we keep the clean desktop. The agent also auto-restores
// when the session ends, so a stale ON state can't strand the owner.

async function setPrivacy(enable) {
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/privacy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enable }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    privacyOn = enable;
    reflectPrivacy();
  } catch (err) {
    showToast(`Privacy toggle failed: ${escapeHtml(String(err.message || err))}`, true);
  }
}

function reflectPrivacy() {
  els.privacyBtn.setAttribute("aria-pressed", privacyOn ? "true" : "false");
  // Red while engaged = "active, click to restore"; ghost otherwise.
  els.privacyBtn.classList.toggle("btn--ghost", !privacyOn);
  els.privacyBtn.classList.toggle("btn--danger", privacyOn);
  els.privacyBtn.title = privacyOn
    ? "Privacy ON — the remote screen is blanked locally. Click to restore."
    : "Blank the remote machine's physical screen (you still see the desktop)";
}

// --- Network stats HUD -------------------------------------------------------

function startStats() {
  els.stats.hidden = false;
  if (statsTimer) return;
  renderStats(netStats.sample());
  statsTimer = setInterval(() => renderStats(netStats.sample()), 1000);
}

function stopStats() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

function renderStats(s) {
  els.statLatencyVal.textContent = s.latencyMs == null ? "—" : `${Math.round(s.latencyMs)}ms`;
  els.statLatency.className = `stat stat--${latencyKind(s.latencyMs)}`;
  els.statFpsVal.textContent = s.fps >= 0.05 ? s.fps.toFixed(0) : "0";
  els.statNetVal.textContent = formatRate(s.kbps);
  const canvas = els.screen.querySelector("canvas");
  els.statResVal.textContent = canvas ? `${canvas.width}×${canvas.height}` : "—";
}

function latencyKind(ms) {
  if (ms == null) return "idle";
  if (ms < 80) return "ok";
  if (ms < 180) return "warn";
  return "bad";
}

function formatRate(kbps) {
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${kbps.toFixed(0)} KB/s`;
}

async function start() {
  if (!deviceId) {
    setState("no device", "bad");
    showToast("Missing device id — returning to the list…", true);
    setTimeout(goHome, 1500);
    return;
  }

  setState("starting session…", "");
  let wsUrl;
  try {
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, view_only: false }),
    });
    if (res.status === 401) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.replace(`/login.html?next=${next}`);
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    wsUrl = data.viewer_ws_url;
  } catch (err) {
    setState("failed", "bad");
    showToast(`Could not start session: ${escapeHtml(String(err.message || err))}`, true);
    return;
  }

  setState("connecting…", "");
  rfb = new RFB(els.screen, wsUrl, { shared: true });
  rfb.scaleViewport = els.scaleToggle.checked;
  rfb.clipViewport = els.scaleToggle.checked;
  rfb.focusOnClick = true;
  // Bandwidth is cheap now (Tight + dirty-rect tiling), so ask for sharper JPEG on
  // photographic/video tiles; the agent's adaptive controller still backs quality
  // down automatically under congestion. (Lossless text/UI tiles are unaffected.)
  rfb.qualityLevel = 8;

  rfb.addEventListener("connect", () => {
    console.info("[viewer] noVNC connected (ServerInit received)");
    setState("connected", "ok");
    startStats();
  });
  rfb.addEventListener("disconnect", (e) => {
    const clean = e.detail && e.detail.clean;
    // clean=false right after connecting (or before any "connect") is the
    // black-screen-retry signature: noVNC got far enough then hit a bad frame.
    console.warn("[viewer] noVNC disconnect clean=", clean, e.detail);
    setState(clean ? "disconnected" : "connection lost", "bad");
    if (!clean) showToast("Connection closed by the remote end.", true);
    stopStats();
    rfb = null;
    // The agent auto-restores the screen when the session ends; reflect that here.
    privacyOn = false;
    reflectPrivacy();
  });
  rfb.addEventListener("securityfailure", (e) => {
    setState("security failure", "bad");
    showToast(`Security failure: ${escapeHtml(String(e.detail?.reason ?? ""))}`, true);
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

els.disconnectBtn.addEventListener("click", goHome);
els.privacyBtn.addEventListener("click", () => setPrivacy(!privacyOn));
els.cadBtn.addEventListener("click", () => rfb && rfb.sendCtrlAltDel());
els.scaleToggle.addEventListener("change", () => {
  if (rfb) {
    rfb.scaleViewport = els.scaleToggle.checked;
    rfb.clipViewport = els.scaleToggle.checked;
  }
});
window.addEventListener("beforeunload", teardown);

start();
