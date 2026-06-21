/**
 * Live log tail for the dashboard `/logs` page.
 *
 * Opens a read-only WebSocket to `/admin/logs` (auth rides on the session cookie),
 * replays the buffered backlog, then streams new lines. Supports level/source/text
 * filtering, pause-with-buffer, clear, and follow-the-tail auto-scroll.
 */

const els = {
  list: document.getElementById("log-list"),
  empty: document.getElementById("empty"),
  connState: document.getElementById("conn-state"),
  counts: document.getElementById("counts"),
  levelFilter: document.getElementById("level-filter"),
  sourceFilter: document.getElementById("source-filter"),
  search: document.getElementById("search"),
  pauseBtn: document.getElementById("pause-btn"),
  pauseLabel: document.getElementById("pause-label"),
  pauseCount: document.getElementById("pause-count"),
  clearBtn: document.getElementById("clear-btn"),
  logoutBtn: document.getElementById("logout-btn"),
  jumpBtn: document.getElementById("jump-btn"),
  toast: document.getElementById("toast"),
};

/** Most lines we keep in memory / DOM before trimming the oldest. */
const MAX_LINES = 4000;

const LEVEL_CLASS = {
  trace: "text-faint",
  info: "text-muted",
  warn: "text-warn",
  error: "text-danger",
};

const state = {
  /** All received entries (capped at MAX_LINES), oldest first. */
  entries: [],
  /** Entries received while paused, flushed on resume. */
  pendingWhilePaused: [],
  activeLevels: new Set(["trace", "info", "warn", "error"]),
  source: "",
  search: "",
  paused: false,
  /** Follow the tail (auto-scroll) while the user is at the bottom. */
  follow: true,
  knownSources: new Set(),
};

// ── WebSocket with reconnect/backoff ───────────────────────────────────
let ws = null;
let backoff = 1000;

function wsUrl() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/admin/logs`;
}

function connect() {
  setConn("connecting…", "");
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    backoff = 1000;
    setConn("live", "ok");
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "backlog" && Array.isArray(msg.entries)) {
      for (const entry of msg.entries) addEntry(entry, false);
      flushRender();
    } else if (msg.type === "log" && msg.entry) {
      addEntry(msg.entry, true);
    }
  };

  ws.onclose = () => {
    setConn("disconnected", "bad");
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

function setConn(text, kind) {
  els.connState.textContent = text;
  els.connState.className = `pill${kind === "ok" ? " pill--ok" : kind === "bad" ? " pill--bad" : ""}`;
}

// ── Entry handling ─────────────────────────────────────────────────────
function addEntry(entry, live) {
  if (!entry || typeof entry.message !== "string") return;
  state.entries.push(entry);
  if (state.entries.length > MAX_LINES) state.entries.shift();

  if (!state.knownSources.has(entry.source)) {
    state.knownSources.add(entry.source);
    addSourceOption(entry.source);
  }

  if (live) {
    if (state.paused) {
      state.pendingWhilePaused.push(entry);
      updatePauseCount();
      return;
    }
    appendRow(entry);
  }
  updateCounts();
}

function matches(entry) {
  if (!state.activeLevels.has(entry.level)) return false;
  if (state.source && entry.source !== state.source) return false;
  if (state.search && !entry.message.toLowerCase().includes(state.search)) return false;
  return true;
}

function appendRow(entry) {
  if (!matches(entry)) return;
  els.list.appendChild(rowEl(entry));
  // Trim the DOM in lockstep with the in-memory cap.
  while (els.list.childElementCount > MAX_LINES) {
    els.list.removeChild(els.list.firstChild);
  }
  els.empty.hidden = true;
  if (state.follow) scrollToBottom();
}

function rowEl(entry) {
  const row = document.createElement("div");
  row.className = "flex gap-2.5 whitespace-pre-wrap break-words py-px";

  const time = document.createElement("span");
  time.className = "shrink-0 text-faint tabular-nums";
  time.textContent = formatTime(entry.ts);

  const level = document.createElement("span");
  level.className = `shrink-0 w-12 font-semibold uppercase ${LEVEL_CLASS[entry.level] || "text-muted"}`;
  level.textContent = entry.level;

  const source = document.createElement("span");
  source.className = "shrink-0 max-w-[10rem] truncate text-accent/80";
  source.textContent = entry.source;
  source.title = entry.source;

  const message = document.createElement("span");
  message.className = "min-w-0 text-content/90";
  message.textContent = entry.message;

  row.append(time, level, source, message);
  return row;
}

/** Rebuild the whole list from the in-memory entries (after a filter change). */
function flushRender() {
  els.list.replaceChildren();
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const entry of state.entries) {
    if (!matches(entry)) continue;
    frag.appendChild(rowEl(entry));
    shown += 1;
  }
  els.list.appendChild(frag);
  els.empty.hidden = shown > 0;
  updateCounts();
  if (state.follow) scrollToBottom();
}

function updateCounts() {
  els.counts.classList.remove("hidden");
  els.counts.textContent = `${state.entries.length} line${state.entries.length === 1 ? "" : "s"}`;
}

function addSourceOption(source) {
  const opt = document.createElement("option");
  opt.value = source;
  opt.textContent = source;
  els.sourceFilter.appendChild(opt);
}

// ── Pause / resume ─────────────────────────────────────────────────────
function updatePauseCount() {
  const n = state.pendingWhilePaused.length;
  if (n > 0) {
    els.pauseCount.textContent = String(n);
    els.pauseCount.classList.remove("hidden");
  } else {
    els.pauseCount.classList.add("hidden");
  }
}

function togglePause() {
  state.paused = !state.paused;
  els.pauseBtn.setAttribute("aria-pressed", String(state.paused));
  els.pauseLabel.textContent = state.paused ? "Resume" : "Pause";
  if (!state.paused) {
    for (const entry of state.pendingWhilePaused) appendRow(entry);
    state.pendingWhilePaused = [];
    updatePauseCount();
    updateCounts();
  }
}

// ── Scroll / follow ────────────────────────────────────────────────────
function scrollToBottom() {
  els.list.scrollTop = els.list.scrollHeight;
}

function atBottom() {
  const slack = 24;
  return els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight < slack;
}

els.list.addEventListener("scroll", () => {
  state.follow = atBottom();
  els.jumpBtn.classList.toggle("hidden", state.follow);
});

els.jumpBtn.addEventListener("click", () => {
  state.follow = true;
  els.jumpBtn.classList.add("hidden");
  scrollToBottom();
});

// ── Filters ────────────────────────────────────────────────────────────
els.levelFilter.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-level]");
  if (!btn) return;
  const level = btn.dataset.level;
  if (state.activeLevels.has(level)) state.activeLevels.delete(level);
  else state.activeLevels.add(level);
  btn.setAttribute("aria-pressed", String(state.activeLevels.has(level)));
  flushRender();
});

els.sourceFilter.addEventListener("change", () => {
  state.source = els.sourceFilter.value;
  flushRender();
});

els.search.addEventListener("input", () => {
  state.search = els.search.value.trim().toLowerCase();
  flushRender();
});

els.pauseBtn.addEventListener("click", togglePause);

els.clearBtn.addEventListener("click", () => {
  state.entries = [];
  state.pendingWhilePaused = [];
  updatePauseCount();
  els.list.replaceChildren();
  els.empty.hidden = false;
  updateCounts();
});

els.logoutBtn.addEventListener("click", async () => {
  els.logoutBtn.disabled = true;
  try {
    await fetch("/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  location.href = "/login.html";
});

function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

connect();
