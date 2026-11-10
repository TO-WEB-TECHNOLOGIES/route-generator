import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { logger } from "./logger.js";
import { metricsSnapshot } from "./metrics.js";
import { devViewerRouter } from "./routes/dev-viewer.routes.js";
import { enrichRouter } from "./routes/enrich.routes.js";
import { logisticsWebhookRouter } from "./routes/logistics-webhook.routes.js";
import { routeRouter } from "./routes/route.routes.js";
import { trackRouter } from "./routes/track.routes.js";
import type { EnrichDeps } from "./routing/enrich.js";
import type { TrackDeps } from "./tracking/service.js";

export interface AppOptions {
  deps: EnrichDeps;
  internalToken?: string | undefined;
  /** Serve the dev map page at /dev/route-viewer (src/routes/dev-viewer.routes.ts). */
  devViewer?: boolean | undefined;
  /** Live tracking via ondc-logistics-api (/v1/track*, the on_track webhook). Unset = not mounted. */
  track?: Omit<TrackDeps, "enrich"> | undefined;
}

/**
 * Shared-secret guard (X-Internal-Token). Pass-through when no token is configured, which is
 * always the case with ENV=TEST (src/config.ts). Used for /internal/* and, until app login is
 * decided (Q4), for /v1/route and /v1/track* too.
 */
function requireInternalToken(token: string | undefined): RequestHandler {
  return (req, res, next) => {
    if (token && req.get("x-internal-token") !== token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function createApp({ deps, internalToken, devViewer = false, track }: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  const guard = requireInternalToken(internalToken);

  // Liveness only: no dependency checks, so a dead OSRM never takes this service out of rotation.
  // Served at "/" too, so opening the base URL shows the service is up instead of a 404.
  app.get(["/", "/health"], (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/metrics", (_req, res) => {
    res.json(metricsSnapshot());
  });

  // Dev only: the page itself is static; its API calls go through the guard below.
  if (devViewer) app.use("/dev/route-viewer", devViewerRouter());

  app.use("/v1/route", guard, routeRouter({ osrm: deps.osrm, coverage: deps.coverage }));
  if (track) app.use("/v1", guard, trackRouter(track));

  const internal = express.Router();
  internal.use(guard);
  internal.use("/v1/track/enrich", enrichRouter(deps));
  if (track) internal.use("/v1/logistics/on_track", logisticsWebhookRouter({ ...track, enrich: deps }));
  app.use("/internal", internal);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  // Express 5 forwards rejected promises here. Malformed JSON lands here too.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status >= 500) logger.error("http", "unhandled error", { error: err.message });
    res.status(status).json({ error: status >= 500 ? "internal error" : err.message });
  });

  return app;
}
