import express, { type NextFunction, type Request, type Response } from "express";
import { logger } from "./logger.js";
import { metricsSnapshot } from "./metrics.js";
import { enrichRouter } from "./routes/enrich.routes.js";
import type { EnrichDeps } from "./routing/enrich.js";

export interface AppOptions {
  deps: EnrichDeps;
  internalToken?: string | undefined;
}

export function createApp({ deps, internalToken }: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  // Liveness only: no dependency checks, so a dead OSRM never takes this service out of rotation.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/metrics", (_req, res) => {
    res.json(metricsSnapshot());
  });

  const internal = express.Router();
  if (internalToken) {
    internal.use((req, res, next) => {
      if (req.get("x-internal-token") !== internalToken) return res.status(401).json({ error: "unauthorized" });
      return next();
    });
  }
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
