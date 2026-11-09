import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { logger } from "./logger.js";
import { metricsSnapshot } from "./metrics.js";
import { enrichRouter } from "./routes/enrich.routes.js";
import { routeRouter } from "./routes/route.routes.js";
import type { EnrichDeps } from "./routing/enrich.js";

export interface AppOptions {
  deps: EnrichDeps;
  internalToken?: string | undefined;
}

/**
 * Shared-secret guard (X-Internal-Token). Pass-through when no token is configured.
 * Used for /internal/* and, until app login is decided (Q4), for /v1/route too.
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

export function createApp({ deps, internalToken }: AppOptions) {
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

  app.use("/v1/route", guard, routeRouter({ osrm: deps.osrm, coverage: deps.coverage }));

  const internal = express.Router();
  internal.use(guard);
  internal.use("/v1/track/enrich", enrichRouter(deps));
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
