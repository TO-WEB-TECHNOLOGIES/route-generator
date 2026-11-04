/**
 * Route ahead: rider -> current destination. Re-routes only when the rider moved more than
 * rerouteThresholdM from the cached route's origin, or the stage changed.
 */
import { haversineMeters, type LatLng } from "../geo/point.js";
import type { OsrmClient } from "../osrm/client.js";
import type { RouteCache } from "./cache.js";
import type { Destination } from "./stage.js";

export interface RouteAhead {
  polyline: string;
  to: Destination;
  distance_m: number;
  duration_s: number;
}

export interface RouteAheadDeps {
  osrm: OsrmClient;
  cache: RouteCache;
  rerouteThresholdM: number;
}

export interface RouteAheadInput {
  orderId: string;
  stage: string;
  rider: LatLng;
  to: Destination;
  destination: LatLng;
}

/** Returns undefined when no route is available this update (the field is then omitted). */
export async function computeRouteAhead(
  deps: RouteAheadDeps,
  input: RouteAheadInput,
): Promise<RouteAhead | undefined> {
  const cached = await deps.cache.getAhead(input.orderId);
  if (
    cached &&
    cached.stage === input.stage &&
    cached.to === input.to &&
    haversineMeters(cached.from, input.rider) <= deps.rerouteThresholdM
  ) {
    return { polyline: cached.polyline, to: cached.to, distance_m: cached.distance_m, duration_s: cached.duration_s };
  }

  const res = await deps.osrm.route(input.rider, input.destination);
  if (!res.ok) return undefined;

  const result: RouteAhead = {
    polyline: res.polyline,
    to: input.to,
    distance_m: res.distanceM,
    duration_s: res.durationS,
  };
  await deps.cache.setAhead(input.orderId, { ...result, from: input.rider, stage: input.stage });
  return result;
}
