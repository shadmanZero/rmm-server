# rackoona control plane

The backend **and** web frontend for the rackoona RMM. Agents enroll into it
(zero-touch, no auth), it relays their desktops, and a browser views them live with
noVNC — no inbound ports on the endpoint, works behind any NAT.

```
 ENDPOINT (agent)                 THIS SERVER                      BROWSER
 ─ enroll  ──HTTPS POST /enroll──▶  mints device token
 ─ control ──WSS /agent/control──▶  presence + signaling
                                    POST /sessions  ◀──── click "Connect"
 ─ relay   ──WSS /relay/<id>────▶  byte pipe  ◀──WSS /relay/<id>── noVNC
                                    (forwards RFB verbatim)
```

One Node process serves all of it. State is in memory — restart and agents simply
re-enroll on their next reconnect.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/enroll` | Zero-touch device registration → returns a device token |
| `WSS` | `/agent/control` | Persistent agent control channel (Bearer device token) |
| `POST` | `/sessions` | Start a Connect; signals the agent, returns a viewer URL |
| `GET` | `/api/devices` | Device list (for the dashboard) |
| `POST` | `/api/devices/:id/disconnect` | Ask the agent to end its session |
| `WSS` | `/relay/<session_id>` | Agent ⇄ viewer byte pipe |
| `GET` | `/healthz` | Liveness |
| `GET` | `/` | The noVNC web dashboard |

## Run locally

```bash
npm install
npm run dev          # vendors noVNC, then watches src/ with tsx
# open http://localhost:4000
```

Point an agent at it (from the RMM repo):

```bash
cargo run -p agent -- connect --mock --server http://localhost:4000
```

…then click **Connect** in the dashboard. (`--mock` serves synthetic content so you
don't need to grant screen-recording permission; drop it to share the real desktop.)

### End-to-end smoke test

With the server running and an agent connected:

```bash
node scripts/smoke.js http://localhost:4000
```

It drives the whole pipe headlessly (enroll → session → RFB handshake → framebuffer)
and prints `✔ PASS` when real pixels arrive through the relay.

## Configuration

All optional — see `.env.example`. The important ones:

| Env | Default | Notes |
|-----|---------|-------|
| `PORT` | `4000` | EasyPanel injects this; the server listens on it. |
| `HOST` | `0.0.0.0` | Bind address. |
| `PUBLIC_URL` | _(empty)_ | Force the public base, e.g. `https://rmm.example.com`. Empty = derive from `X-Forwarded-Proto`/`Host`. |
| `TRUST_PROXY` | `true` | Honor `X-Forwarded-*` for real client IP + scheme (keep on behind a proxy). |
| `HEARTBEAT_INTERVAL` | `25` | Seconds; handed to the agent. |
| `SESSION_TTL` | `60` | Seconds a session waits to pair. |

URLs handed to agents/browsers (`control_url`, `relay_url`, `viewer_ws_url`) are
derived per request, so the **same build serves `ws://` on localhost and `wss://`
behind TLS** automatically.

## Deploy to EasyPanel

This server is built to sit behind EasyPanel's Traefik proxy (TLS + WebSockets work
out of the box).

1. **Create app** → source = this repo (or upload) → **Build: Dockerfile**.
2. **Port:** set the app's port to **4000** (matches the image's `EXPOSE`/`PORT`).
3. **Domain:** attach your domain; EasyPanel terminates TLS. WebSocket upgrades pass
   through automatically.
4. **Environment** (optional): set `PUBLIC_URL=https://<your-domain>` to pin emitted
   URLs, or leave it blank — the `X-Forwarded-*` headers already drive `wss://`.
   Keep `TRUST_PROXY=true` so device IPs show the **real client**, not the proxy.
5. Deploy. Health check hits `/healthz`.

Then run the agent against it:

```bash
agent connect --server https://<your-domain>
# (the agent already defaults to the deployed domain, so a bare `agent connect` works)
```

### Plain Docker

```bash
docker build -t rackoona-server .
docker run -p 4000:4000 -e PUBLIC_URL=https://rmm.example.com rackoona-server
# or: docker compose up --build
```

## How it stays correct

- **Zero-touch / no auth:** `/enroll` mints the device token server-side; the agent
  configures nothing but the server URL.
- **Relay buffering:** the RFB server speaks first, so bytes that arrive before noVNC
  connects are buffered per session and flushed on pairing — no lost handshake.
- **Real IPs:** captured from `X-Forwarded-For` (enroll, control, relay) and shown on
  each device card.

See `../RMM/docs/09-api-contract.md` for the full agent ↔ server wire contract.
