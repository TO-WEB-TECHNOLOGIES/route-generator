/**
 * Our own rider breadcrumbs for the logistics path (ROUTE-11, 2026-11-12).
 *
 * The LSP's `path[]` can't drive the trail: the workbench sends one point numbered "1" on every
 * /on_track, the ONDC spec doesn't say whether sequence 1 is the oldest or the newest point
 * (its example has `gps` equal to sequence 1), and an LSP may renumber or send no path at all.
 * Every GPS-tracked /on_track does carry the current `gps` (+ usually `locationTimestamp`), so we
 * record those ourselves, numbered by us, and feed them to the unchanged incremental /match.
 *
 * Pure: no I/O. The service loads/saves the entry through RouteCache.
 */
import { haversineMeters, type LatLng, type TimedPoint } from "../geo/point.js";
import type { CrumbsEntry } from "../routing/cache.js";

export type { Crumb, CrumbsEntry } from "../routing/cache.js";

export interface CrumbOptions {
  /** A point closer than this (m) to the last crumb is the rider standing still: not added. */
  minMoveM: number;
  /** Keep only the newest N crumbs (the unmatched tail + overlap is all /match ever needs). */
  maxPoints: number;
}

export type CrumbSkip = "older" | "not_moved";

/** ISO 8601 -> Unix seconds, or undefined when missing/unparsable. */
export function isoToUnixSeconds(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/**
 * Add one rider position. Returns the entry to save (unchanged when skipped) and why it was skipped.
 * - Older than the last crumb: a late/replayed /on_track. Skipped.
 * - Within `minMoveM` of the last crumb: rider not moving (or the same /on_track again). Skipped.
 * - Same timestamp but moved: the LSP didn't refresh its time; stored 1 s after the last crumb so
 *   timestamps stay non-decreasing for /match.
 */
export function appendCrumb(
  entry: CrumbsEntry | null,
  point: LatLng,
  unixSeconds: number,
  opts: CrumbOptions,
): { entry: CrumbsEntry; skipped?: CrumbSkip } {
  const current: CrumbsEntry = entry ?? { next_seq: 1, points: [] };
  const last = current.points[current.points.length - 1];
  if (last) {
    if (unixSeconds < last.t) return { entry: current, skipped: "older" };
    if (haversineMeters({ lat: last.lat, lng: last.lng }, point) < opts.minMoveM) {
      return { entry: current, skipped: "not_moved" };
    }
  }
  const t = last && unixSeconds <= last.t ? last.t + 1 : unixSeconds;
  const points = [...current.points, { lat: point.lat, lng: point.lng, t, seq: current.next_seq }];
  return {
    entry: {
      next_seq: current.next_seq + 1,
      points: points.slice(-Math.max(1, opts.maxPoints)),
    },
  };
}

/** Crumbs as the TimedPoints computeRoadPath() takes. */
export function crumbsToPath(entry: CrumbsEntry): TimedPoint[] {
  return entry.points.map((c) => ({ point: { lat: c.lat, lng: c.lng }, sequence: c.seq, unixSeconds: c.t }));
}
