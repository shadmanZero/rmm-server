// rackoona — home page (device list).
//
// Lists enrolled devices and polls for presence. Clicking "Connect" navigates to the
// dedicated viewer page (viewer.html), which creates the session and runs noVNC.
// Keeping the viewer on its own page means the home page is never anything but the
// device list — no hidden black screen underneath.

const POLL_MS = 3000;

const els = {
  devices: document.getElementById("devices"),
  empty: document.getElementById("empty"),
  deviceCount: document.getElementById("device-count"),
  refreshBtn: document.getElementById("refresh-btn"),
  connHint: document.getElementById("connect-hint"),
  connDot: document.getElementById("conn-dot"),
  connText: document.getElementById("conn-text"),
};

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
  els.connHint.textContent = `agent connect --server ${location.origin}`;

  els.devices.innerHTML = "";
  for (const d of devices) els.devices.appendChild(deviceCard(d));
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

  if (online) {
    card.querySelector("button").addEventListener("click", () => {
      const params = new URLSearchParams({
        device: d.device_id,
        name: d.device_name || d.device_id,
      });
      location.href = `/viewer.html?${params.toString()}`;
    });
  }
  return card;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

els.refreshBtn.addEventListener("click", loadDevices);
loadDevices();
setInterval(loadDevices, POLL_MS);
