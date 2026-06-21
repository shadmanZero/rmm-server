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
  account: document.getElementById("account"),
  logoutBtn: document.getElementById("logout-btn"),
};

/** Send the operator to the login page, preserving where they were headed. */
function toLogin() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`/login.html?next=${next}`);
}

async function loadIdentity() {
  try {
    const res = await fetch("/auth/me", { cache: "no-store" });
    if (res.status === 401) return toLogin();
    if (!res.ok) return;
    const { user } = await res.json();
    if (user?.name) {
      els.account.textContent = user.name;
      els.account.classList.remove("hidden");
    }
  } catch (err) {
    console.error("loadIdentity failed:", err);
  }
}

async function logout() {
  els.logoutBtn.disabled = true;
  try {
    await fetch("/auth/logout", { method: "POST" });
  } catch (err) {
    console.error("logout failed:", err);
  } finally {
    toLogin();
  }
}

async function loadDevices() {
  try {
    const res = await fetch("/api/devices", { cache: "no-store" });
    if (res.status === 401) return toLogin();
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
  els.connText.textContent = ok ? "Connected" : "Offline";
  // Healthy state stays quiet (faint label, colour only on the dot); a lost
  // control plane tints the label red so the problem actually draws the eye.
  els.connText.classList.toggle("text-faint", ok);
  els.connText.classList.toggle("text-danger", !ok);
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
      <div class="min-w-0">
        <div class="card__name"></div>
        <div class="card__meta"></div>
      </div>
      <span class="status ${online ? "status--online" : "status--offline"}">
        <span class="dot ${online ? "dot--ok" : ""}"></span>${online ? "Online" : "Offline"}
      </span>
    </div>
    <div class="card__specs">
      <span class="tag">${escapeHtml(d.os)}</span>
      <span class="tag">${escapeHtml(d.arch)}</span>
      <span class="tag">v${escapeHtml(d.agent_version)}</span>
      ${d.last_ip ? `<span class="tag">${escapeHtml(d.last_ip)}</span>` : ""}
      ${d.active_session ? '<span class="tag text-warn border-warn/30">in session</span>' : ""}
    </div>
    ${
      online
        ? `<button class="btn btn--primary" type="button">
             <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
             Connect
           </button>`
        : `<button class="btn btn--ghost w-full" type="button" disabled>Offline</button>`
    }
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
els.logoutBtn.addEventListener("click", logout);
loadIdentity();
loadDevices();
setInterval(loadDevices, POLL_MS);
