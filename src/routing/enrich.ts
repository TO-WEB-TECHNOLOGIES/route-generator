/**
 * One GPS update in, the optional routing fields out. NEVER throws and never waits longer than one
 * OSRM timeout (route and match run in parallel). Anything that fails is simply omitted.
 */
import { formatLatLng, isInBbox, type Bbox, type LatLng, type TimedPoint } from "../geo/point.js";
import { logger } from "../logger.js";
import type { OsrmClient } from "../osrm/client.js";
import type { RouteCache } from "./cache.js";
import { computeRoadPath } from "./road-path.js";
import { computeRouteAhead, type RouteAhead } from "./route-ahead.js";
import { destinationFor, isTerminalStage } from "./stage.js";

export interface EnrichDeps {
  osrm: OsrmClient;
  cache: RouteCache;
  rerouteThresholdM: number;
  matchMinConfidence: number;
  matchOverlapPoints: number;
  matchMaxPoints: number;
  /** Area the map covers. Points outside never reach OSRM (ROUTE-09). Unset = no check. */
  coverage?: Bbox | undefined;
}

export interface EnrichInput {
  orderId: string;
  stage: string;
  rider: LatLng;
  storeGps?: LatLng | undefined;
  dropGps?: LatLng | undefined;
  path: readonly TimedPoint[];
}

/** Field names match the app-facing on_track contract so the BFF can spread this object in. */
export interface EnrichOutput {
  route_ahead?: RouteAhead;
  road_path?: string;
  drop_gps?: string;
}

export async function enrich(deps: EnrichDeps, input: EnrichInput): Promise<EnrichOutput> {
  const out: EnrichOutput = {};
  if (input.dropGps) out.drop_gps = formatLatLng(input.dropGps);

  if (isTerminalStage(input.stage)) {
    await deps.cache.clear(input.orderId);
    return out;
  }

  const to = destinationFor(input.stage);
  const destination = to === "store" ? input.storeGps : to === "drop" ? input.dropGps : undefined;

  // Outside the map, OSRM would snap to a road possibly hundreds of km away: never ask it.
  const covered = (p: LatLng) => !deps.coverage || isInBbox(p, deps.coverage);
  const canRoute = Boolean(to && destination && covered(input.rider) && covered(destination));
  const path = deps.coverage ? input.path.filter((p) => covered(p.point)) : input.path;

  const [ahead, trail] = await Promise.allSettled([
    canRoute && to && destination
      ? computeRouteAhead(deps, { orderId: input.orderId, stage: input.stage, rider: input.rider, to, destination })
      : Promise.resolve(undefined),
    computeRoadPath(deps, input.orderId, path),
  ]);

  if (ahead.status === "fulfilled" && ahead.value) out.route_ahead = ahead.value;
  else if (ahead.status === "rejected") logger.error("enrich", "route_ahead crashed", { order_id: input.orderId, error: String(ahead.reason) });

  if (trail.status === "fulfilled" && trail.value) out.road_path = trail.value;
  else if (trail.status === "rejected") logger.error("enrich", "road_path crashed", { order_id: input.orderId, error: String(trail.reason) });

  return out;
}
