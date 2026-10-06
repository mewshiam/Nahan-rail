# syntax=docker/dockerfile:1
# =============================================================================
# Nahan on Railway — Dockerfile
# -----------------------------------------------------------------------------
# Runs the unmodified Cloudflare Workers source (_worker.js) on Node.js via
# the `railway/` adapter. Railway injects PORT at runtime; the server binds
# 0.0.0.0:${PORT} automatically.
# =============================================================================

# ---- build stage: compile native deps (better-sqlite3) with a toolchain ----
FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---- runtime stage ---------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Run as the unprivileged node user shipped with the base image.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# /data is the conventional Railway volume mount path. When a volume is
# attached, RAILWAY_VOLUME_MOUNT_PATH points here and the SQLite database
# persists across deploys. Without a volume the app still works (settings
# persist per-instance in ./data).
RUN mkdir -p /data && chown -R node:node /data
USER node

# Railway sets PORT dynamically — never hardcode it in the command.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/_health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "railway/server.js"]
