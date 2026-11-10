import { Redis } from "ioredis";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { startKeepalive } from "./keepalive.js";
import { createHttpLogisticsClient } from "./logistics/client.js";
import { setOpenStreamsGauge } from "./metrics.js";
import { createHttpOsrmClient } from "./osrm/client.js";
import { createRedisRouteCache } from "./routing/cache.js";
import { TrackStreamHub } from "./tracking/hub.js";
import { createRedisTrackSnapshotStore } from "./tracking/snapshot.js";

try {
  process.loadEnvFile(); // .env for local dev; real deployments inject env vars
} catch {
  /* no .env file */
}

const config = loadConfig();

const redis = new Redis(config.redisUrl, {
  keyPrefix: config.redisKeyPrefix,
  commandTimeout: config.redisCommandTimeoutMs,
  maxRetriesPerRequest: 1,
  // Fail fast while disconnected instead of queueing: Redis down must read as a cache miss.
  enableOfflineQueue: false,
});
redis.on("ready", () => logger.info("redis", "ready"));
redis.on("error", (err) => logger.warn("redis", "error", { error: err.message }));

const hub = new TrackStreamHub(config.sseKeepaliveMs);
setOpenStreamsGauge(() => hub.openStreams());

const app = createApp({
  internalToken: config.internalToken,
  devViewer: config.devViewerEnabled,
  track: {
    logistics: createHttpLogisticsClient({ baseUrl: config.logisticsBaseUrl, timeoutMs: config.logisticsTimeoutMs }),
    hub,
    snapshots: createRedisTrackSnapshotStore(redis),
    enrichDeadlineMs: config.enrichDeadlineMs,
  },
  deps: {
    osrm: createHttpOsrmClient({
      baseUrl: config.osrmBaseUrl,
      profile: config.osrmProfile,
      timeoutMs: config.osrmTimeoutMs,
      maxSnapDistanceM: config.maxSnapDistanceM,
      matchRadiusM: config.matchRadiusM,
    }),
    cache: createRedisRouteCache(redis),
    rerouteThresholdM: config.rerouteThresholdM,
    matchMinConfidence: config.matchMinConfidence,
    matchOverlapPoints: config.matchOverlapPoints,
    matchMaxPoints: config.matchMaxPoints,
    coverage: config.coverage,
  },
});

let stopKeepalive = () => {};
const server = app.listen(config.port, () => {
  logger.info("server", "listening", {
    env: config.env,
    token_required: Boolean(config.internalToken),
    logistics: config.logisticsBaseUrl ?? "not configured",
    port: config.port,
    osrm: config.osrmBaseUrl,
    coverage: config.coverage ?? "none",
  });
  if (config.keepaliveUrl) {
    stopKeepalive = startKeepalive({ url: config.keepaliveUrl, intervalMs: config.keepaliveIntervalMs, timeoutMs: 10_000 });
  }
  if (config.devViewerEnabled) logger.info("server", "dev route viewer", { url: `http://127.0.0.1:${config.port}/dev/route-viewer` });
});

function shutdown(signal: string) {
  logger.info("server", "shutting down", { signal });
  stopKeepalive();
  hub.closeAll(); // open SSE streams would keep server.close() waiting
  server.close(() => {
    redis.quit().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
