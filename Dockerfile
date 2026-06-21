# syntax=docker/dockerfile:1

# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /app

# Install all deps (incl. dev: typescript, @novnc, tsx) for the build.
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript and vendor the noVNC browser library into public/.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
RUN npm run build && npm run vendor:novnc

# ---------- runtime stage ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production deps only (express, ws) — small image, no toolchain.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Bring over the compiled server, the (vendored) frontend, the scripts, and the
# SQL migrations (applied at startup by `node dist/db/migrate.js`).
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle ./drizzle

# EasyPanel/most platforms inject PORT; default to 4000. HOST 0.0.0.0 for containers.
ENV HOST=0.0.0.0
ENV PORT=4000
EXPOSE 4000

# Liveness probe hits /healthz on the configured port.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

# Apply any pending migrations, then start. Migrations are idempotent, so this is
# safe on every boot; the server only starts once the schema is current.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
