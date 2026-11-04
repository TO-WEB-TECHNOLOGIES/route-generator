/**
 * Route cache. Derived and disposable: flushing it only costs a re-route / re-match.
 * Redis errors are treated as cache misses and never fail a request.
 *
 * Keys (prefixed with REDIS_KEY_PREFIX by ioredis), documented in docs/internal/routing.md:
 *   route:ahead:{order_id}  RouteAheadEntry  TTL ROUTE_AHEAD_TTL_S
 *   route:trail:{order_id}  TrailEntry       TTL ROUTE_TRAIL_TTL_S
 * Deletion: clear() on a terminal stage (enrich.ts), otherwise TTL.
 */
import type { Redis } from "ioredis";
import type { LatLng } from "../geo/point.js";
import { logger } from "../logger.js";
import type { Destination } from "./stage.js";

export const ROUTE_AHEAD_TTL_S = 2 * 60 * 60;
export const ROUTE_TRAIL_TTL_S = 2 * 60 * 60;

export const routeAheadKey = (orderId: string) => `route:ahead:${orderId}`;
export const routeTrailKey = (orderId: string) => `route:trail:${orderId}`;

export interface RouteAheadEntry {
  polyline: string;
  distance_m: number;
  duration_s: number;
  to: Destination;
  /** Rider point and stage the route was built from (for the re-route check). */
  from: LatLng;
  stage: string;
}

export interface TrailEntry {
  polyline: string;
  last_seq: number;
}

export interface RouteCache {
  getAhead(orderId: string): Promise<RouteAheadEntry | null>;
  setAhead(orderId: string, entry: RouteAheadEntry): Promise<void>;
  getTrail(orderId: string): Promise<TrailEntry | null>;
  setTrail(orderId: string, entry: TrailEntry): Promise<void>;
  clear(orderId: string): Promise<void>;
}

export function createRedisRouteCache(redis: Redis): RouteCache {
  async function get<T>(key: string): Promise<T | null> {
    try {
      const raw = await redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      logger.warn("cache", "get failed, treating as miss", { key, error: (err as Error).message });
      return null;
    }
  }
  async function set(key: string, ttl: number, value: unknown): Promise<void> {
    try {
      await redis.set(key, JSON.stringify(value), "EX", ttl);
    } catch (err) {
      logger.warn("cache", "set failed", { key, error: (err as Error).message });
    }
  }
  return {
    getAhead: (id) => get<RouteAheadEntry>(routeAheadKey(id)),
    setAhead: (id, e) => set(routeAheadKey(id), ROUTE_AHEAD_TTL_S, e),
    getTrail: (id) => get<TrailEntry>(routeTrailKey(id)),
    setTrail: (id, e) => set(routeTrailKey(id), ROUTE_TRAIL_TTL_S, e),
    async clear(id) {
      try {
        await redis.del(routeAheadKey(id), routeTrailKey(id));
      } catch (err) {
        logger.warn("cache", "clear failed", { order_id: id, error: (err as Error).message });
      }
    },
  };
}
