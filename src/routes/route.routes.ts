/**
 * GET /v1/route?from=lat,lng&to=lat,lng — contract: docs/integration-docs/route.md
 * Unlike enrich, failures are real errors here (the route IS the answer). Callers still treat
 * every error as "draw a straight line".
 */
import { Router, type Request, type Response } from "express";
import { formatLatLng, isInBbox, parseLatLng, type Bbox } from "../geo/point.js";
import type { OsrmClient } from "../osrm/client.js";

export interface RouteDeps {
  osrm: OsrmClient;
  coverage?: Bbox | undefined;
}

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

export function routeRouter(deps: RouteDeps): Router {
  const router = Router();
  router.get("/", async (req: Request, res: Response) => {
    const from = parseLatLng(req.query.from);
    const to = parseLatLng(req.query.to);
    if (!from || !to) {
      return fail(res, 400, "INVALID_POINT", 'Query params "from" and "to" are required as "lat,lng"');
    }
    if (deps.coverage && (!isInBbox(from, deps.coverage) || !isInBbox(to, deps.coverage))) {
      return fail(res, 422, "OUT_OF_COVERAGE", "A point is outside the area covered by the routing map");
    }

    const r = await deps.osrm.route(from, to);
    if (r.ok) {
      return res.status(200).json({
        from: formatLatLng(from),
        to: formatLatLng(to),
        polyline: r.polyline,
        distance_m: r.distanceM,
        duration_s: r.durationS,
      });
    }
    if (r.reason === "no_result") {
      return fail(res, 404, "NO_ROUTE", "No road route between these points");
    }
    return fail(res, 503, "ROUTING_UNAVAILABLE", "Routing is temporarily unavailable");
  });
  return router;
}
