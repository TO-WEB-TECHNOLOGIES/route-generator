/**
 * Latest track_update per order, so a frontend that (re)connects gets the current state at once.
 * Derived and disposable: the next /on_track rebuilds it. Redis errors = miss, never a failure.
 *
 * Key (prefixed with REDIS_KEY_PREFIX), documented in docs/internal/routing.md:
 *   route:track:{order_id}  TrackUpdate  TTL TRACK_SNAPSHOT_TTL_S
 * Deletion: delete() on a final stage (tracking/service.ts), otherwise TTL.
 */
import type { Redis } from "ioredis";
import { logger } from "../logger.js";
import type { TrackUpdate } from "./service.js";

export const TRACK_SNAPSHOT_TTL_S = 2 * 60 * 60;
export const trackSnapshotKey = (orderId: string) => `route:track:${orderId}`;

export interface TrackSnapshotStore {
  get(orderId: string): Promise<TrackUpdate | null>;
  set(orderId: string, update: TrackUpdate): Promise<void>;
  delete(orderId: string): Promise<void>;
}

export function createRedisTrackSnapshotStore(redis: Redis): TrackSnapshotStore {
  return {
    async get(orderId) {
      try {
        const raw = await redis.get(trackSnapshotKey(orderId));
        return raw ? (JSON.parse(raw) as TrackUpdate) : null;
      } catch (err) {
        logger.warn("snapshot", "get failed, treating as miss", { order_id: orderId, error: (err as Error).message });
        return null;
      }
    },
    async set(orderId, update) {
      try {
        await redis.set(trackSnapshotKey(orderId), JSON.stringify(update), "EX", TRACK_SNAPSHOT_TTL_S);
      } catch (err) {
        logger.warn("snapshot", "set failed", { order_id: orderId, error: (err as Error).message });
      }
    },
    async delete(orderId) {
      try {
        await redis.del(trackSnapshotKey(orderId));
      } catch (err) {
        logger.warn("snapshot", "delete failed", { order_id: orderId, error: (err as Error).message });
      }
    },
  };
}
