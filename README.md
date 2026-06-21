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

Two trust zones share the process. The **agent plane** is zero-touch and
authenticates with its own device/session tokens; the **operator plane** (the
dashboard and its API) requires a signed-in user.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/enroll` | — (agent) | Zero-touch device registration → returns a device token |
| `WSS` | `/agent/control` | Bearer device token | Persistent agent control channel |
| `WSS` | `/relay/<session_id>` | session token | Agent ⇄ viewer byte pipe |
| `POST` | `/auth/login` | — | Sign in; sets an httpOnly session cookie |
| `POST` | `/auth/logout` | cookie | Sign out; destroys the session |
| `GET` | `/auth/me` | cookie | The signed-in identity |
| `POST` | `/sessions` | **operator** | Start a Connect; signals the agent, returns a viewer URL |
| `GET` | `/api/devices` | **operator** | Device list (for the dashboard) |
| `POST` | `/api/devices/:id/disconnect` | **operator** | Ask the agent to end its session |
| `POST` | `/api/devices/:id/privacy` | **operator** | Toggle the endpoint's privacy screen |
| `GET` | `/healthz` | — | Liveness |
| `GET` | `/` | **operator** (redirects to `/login.html`) | The noVNC web dashboard |

## Database & authentication

State that must survive a restart — the dashboard operators — lives in Postgres,
accessed through [Drizzle ORM](https://orm.drizzle.team). (Devices and live relay
sessions remain in memory by design; agents re-enroll on reconnect.) The schema is
defined in `src/db/schema/`, versioned as SQL under `drizzle/`.

```bash
# 1. Configure — copy the template and fill in DATABASE_URL + SESSION_SECRET.
cp .env.example .env
#    SESSION_SECRET:  openssl rand -hex 32

# 2. Inspect / sync the schema with Drizzle Kit.
npm run db:pull       # introspect the live DB into drizzle/ (round-trip check)
npm run db:generate   # emit a SQL migration from src/db/schema changes
npm run db:migrate    # apply pending migrations
npm run db:studio     # browse the DB in the Drizzle Studio UI

# 3. Create (or update) the admin operator from AUTH_ADMIN_* in .env.
npm run db:seed
```

The first sign-in uses the seeded admin (default **username `shadmanzero`**, name
**shadmanZero**) — set `AUTH_ADMIN_PASSWORD` in `.env` before seeding. Passwords are
stored as scrypt hashes; sessions are server-side rows keyed by a signed, httpOnly
cookie. In the Docker image, `node dist/db/migrate.js` runs on boot so the schema is
always current before the server starts.

## Run locally

```bash
npm install
cp .env.example .env  # fill DATABASE_URL + SESSION_SECRET, then: npm run db:migrate && npm run db:seed
npm run dev          # vendors noVNC, builds CSS, then watches src/ with tsx
# open http://localhost:4000  → you'll be redirected to /login.html
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

`DATABASE_URL` and `SESSION_SECRET` are **required**; everything else has a working
default — see `.env.example`. The important ones:

| Env | Default | Notes |
|-----|---------|-------|
| `DATABASE_URL` | _(required)_ | Postgres connection string for Drizzle (use `sslmode=disable` on a plain port). |
| `SESSION_SECRET` | _(required)_ | HMAC key for signing session cookies (`openssl rand -hex 32`). Rotating it logs everyone out. |
| `SESSION_TTL_HOURS` | `168` | How long a login stays valid (7 days). |
| `AUTH_COOKIE_SECURE` | auto | Forces the `Secure` cookie flag; auto-on when `PUBLIC_URL` is https. |
| `AUTH_ADMIN_NAME` / `AUTH_ADMIN_USERNAME` / `AUTH_ADMIN_PASSWORD` | `shadmanZero` / `shadmanzero` / _(empty)_ | Seed admin, applied by `npm run db:seed`. |
| `PORT` | `4000` | EasyPanel injects this; the server listens on it. |
| `HOST` | `0.0.0.0` | Bind address. |
| `PUBLIC_URL` | _(empty)_ | Force the public base, e.g. `https://rmm.example.com`. Empty = derive from `X-Forwarded-Proto`/`Host`. |
| `TRUST_PROXY` | `true` | Honor `X-Forwarded-*` for real client IP + scheme (keep on behind a proxy). |
| `HEARTBEAT_INTERVAL` | `25` | Seconds; handed to the agent. |
| `SESSION_TTL` | `60` | Seconds a relay session waits to pair. |

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
4. **Environment** (required): set `DATABASE_URL` (your Postgres) and `SESSION_SECRET`
   (`openssl rand -hex 32`). Optionally set `PUBLIC_URL=https://<your-domain>` to pin
   emitted URLs, or leave it blank — the `X-Forwarded-*` headers already drive `wss://`.
   Keep `TRUST_PROXY=true` so device IPs show the **real client**, not the proxy.
5. Deploy. The container applies pending migrations on boot, then serves; the health
   check hits `/healthz`. Seed the first admin once with `npm run db:seed` (locally
   against the same `DATABASE_URL`, or from a one-off container shell).

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
