# syntax=docker/dockerfile:1

# ── Build stage ───────────────────────────────────────────────────────────
# Compiles the one native dependency (better-sqlite3) and downloads the
# vendored fonts, so the runtime image needs neither a toolchain nor network.
FROM node:22-bookworm-slim AS build

WORKDIR /build

# Toolchain for better-sqlite3 when no prebuilt binary matches this platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./server/
RUN npm --prefix server ci --omit=dev

# The vendored fonts and confetti ship in the repository. This only checks
# their hashes against scripts/vendor-lock.json, so the build needs no network
# and produces the same image whatever a CDN happens to serve today.
COPY scripts ./scripts
COPY web ./web
RUN node scripts/fetch-assets.mjs --verify

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# dumb-init style signal handling is provided by compose's init: true.
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

COPY --from=build --chown=root:root /build/server/node_modules ./server/node_modules
COPY --chown=root:root server/package.json server/package-lock.json ./server/
COPY --chown=root:root server/src ./server/src
COPY --chown=root:root shared ./shared
COPY --from=build --chown=root:root /build/web ./web

# Application files are owned by root and only readable by the app user: the
# process cannot rewrite its own code, which is what makes a read-only root
# filesystem meaningful.
RUN chmod -R a-w /app \
    && mkdir -p /data \
    && chown node:node /data \
    && chmod 700 /data

USER node

WORKDIR /app/server

EXPOSE 8080

# Uses the app's own runtime; no curl or wget in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
