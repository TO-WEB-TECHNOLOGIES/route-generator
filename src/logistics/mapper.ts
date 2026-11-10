/**
 * Logistics events -> EnrichInput. Pure: no I/O, so it is tested against recorded fixtures.
 * Unlike the HTTP enrich endpoint (which 400s on bad input from our own BFF), data from the
 * logistics API comes from third-party LSPs, so bad breadcrumbs are dropped, not fatal.
 */
import { parseLatLng, parseSequence, type LatLng, type TimedPoint } from "../geo/point.js";
import type { EnrichInput } from "../routing/enrich.js";
import type { LogisticsTrackingEvent, OrderEndpoints } from "./types.js";

const optionalPoint = (s: string | undefined): LatLng | undefined => parseLatLng(s) ?? undefined;

/**
 * Breadcrumbs as TimedPoints. Points with a bad lat_lng or sequence are skipped. Duplicate
 * sequences keep the first. No timestamps: ONDC breadcrumbs don't carry them, so /match runs on
 * geometry alone and `sequence` is the only ordering.
 */
export function breadcrumbsToPath(path: LogisticsTrackingEvent["path"]): TimedPoint[] {
  const out: TimedPoint[] = [];
  const seen = new Set<number>();
  for (const crumb of path ?? []) {
    const point = parseLatLng(crumb?.lat_lng);
    const sequence = parseSequence(crumb?.sequence);
    if (!point || sequence === null || seen.has(sequence)) continue;
    seen.add(sequence);
    out.push({ point, sequence });
  }
  return out;
}

/**
 * One tracking event + the order's latest stage + its endpoints -> enrich input.
 * Returns null when there is nothing to enrich: no usable rider position.
 */
export function toEnrichInput(
  tracking: LogisticsTrackingEvent,
  stage: string,
  endpoints: OrderEndpoints = {},
): EnrichInput | null {
  const rider = parseLatLng(tracking.gps);
  if (!rider || tracking.orderId === "" || stage === "") return null;
  return {
    orderId: tracking.orderId,
    stage,
    rider,
    storeGps: optionalPoint(endpoints.startGps),
    dropGps: optionalPoint(endpoints.endGps),
    path: breadcrumbsToPath(tracking.path),
  };
}
