/**
 * Rider trail snapped to roads, matched incrementally: only the new tail of `path` (plus a few
 * overlap points so the pieces join) goes to OSRM /match, and the result is appended to the cached
 * polyline. Never re-match the whole trail; it grows with the order.
 */
import type { TimedPoint } from "../geo/point.js";
import { decodePolyline, encodePolyline, joinPaths } from "../geo/polyline.js";
import type { OsrmClient } from "../osrm/client.js";
import type { RouteCache } from "./cache.js";

export interface RoadPathDeps {
  osrm: OsrmClient;
  cache: RouteCache;
  matchMinConfidence: number;
  matchOverlapPoints: number;
  matchMaxPoints: number;
}

/** OSRM requires non-decreasing timestamps; drop points that go back in time. */
export function monotonic(points: readonly TimedPoint[]): TimedPoint[] {
  const out: TimedPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && p.unixSeconds < last.unixSeconds) continue;
    out.push(p);
  }
  return out;
}

/** Returns the full matched trail polyline, or undefined to omit road_path this update. */
export async function computeRoadPath(
  deps: RoadPathDeps,
  orderId: string,
  path: readonly TimedPoint[],
): Promise<string | undefined> {
  const sorted = [...path].sort((a, b) => a.sequence - b.sequence);
  const cached = await deps.cache.getTrail(orderId);
  const lastSeq = cached?.last_seq ?? Number.NEGATIVE_INFINITY;

  const tail = sorted.filter((p) => p.sequence > lastSeq);
  if (tail.length === 0) return cached?.polyline; // nothing new (duplicate update): resend

  const overlap =
    cached && deps.matchOverlapPoints > 0 // slice(-0) would return everything
      ? sorted.filter((p) => p.sequence <= lastSeq).slice(-deps.matchOverlapPoints)
      : [];
  // Oldest first, capped: a long backlog catches up over the next few updates.
  const window = monotonic([...overlap, ...tail]).slice(0, deps.matchMaxPoints);
  if (window.length < 2) return cached?.polyline;

  const res = await deps.osrm.match(window);
  if (!res.ok || res.minConfidence < deps.matchMinConfidence) {
    // Don't advance last_seq: the next update retries with more context (ARCHITECTURE_REVIEW: ROUTE-04).
    return undefined;
  }

  const matched = res.geometries.reduce((acc, g) => joinPaths(acc, decodePolyline(g)), [] as ReturnType<typeof decodePolyline>);
  const merged = cached ? joinPaths(decodePolyline(cached.polyline), matched) : matched;
  const polyline = encodePolyline(merged);
  const newLastSeq = window[window.length - 1]!.sequence;

  await deps.cache.setTrail(orderId, { polyline, last_seq: newLastSeq });
  return polyline;
}
