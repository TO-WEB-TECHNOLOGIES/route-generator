# Render free tier: ONE container running osrm-bff AND OSRM, with the NCR map graph baked in.
# Free web services are public and OSRM has no auth, so OSRM listens on 127.0.0.1 only and is
# reachable only from osrm-bff inside this container. See docs/deployment/render.md.
#
# Build with ops/render/build-image.sh (it copies the graph you already built locally into
# ops/render/map/ first). Build context: the repo root. Local docker compose is unaffected.

# ---- 1. osrm-bff: compile, then keep only production dependencies ----
FROM node:22-bookworm-slim AS app
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- 2. runtime: the OSRM image (Debian 11) + the Node 22 binary + our app + the map ----
# No apt-get: Debian 11's repositories are end of life. The official Node 22 binary runs on it
# (glibc 2.31; checked 2026-11-10).
FROM ghcr.io/project-osrm/osrm-backend:v5.27.1
COPY --from=app /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=app /app/package.json ./
COPY --from=app /app/node_modules ./node_modules
COPY --from=app /app/dist ./dist
COPY ops/render/map/ /data/
COPY ops/render/start.sh /usr/local/bin/start
RUN sed -i 's/\r$//' /usr/local/bin/start && chmod +x /usr/local/bin/start \
 && test -f /data/ncr.osrm.mldgr || (echo "ops/render/map/ has no built NCR graph: run ops/render/build-image.sh" && exit 1)

# Defaults for this image; Render's env vars override them.
# - NCR only: COVERAGE_BBOX matches the baked map, so Bengaluru points never reach OSRM.
# - OSRM_MMAP=1: read the map from disk on demand instead of loading ~430 MB into RAM, so it fits
#   the free tier's 512 MB next to Node. Measured 2026-11-10 at 512 MB / 0.1 CPU: ~45-57 MB used;
#   without mmap 490 MB (96%), too close to the limit.
# - OSRM_TIMEOUT_MS=2500 / ENRICH_DEADLINE_MS=3000: at 0.1 CPU a cross-NCR route took ~1.2 s and
#   hit the normal 1 s timeout; with 2.5 s all test routes answered (0.2-0.7 s once warm).
ENV NODE_ENV=production \
    ENV=PREPROD \
    PORT=10000 \
    OSRM_BASE_URL=http://127.0.0.1:5000 \
    OSRM_MAP=/data/ncr.osrm \
    OSRM_MMAP=1 \
    OSRM_TIMEOUT_MS=2500 \
    ENRICH_DEADLINE_MS=3000 \
    COVERAGE_BBOX=76.75,28.20,77.80,28.95 \
    DEV_VIEWER_ENABLED=false \
    REDIS_KEY_PREFIX=osrm-bff:render:

EXPOSE 10000
CMD ["start"]
