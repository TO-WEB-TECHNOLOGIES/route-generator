/**
 * POST /internal/v1/logistics/on_track: ondc-logistics-api forwards every processed /on_track here.
 * Contract: LOGISTICS_API_CHANGES.md. Answers 202 before any routing work, so the logistics
 * callback is never held up; 400 only for a body we can't use at all.
 */
import { Router, type Request, type Response } from "express";
import { parseLatLng } from "../geo/point.js";
import { logger } from "../logger.js";
import type { LogisticsOnTrackWebhook } from "../logistics/types.js";
import { recordTrack } from "../metrics.js";
import { handleOnTrack, type TrackDeps } from "../tracking/service.js";

type Parsed =
  | { ok: true; body: LogisticsOnTrackWebhook }
  /** Neither a position nor a tracking URL: nothing the frontend could show. */
  | { ok: true; empty: { orderId: string; configType?: string | undefined } }
  | { ok: false; error: string };

const optStr = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export function parseOnTrackWebhook(raw: unknown): Parsed {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "body must be a JSON object" };
  const b = raw as Record<string, unknown>;
  if (typeof b.orderId !== "string" || b.orderId === "" || b.orderId.length > 128) {
    return { ok: false, error: "orderId is required" };
  }
  // Missing gps is a valid /on_track (the LSP tracks by URL), so not a 400: the update is pushed
  // with tracking_url and no gps (2026-11-12). A gps that is present but unparsable is still a bug
  // on the sender's side.
  const hasGps = !(b.gps === undefined || b.gps === null || b.gps === "");
  if (hasGps && !parseLatLng(b.gps)) return { ok: false, error: 'gps must be "lat,lng"' };
  if (!hasGps && !optStr(b.url)) {
    const config = b.config as Record<string, unknown> | undefined;
    return { ok: true, empty: { orderId: b.orderId, configType: optStr(config?.type) } };
  }
  if (b.path !== undefined && b.path !== null && !Array.isArray(b.path)) return { ok: false, error: "path must be an array" };

  return {
    ok: true,
    body: {
      orderId: b.orderId,
      gps: hasGps ? (b.gps as string) : undefined,
      transactionId: optStr(b.transactionId),
      url: optStr(b.url),
      status: optStr(b.status),
      locationTimestamp: optStr(b.locationTimestamp),
      // Individual bad breadcrumbs are dropped later by the mapper, not rejected here (LSP data).
      path: Array.isArray(b.path) ? (b.path as LogisticsOnTrackWebhook["path"]) : undefined,
      updatedAt: optStr(b.updatedAt),
      fulfillmentState: optStr(b.fulfillmentState),
      startGps: optStr(b.startGps),
      endGps: optStr(b.endGps),
    },
  };
}

export function logisticsWebhookRouter(deps: TrackDeps): Router {
  const router = Router();
  router.post("/", (req: Request, res: Response) => {
    const parsed = parseOnTrackWebhook(req.body);
    if (!parsed.ok) {
      logger.warn("webhook", "on_track rejected", { error: parsed.error });
      return res.status(400).json({ error: parsed.error });
    }
    recordTrack("webhooks");
    res.status(202).json({ accepted: true });
    if ("empty" in parsed) {
      recordTrack("webhooks_no_gps");
      logger.info("webhook", "on_track without gps or url, nothing pushed", {
        order_id: parsed.empty.orderId,
        config_type: parsed.empty.configType ?? null,
      });
      return undefined;
    }
    // URL-based tracking (no gps): pushed with tracking_url, no routing (2026-11-12).
    if (!parsed.body.gps) recordTrack("webhooks_no_gps");
    // After answering: routing must never hold up the logistics callback.
    void handleOnTrack(deps, parsed.body).catch((err) =>
      logger.error("webhook", "handleOnTrack crashed", { order_id: parsed.body.orderId, error: String(err) }),
    );
    return undefined;
  });
  return router;
}
