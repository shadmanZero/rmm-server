/**
 * rackoona control plane — entry point.
 *
 * One process serves everything the MVP needs:
 *   HTTP   POST /enroll                       zero-touch device registration (agent)
 *          POST /auth/login|logout, /auth/me  operator authentication
 *          POST /sessions                     start a Connect (signals the agent)
 *          GET  /api/devices                  device list for the frontend
 *          POST /api/devices/:id/disconnect   end a session
 *          GET  /healthz                      liveness
 *          (static)                           the noVNC web frontend in public/
 *   WS     /agent/control                     persistent agent control channel
 *          /relay/<session_id>                agent ⇄ viewer byte pipe
 *
 * Two trust zones share the process: the **agent** plane (`/enroll`, `/agent/control`,
 * `/relay/*`) is zero-touch and authenticates with its own device/session tokens; the
 * **operator** plane (the dashboard, `/api/*`, `/sessions`) requires a signed-in user.
 */

import "dotenv/config";
import http from "http";
import path from "path";
import express, { type RequestHandler } from "express";
import { config } from "./config";
import { logger } from "./log";
import { sql } from "./db/client";
import * as registry from "./registry";
import { enrollHandler } from "./http/enroll";
import { listDevicesHandler } from "./http/devices";
import { createSessionHandler, disconnectHandler, privacyHandler } from "./http/sessions";
import { loginHandler, logoutHandler, meHandler } from "./http/auth";
import { loadAuth, requireApiAuth, requirePageAuth } from "./auth/middleware";
import { pruneExpiredSessions } from "./auth/sessions";
import { handleControlUpgrade } from "./ws/control";
import { handleRelayUpgrade } from "./ws/relay";
import { handleLogsUpgrade } from "./ws/logs";

const app = express();
app.disable("x-powered-by");
// Behind EasyPanel/Traefik (or nginx/Caddy) the real client IP and scheme arrive in
// X-Forwarded-* headers. Trust exactly ONE proxy hop rather than blanket-trusting any
// upstream: this keeps req.ip / scheme correct for a single fronting proxy while
// preventing a direct client from spoofing X-Forwarded-For to evade the rate limiter.
// (Behind N chained proxies, set TRUST_PROXY and bump this hop count accordingly.)
app.set("trust proxy", config.trustProxy ? 1 : false);

// Baseline security response headers. The CSP is intentionally limited to directives
// that cannot break resource loading (clickjacking + base-tag + plugin hardening); a
// full script/style/connect policy is a follow-up that needs noVNC viewer QA.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  if (config.auth.cookieSecure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(express.json({ limit: "256kb" }));

const publicDir = path.join(__dirname, "..", "public");

// ── Agent plane + health: zero-touch, no operator auth ──────────────
app.post("/enroll", enrollHandler);
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ── Authentication ──────────────────────────────────────────────────
app.post("/auth/login", loginHandler);
app.post("/auth/logout", loadAuth, logoutHandler);
app.get("/auth/me", loadAuth, meHandler);

// ── Operator API: requires a signed-in session ──────────────────────
const apiAuth: RequestHandler[] = [loadAuth, requireApiAuth];
app.post("/sessions", apiAuth, createSessionHandler);
app.get("/api/devices", apiAuth, listDevicesHandler);
app.post("/api/devices/:deviceId/disconnect", apiAuth, disconnectHandler);
app.post("/api/devices/:deviceId/privacy", apiAuth, privacyHandler);

// ── Dashboard pages: gated; the login page is public static below ───
const pageAuth: RequestHandler[] = [loadAuth, requirePageAuth];
const sendPage =
  (file: string): RequestHandler =>
  (_req, res) =>
    res.sendFile(path.join(publicDir, file));
app.get(["/", "/index.html"], pageAuth, sendPage("index.html"));
app.get("/viewer.html", pageAuth, sendPage("viewer.html"));
app.get("/logs.html", pageAuth, sendPage("logs.html"));

// Static assets (login page, styles, scripts, vendored noVNC). `index: false` so the
// directory's index.html is never served unauthenticated at "/".
app.use(express.static(publicDir, { index: false }));

const server = http.createServer(app);

// Route WebSocket upgrades to the control channel or the relay by path.
server.on("upgrade", (req, socket, head) => {
  let pathname: string;
  let query: URLSearchParams;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === "/agent/control") {
    handleControlUpgrade(req, socket, head);
  } else if (pathname.startsWith("/relay/")) {
    handleRelayUpgrade(req, socket, head, pathname, query);
  } else if (pathname === "/admin/logs") {
    void handleLogsUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// Reap unpaired relay sessions past their TTL.
const reaper = setInterval(() => {
  const reaped = registry.reapExpiredSessions();
  if (reaped > 0) logger.info(`reaped ${reaped} expired session(s)`);
}, 10_000);
reaper.unref();

// Sweep expired login sessions out of the database hourly.
const sessionPruner = setInterval(() => {
  pruneExpiredSessions()
    .then((pruned) => {
      if (pruned > 0) logger.info(`pruned ${pruned} expired login session(s)`);
    })
    .catch((err: unknown) => {
      logger.warn(`login-session prune failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}, 60 * 60_000);
sessionPruner.unref();

server.listen(config.port, config.host, () => {
  const shown = config.host === "0.0.0.0" ? "localhost" : config.host;
  logger.info(`rackoona control plane listening on http://${shown}:${config.port}`);
  logger.info(`  open the dashboard:  http://${shown}:${config.port}/`);
  if (config.publicUrl) logger.info(`  public URL:          ${config.publicUrl}`);
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return; // a second signal shouldn't restart teardown
    shuttingDown = true;
    logger.info(`${signal} received — shutting down`);
    // Stop accepting connections, then close the DB pool so we exit cleanly instead of
    // leaking the postgres sockets; a hard backstop guarantees we still exit if either
    // close hangs.
    server.close(() => {
      sql.end({ timeout: 5 }).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
