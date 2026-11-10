/**
 * One forwarded /on_track in, one track_update out to every open frontend stream of the order.
 *
 * Routing is decoration (CLAUDE.md §1): the stage lookup + enrich run under ENRICH_DEADLINE_MS.
 * If they're slower, the update goes out with only the GPS fields; enrich keeps running in the
 * background and its cache writes help the next update. Never throws.
 */
import { formatLatLng, parseLatLng } from "../geo/point.js";
import { logger } from "../logger.js";
import type { LogisticsClient } from "../logistics/client.js";
import { toEnrichInput } from "../logistics/mapper.js";
import type { LogisticsOnTrackWebhook } from "../logistics/types.js";
import { recordTrack } from "../metrics.js";
import { enrich, type EnrichDeps, type EnrichOutput } from "../routing/enrich.js";
import { isTerminalStage } from "../routing/stage.js";
import type { RouteAhead } from "../routing/route-ahead.js";
import type { TrackStreamHub } from "./hub.js";
import type { TrackSnapshotStore } from "./snapshot.js";

/** What the frontend receives (docs/integration-docs/track.md). snake_case like the on_track fields. */
export interface TrackUpdate {
  order_id: string;
  stage?: string;
  gps: string;
  gps_timestamp?: string;
  status?: string;
  tracking_url?: string;
  route_ahead?: RouteAhead;
  road_path?: string;
  drop_gps?: string;
  store_gps?: string;
  updated_at: string;
}

export interface TrackDeps {
  enrich: EnrichDeps;
  logistics: LogisticsClient;
  hub: TrackStreamHub;
  snapshots: TrackSnapshotStore;
  enrichDeadlineMs: number;
}

/** Stage placeholder when neither the payload nor the status fallback knows it: no route ahead. */
const UNKNOWN_STAGE = "Unknown";

const normalizedPoint = (s: string | undefined) => {
  const p = parseLatLng(s);
  return p ? formatLatLng(p) : undefined;
};

function deadline(ms: number): { promise: Promise<"deadline">; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export async function handleOnTrack(deps: TrackDeps, body: LogisticsOnTrackWebhook): Promise<TrackUpdate> {
  const orderId = body.orderId;
  const update: TrackUpdate = {
    order_id: orderId,
    gps: normalizedPoint(body.gps) ?? body.gps,
    updated_at: body.updatedAt ?? new Date().toISOString(),
  };
  if (body.fulfillmentState) update.stage = body.fulfillmentState;
  if (body.locationTimestamp) update.gps_timestamp = body.locationTimestamp;
  if (body.status) update.status = body.status;
  if (body.url) update.tracking_url = body.url;
  const drop = normalizedPoint(body.endGps);
  const store = normalizedPoint(body.startGps);
  if (drop) update.drop_gps = drop; // not routing: the home marker never waits on OSRM
  if (store) update.store_gps = store;

  const routing = (async (): Promise<{ stage: string | undefined; out: EnrichOutput }> => {
    const stage = body.fulfillmentState || (await deps.logistics.getFulfillmentState(orderId)) || undefined;
    const input = toEnrichInput(
      { event: "order_tracking", orderId, gps: body.gps, path: body.path, updatedAt: update.updated_at },
      stage ?? UNKNOWN_STAGE,
      { startGps: body.startGps, endGps: body.endGps },
    );
    return { stage, out: input ? await enrich(deps.enrich, input) : {} };
  })().catch((err) => {
    logger.error("track", "routing crashed", { order_id: orderId, error: String(err) });
    return null;
  });

  const timer = deadline(deps.enrichDeadlineMs);
  const result = await Promise.race([routing, timer.promise]);
  timer.cancel();

  if (result === "deadline") {
    recordTrack("routing_deadline_hit");
    logger.warn("track", "routing missed the deadline, pushing GPS only", { order_id: orderId, deadline_ms: deps.enrichDeadlineMs });
  } else if (result) {
    if (result.stage) update.stage = result.stage;
    if (result.out.route_ahead) update.route_ahead = result.out.route_ahead;
    if (result.out.road_path) update.road_path = result.out.road_path;
  }

  const streams = deps.hub.publish(orderId, "track_update", update, String(Date.parse(update.updated_at) || Date.now()));
  recordTrack("updates_pushed");

  if (update.stage && isTerminalStage(update.stage)) {
    deps.hub.close(orderId, "track_closed", { order_id: orderId, stage: update.stage });
    await deps.snapshots.delete(orderId);
  } else {
    await deps.snapshots.set(orderId, update);
  }
  logger.info("track", "update pushed", {
    order_id: orderId,
    streams,
    stage: update.stage ?? null,
    route_ahead: Boolean(update.route_ahead),
    road_path: Boolean(update.road_path),
  });
  return update;
}
