import { Redis } from "ioredis";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createHttpOsrmClient } from "./osrm/client.js";
import { createRedisRouteCache } from "./routing/cache.js";

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

const app = createApp({
  internalToken: config.internalToken,
  deps: {
    osrm: createHttpOsrmClient({
      baseUrl: config.osrmBaseUrl,
      profile: config.osrmProfile,
      timeoutMs: config.osrmTimeoutMs,
    }),
    cache: createRedisRouteCache(redis),
    rerouteThresholdM: config.rerouteThresholdM,
    matchMinConfidence: config.matchMinConfidence,
    matchOverlapPoints: config.matchOverlapPoints,
    matchMaxPoints: config.matchMaxPoints,
  },
});

const server = app.listen(config.port, () => {
  logger.info("server", "listening", { port: config.port, osrm: config.osrmBaseUrl });
});

function shutdown(signal: string) {
  logger.info("server", "shutting down", { signal });
  server.close(() => {
    redis.quit().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
