/**
 * Frontend-facing live tracking. Contract: docs/integration-docs/track.md
 *   POST /v1/track                         { orderId } -> forwarded to POST /logistics/track
 *   GET  /v1/orders/:orderId/track         latest track_update (snapshot)
 *   GET  /v1/orders/:orderId/track/events  SSE: track_update / track_closed
 */
import { Router, type Request, type Response } from "express";
import type { TrackDeps } from "../tracking/service.js";

const MAX_ORDER_ID_LENGTH = 128;

const validOrderId = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "" && v.length <= MAX_ORDER_ID_LENGTH;

const invalidOrderId = (res: Response) =>
  res.status(400).json({ error: { code: "INVALID_ORDER_ID", message: "orderId must be a non-empty string" } });

export function trackRouter(deps: Pick<TrackDeps, "logistics" | "hub" | "snapshots">): Router {
  const router = Router();

  router.post("/track", async (req: Request, res: Response) => {
    const orderId = (req.body as Record<string, unknown> | undefined)?.orderId;
    if (!validOrderId(orderId)) return invalidOrderId(res);

    const r = await deps.logistics.requestTrack(orderId);
    if (r.kind === "unavailable") {
      return res.status(503).json({
        error: { code: "LOGISTICS_UNAVAILABLE", message: "The logistics API is unreachable or slow. Retry later." },
      });
    }
    // Passed through unchanged: 202 TRACK_SENT, or the logistics error (e.g. 60012 before pickup).
    if (typeof r.body === "object" && r.body !== null) return res.status(r.status).json(r.body);
    return res.status(r.status).type("text").send(r.body === null ? "" : String(r.body));
  });

  router.get("/orders/:orderId/track", async (req: Request, res: Response) => {
    const orderId = req.params.orderId;
    if (!validOrderId(orderId)) return invalidOrderId(res);
    const snapshot = await deps.snapshots.get(orderId);
    if (!snapshot) {
      return res.status(404).json({ error: { code: "NO_UPDATE_YET", message: "No tracking update for this order yet" } });
    }
    return res.json(snapshot);
  });

  router.get("/orders/:orderId/track/events", async (req: Request, res: Response) => {
    const orderId = req.params.orderId;
    if (!validOrderId(orderId)) return invalidOrderId(res);
    const send = deps.hub.subscribe(orderId, res);
    // Current state first, so a (re)connecting client never waits for the next /on_track.
    const snapshot = await deps.snapshots.get(orderId);
    if (snapshot && !res.writableEnded) send("track_update", snapshot, String(Date.parse(snapshot.updated_at) || Date.now()));
    return undefined;
  });

  return router;
}
