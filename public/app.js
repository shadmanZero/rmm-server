// rackoona web frontend — device list + noVNC viewer.
//
// noVNC is vendored under /vendor/novnc (see scripts/vendor-novnc.js) and imported
// as a plain ES module — no bundler. The viewer points RFB at the relay URL the
// server hands back from POST /sessions; from there the whole RFB conversation flows
// agent ⇄ relay ⇄ this browser.

import RFB from "/vendor/novnc/core/rfb.js";

const POLL_MS = 3000;

const els = {
  listView: document.getElementById("list-view"),
  viewerView: document.getElementById("viewer-view"),
  devices: document.getElementById("devices"),
  empty: document.getElementById("empty"),
  deviceCount: document.getElementById("device-count"),
  refreshBtn: document.getElementById("refresh-btn"),
  connHint: document.getElementById("connect-hint"),
  connDot: document.getElementById("conn-dot"),
  connText: document.getElementById("conn-text"),
  screen: document.getElementById("screen"),
  viewerName: document.getElementById("viewer-name"),
  viewerState: document.getElementById("viewer-state"),
  backBtn: document.getElementById("back-btn"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  scaleToggle: document.getElementById("scale-toggle"),
  cadBtn: document.getElementById("cad-btn"),
  toast: document.getElementById("toast"),
};

let rfb = null;
let activeDeviceId = null;
let pollTimer = null;

// ---- device list ---------------------------------------------------------

async function loadDevices() {
  try {
    const res = await fetch("/api/devices", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const devices = await res.json();
    setControlPlaneStatus(true);
    renderDevices(devices);
  } catch (err) {
    setControlPlaneStatus(false);
    console.error("loadDevices failed:", err);
  }
}

function setControlPlaneStatus(ok) {
  els.connDot.className = `dot ${ok ? "dot--ok" : "dot--bad"}`;
  els.connText.textContent = ok ? "connected to control plane" : "control plane unreachable";
}

function renderDevices(devices) {
  els.deviceCount.textContent = `${devices.length} device${devices.length === 1 ? "" : "s"}`;
  els.empty.hidden = devices.length > 0;

  // Reflect the live host in the copy-paste hint.
  els.connHint.textContent = `agent connect --server ${location.origin}`;

  els.devices.innerHTML = "";
  for (const d of devices) {
    els.devices.appendChild(deviceCard(d));
  }
}

function deviceCard(d) {
  const card = document.createElement("div");
  card.className = "card";

  const online = d.online === true;
  card.innerHTML = `
    <div class="card__top">
      <div>
        <div class="card__name"></div>
        <div class="card__meta"></div>
      </div>
      <span class="status ${online ? "status--online" : "status--offline"}">
        <span class="dot ${online ? "dot--ok" : ""}"></span>${online ? "online" : "offline"}
      </span>
    </div>
    <div class="card__specs">
      <span class="tag">${escapeHtml(d.os)}</span>
      <span class="tag">${escapeHtml(d.arch)}</span>
      <span class="tag">v${escapeHtml(d.agent_version)}</span>
      ${d.last_ip ? `<span class="tag">${escapeHtml(d.last_ip)}</span>` : ""}
      ${d.active_session ? '<span class="tag">in session</span>' : ""}
    </div>
    <button class="btn btn--primary" ${online ? "" : "disabled"}>
      ${online ? "Connect" : "Offline"}
    </button>
  `;

  card.querySelector(".card__name").textContent = d.device_name || d.device_id;
  card.querySelector(".card__meta").textContent = d.hostname || d.device_id;

  const btn = card.querySelector("button");
  if (online) btn.addEventListener("click", () => startSession(d));
  return card;
}

// ---- session / viewer ----------------------------------------------------

async function startSession(device) {
  showToast(`<span class="spinner"></span> Connecting to ${escapeHtml(device.device_name)}…`);
  try {
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: device.device_id, view_only: false }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

    hideToast();
    openViewer(device, data.viewer_ws_url);
  } catch (err) {
    showToast(`Could not start session: ${escapeHtml(String(err.message || err))}`, true);
    console.error("startSession failed:", err);
  }
}

function openViewer(device, wsUrl) {
  activeDeviceId = device.device_id;
  stopPolling();

  els.listView.hidden = true;
  els.viewerView.hidden = false;
  els.viewerName.textContent = device.device_name || device.device_id;
  setViewerState("connecting…", "");

  rfb = new RFB(els.screen, wsUrl, { shared: true });
  rfb.scaleViewport = els.scaleToggle.checked;
  rfb.clipViewport = els.scaleToggle.checked;
  rfb.focusOnClick = true;

  rfb.addEventListener("connect", () => setViewerState("connected", "ok"));
  rfb.addEventListener("disconnect", (e) => {
    const clean = e.detail && e.detail.clean;
    setViewerState(clean ? "disconnected" : "connection lost", "bad");
    if (!clean) showToast("Connection closed by the remote end.", true);
    teardownRfb();
  });
  rfb.addEventListener("securityfailure", (e) => {
    setViewerState("security failure", "bad");
    showToast(`Security failure: ${escapeHtml(String(e.detail?.reason ?? ""))}`, true);
  });
}

function setViewerState(text, kind) {
  els.viewerState.textContent = text;
  els.viewerState.className = `pill${kind ? ` pill--${kind}` : ""}`;
}

function teardownRfb() {
  if (rfb) {
    try {
      rfb.disconnect();
    } catch {
      /* already gone */
    }
    rfb = null;
  }
}

function leaveViewer() {
  teardownRfb();
  els.screen.innerHTML = "";
  els.viewerView.hidden = true;
  els.listView.hidden = false;
  activeDeviceId = null;
  startPolling();
  loadDevices();
}

// ---- polling -------------------------------------------------------------

function startPolling() {
  stopPolling();
  pollTimer = setInterval(loadDevices, POLL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---- toast ---------------------------------------------------------------

let toastTimer = null;
function showToast(html, isError = false) {
  els.toast.innerHTML = html;
  els.toast.className = `toast${isError ? " toast--error" : ""}`;
  els.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  if (isError) toastTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  els.toast.hidden = true;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// ---- wiring --------------------------------------------------------------

els.refreshBtn.addEventListener("click", loadDevices);
els.backBtn.addEventListener("click", leaveViewer);
els.disconnectBtn.addEventListener("click", leaveViewer);
els.cadBtn.addEventListener("click", () => rfb && rfb.sendCtrlAltDel());
els.scaleToggle.addEventListener("change", () => {
  if (rfb) {
    rfb.scaleViewport = els.scaleToggle.checked;
    rfb.clipViewport = els.scaleToggle.checked;
  }
});

window.addEventListener("beforeunload", teardownRfb);

loadDevices();
startPolling();
