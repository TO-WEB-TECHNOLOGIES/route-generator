/**
 * POST /internal/v1/track/enrich — contract: docs/integration-docs/track-enrich.md
 * 400 only for malformed input. Routing failures are a 200 with the fields omitted.
 */
import { Router, type Request, type Response } from "express";
import { parseLatLng, type LatLng, type TimedPoint } from "../geo/point.js";
import { enrich, type EnrichDeps, type EnrichInput } from "../routing/enrich.js";

type Parsed = { ok: true; input: EnrichInput } | { ok: false; error: string };

function toUnixSeconds(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

function optionalGps(body: Record<string, unknown>, field: string): LatLng | undefined | "invalid" {
  const v = body[field];
  if (v === undefined || v === null || v === "") return undefined;
  return parseLatLng(v) ?? "invalid";
}

export function parseEnrichBody(body: unknown): Parsed {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;

  if (typeof b.order_id !== "string" || b.order_id === "") return { ok: false, error: "order_id is required" };
  if (typeof b.stage !== "string" || b.stage === "") return { ok: false, error: "stage is required" };

  const rider = parseLatLng(b.gps);
  if (!rider) return { ok: false, error: 'gps is required as "lat,lng"' };

  const storeGps = optionalGps(b, "store_gps");
  if (storeGps === "invalid") return { ok: false, error: 'store_gps must be "lat,lng"' };
  const dropGps = optionalGps(b, "drop_gps");
  if (dropGps === "invalid") return { ok: false, error: 'drop_gps must be "lat,lng"' };

  const rawPath = b.path ?? [];
  if (!Array.isArray(rawPath)) return { ok: false, error: "path must be an array" };
  const path: TimedPoint[] = [];
  for (const [i, raw] of rawPath.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const point = parseLatLng(r.lat_lng);
    const unixSeconds = toUnixSeconds(r.timestamp);
    if (!point || typeof r.sequence !== "number" || unixSeconds === null) {
      return { ok: false, error: `path[${i}] needs lat_lng ("lat,lng"), numeric sequence and timestamp` };
    }
    path.push({ point, sequence: r.sequence, unixSeconds });
  }

  return {
    ok: true,
    input: { orderId: b.order_id, stage: b.stage, rider, storeGps, dropGps, path },
  };
}

export function enrichRouter(deps: EnrichDeps): Router {
  const router = Router();
  router.post("/", async (req: Request, res: Response) => {
    const parsed = parseEnrichBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const result = await enrich(deps, parsed.input);
    return res.status(200).json(result);
  });
  return router;
}
