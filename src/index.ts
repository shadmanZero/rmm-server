/**
 * rackoona control plane — entry point.
 *
 * One process serves everything the MVP needs:
 *   HTTP   POST /enroll                       zero-touch device registration
 *          POST /sessions                     start a Connect (signals the agent)
 *          GET  /api/devices                  device list for the frontend
 *          POST /api/devices/:id/disconnect   end a session
 *          GET  /healthz                      liveness
 *          (static)                           the noVNC web frontend in public/
 *   WS     /agent/control                     persistent agent control channel
 *          /relay/<session_id>                agent ⇄ viewer byte pipe
 */

import http from "http";
import path from "path";
import express from "express";
import { config } from "./config";
import { logger } from "./log";
import * as registry from "./registry";
import { enrollHandler } from "./http/enroll";
import { listDevicesHandler } from "./http/devices";
import { createSessionHandler, disconnectHandler, privacyHandler } from "./http/sessions";
import { handleControlUpgrade } from "./ws/control";
import { handleRelayUpgrade } from "./ws/relay";

const app = express();
app.disable("x-powered-by");
// Behind EasyPanel/Traefik (or nginx/Caddy) the real client IP and scheme arrive in
// X-Forwarded-* headers; trust them so req.ip and URL derivation are correct.
if (config.trustProxy) app.set("trust proxy", true);
app.use(express.json({ limit: "256kb" }));

// API
app.post("/enroll", enrollHandler);
app.post("/sessions", createSessionHandler);
app.get("/api/devices", listDevicesHandler);
app.post("/api/devices/:deviceId/disconnect", disconnectHandler);
app.post("/api/devices/:deviceId/privacy", privacyHandler);
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Static frontend (noVNC viewer). Vendored noVNC lives under public/vendor/novnc.
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

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
  } else {
    socket.destroy();
  }
});

// Reap unpaired sessions past their TTL.
const reaper = setInterval(() => {
  const reaped = registry.reapExpiredSessions();
  if (reaped > 0) logger.info(`reaped ${reaped} expired session(s)`);
}, 10_000);
reaper.unref();

server.listen(config.port, config.host, () => {
  const shown = config.host === "0.0.0.0" ? "localhost" : config.host;
  logger.info(`rackoona control plane listening on http://${shown}:${config.port}`);
  logger.info(`  open the dashboard:  http://${shown}:${config.port}/`);
  if (config.publicUrl) logger.info(`  public URL:          ${config.publicUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
