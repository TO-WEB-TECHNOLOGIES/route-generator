/**
 * Events from ondc-logistics-api, copied structurally from
 * ../ondc-logistics-api/src/utils/streams/order-sse.ts (read-only there; keep in sync by hand).
 * Field names are camelCase on that stream.
 */

/** Published on every ONDC /on_track callback. `path` is the raw breadcrumb list: strings, no per-point time. */
export interface LogisticsTrackingEvent {
  event: "order_tracking";
  orderId: string;
  url?: string | undefined;
  status?: string | undefined;
  /** Current rider position, "lat,lng". */
  gps?: string | undefined;
  /** ISO 8601 time of `gps` only (tracking.location.time.timestamp). */
  locationTimestamp?: string | undefined;
  path?: Array<{ lat_lng?: string | undefined; sequence?: string | undefined }> | undefined;
  updatedAt: string;
}

/** Published on every ONDC /on_status. `fulfillmentState` is our `stage`. */
export interface LogisticsStatusEvent {
  event: "order_status";
  orderId: string;
  state?: string | undefined;
  fulfillmentState?: string | undefined;
  awbNo?: string | undefined;
  updatedAt: string;
}

/**
 * Store (pickup) and home (drop) GPS for an order: init-order `start_gps` / `end_gps` in the
 * logistics DB. No endpoint exposes them yet (understanding/05, Q3), so this shape is our proposal.
 */
export interface OrderEndpoints {
  startGps?: string | undefined;
  endGps?: string | undefined;
}

/**
 * Body of POST /internal/v1/logistics/on_track: the `order_tracking` event ondc-logistics-api
 * already builds, plus three fields we asked for (LOGISTICS_API_CHANGES.md). Extra fields it sends
 * (tags, config, trackedOrderId, fulfillmentId, …) are ignored.
 */
export interface LogisticsOnTrackWebhook {
  orderId: string;
  /** Missing for URL-based tracking (ONDC config `tracking.url` / `deferred`): `url` only (2026-11-12). */
  gps?: string | undefined;
  transactionId?: string | undefined;
  url?: string | undefined;
  status?: string | undefined;
  locationTimestamp?: string | undefined;
  path?: LogisticsTrackingEvent["path"];
  updatedAt?: string | undefined;
  /** Requested addition. Missing = fall back to GET /logistics/orders/:orderId/status. */
  fulfillmentState?: string | undefined;
  /** Requested additions: store and home GPS ("lat,lng"). Missing = no route ahead / home marker. */
  startGps?: string | undefined;
  endGps?: string | undefined;
}
