// rackoona — viewer page.
//
// Reads ?device=<id>&name=<label> from the URL, asks the server to start a session
// (POST /sessions), then points noVNC at the returned relay URL. Leaving the page (or
// disconnect) returns to the device list. noVNC is vendored under /vendor/novnc.

import RFB from "/vendor/novnc/core/rfb.js";

const params = new URLSearchParams(location.search);
const deviceId = params.get("device");
const deviceName = params.get("name") || "device";

const els = {
  screen: document.getElementById("screen"),
  name: document.getElementById("viewer-name"),
  state: document.getElementById("viewer-state"),
  scaleToggle: document.getElementById("scale-toggle"),
  cadBtn: document.getElementById("cad-btn"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  toast: document.getElementById("toast"),
};

let rfb = null;

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
  if (rfb) {
    try {
      rfb.disconnect();
    } catch {
      /* already gone */
    }
    rfb = null;
  }
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

  rfb.addEventListener("connect", () => setState("connected", "ok"));
  rfb.addEventListener("disconnect", (e) => {
    const clean = e.detail && e.detail.clean;
    setState(clean ? "disconnected" : "connection lost", "bad");
    if (!clean) showToast("Connection closed by the remote end.", true);
    rfb = null;
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
els.cadBtn.addEventListener("click", () => rfb && rfb.sendCtrlAltDel());
els.scaleToggle.addEventListener("change", () => {
  if (rfb) {
    rfb.scaleViewport = els.scaleToggle.checked;
    rfb.clipViewport = els.scaleToggle.checked;
  }
});
window.addEventListener("beforeunload", teardown);

start();
