/**
 * Live tracking via ondc-logistics-api: POST /v1/track forwarding, the on_track webhook, the
 * frontend SSE stream, the snapshot, and ENV=TEST/PREPROD. Real HTTP logistics client against a
 * stub logistics server; OSRM is a fake (or one that never answers).
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { DEFAULT_COVERAGE_BBOX, loadConfig, parseAppEnv } from "../src/config.js";
import { parseCoverage } from "../src/geo/point.js";
import { createHttpLogisticsClient } from "../src/logistics/client.js";
import { metricsSnapshot } from "../src/metrics.js";
import type { OsrmClient } from "../src/osrm/client.js";
import { TrackStreamHub } from "../src/tracking/hub.js";
import { FakeOsrm, HangingOsrm, makeDeps, MemorySnapshotStore, openSse } from "./helpers/fakes.js";

const COVERAGE = parseCoverage(DEFAULT_COVERAGE_BBOX)!;
const LOGISTICS_TIMEOUT_MS = 200;
const DEADLINE_MS = 150;

// ---- stub ondc-logistics-api ----
type Reply = { status: number; body: unknown } | "hang";
let trackReply: Reply;
let statusReply: Reply;
const seen: Array<{ method: string; url: string; body: unknown }> = [];
const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : null));
  });
const logistics = createServer(async (req, res) => {
  const body = await readBody(req);
  seen.push({ method: req.method ?? "", url: req.url ?? "", body });
  const reply = req.url === "/logistics/track" ? trackReply : statusReply;
  if (reply === "hang") return;
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body));
});
let logisticsUrl = "";

// ---- app under test ----
const servers: Array<{ close: () => void }> = [];
function startApp(opts: { osrm?: OsrmClient; token?: string; logisticsBase?: string | null } = {}) {
  const snapshots = new MemorySnapshotStore();
  const hub = new TrackStreamHub(10_000);
  const osrm = opts.osrm ?? new FakeOsrm();
  const app = createApp({
    deps: makeDeps({ osrm, coverage: COVERAGE }),
    internalToken: opts.token,
    track: {
      logistics: createHttpLogisticsClient({
        baseUrl: opts.logisticsBase === null ? undefined : (opts.logisticsBase ?? logisticsUrl),
        timeoutMs: LOGISTICS_TIMEOUT_MS,
      }),
      hub,
      snapshots,
      enrichDeadlineMs: DEADLINE_MS,
    },
  });
  const server = app.listen(0);
  servers.push({ close: () => { hub.closeAll(); server.closeAllConnections(); server.close(); } });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, snapshots, hub, osrm };
}

before(async () => {
  await new Promise<void>((r) => logistics.listen(0, "127.0.0.1", r));
  logisticsUrl = `http://127.0.0.1:${(logistics.address() as AddressInfo).port}`;
});
after(() => {
  for (const s of servers) s.close();
  logistics.closeAllConnections();
  logistics.close();
});
beforeEach(() => {
  seen.length = 0;
  trackReply = { status: 202, body: { orderId: "x", transactionId: "t1", messageId: "m1", status: "TRACK_SENT" } };
  statusReply = { status: 200, body: { orderId: "x", fulfillmentState: "Out-for-delivery" } };
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

let counter = 0;
const newOrderId = () => `od-test-${++counter}`;

/** The user's real forwarded payload shape (2026-11-10), moved to NCR, plus the 3 requested fields. */
const webhookBody = (orderId: string, extra: Record<string, unknown> = {}) => ({
  event: "order_tracking",
  transactionId: "aff231e9-10fc-4f93-8b8a-4c4b55d115a3",
  orderId,
  status: "active",
  gps: "28.497671,77.088763",
  locationTimestamp: "2026-11-10T05:30:32.866Z",
  path: [
    { lat_lng: "28.495340,77.088059", sequence: "1" },
    { lat_lng: "28.495470,77.087364", sequence: "2" },
    { lat_lng: "28.497671,77.088763", sequence: "3" },
  ],
  updatedAt: "2026-11-10T05:30:34.472Z",
  fulfillmentId: "1",
  locationUpdatedAt: "2026-11-10T05:30:32.866Z",
  config: { attr: "tracking.location.gps", type: "live_poll" },
  trackedOrderId: orderId,
  tags: [{ code: "order", list: [{ code: "id", value: orderId }] }],
  fulfillmentState: "Order-picked-up",
  startGps: "28.495340,77.088059",
  endGps: "28.459469,77.026635",
  ...extra,
});

describe("POST /v1/track", () => {
  it("forwards { orderId } to POST /logistics/track and passes the 202 through", async () => {
    const { base } = startApp();
    const res = await post(`${base}/v1/track`, { orderId: "od1" });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { orderId: "x", transactionId: "t1", messageId: "m1", status: "TRACK_SENT" });
    assert.deepEqual(seen, [{ method: "POST", url: "/logistics/track", body: { orderId: "od1" } }]);
  });

  it("passes a logistics error through unchanged (e.g. 60012 before pickup)", async () => {
    trackReply = { status: 400, body: { error: { code: "60012", message: "Tracking not enabled" } } };
    const { base } = startApp();
    const res = await post(`${base}/v1/track`, { orderId: "od1" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: { code: "60012", message: "Tracking not enabled" } });
  });

  it("400 INVALID_ORDER_ID without calling logistics", async () => {
    const { base } = startApp();
    for (const body of [{}, { orderId: "" }, { orderId: 12 }, { orderId: "x".repeat(129) }]) {
      const res = await post(`${base}/v1/track`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(((await res.json()) as any).error.code, "INVALID_ORDER_ID");
    }
    assert.equal(seen.length, 0);
  });

  it("503 LOGISTICS_UNAVAILABLE within ~one timeout when logistics hangs, or isn't configured", async () => {
    trackReply = "hang";
    const { base } = startApp();
    const t0 = performance.now();
    const res = await post(`${base}/v1/track`, { orderId: "od1" });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as any).error.code, "LOGISTICS_UNAVAILABLE");
    assert.ok(performance.now() - t0 < LOGISTICS_TIMEOUT_MS * 3);

    const unconfigured = startApp({ logisticsBase: null });
    assert.equal((await post(`${unconfigured.base}/v1/track`, { orderId: "od1" })).status, 503);
  });
});

describe("on_track webhook -> frontend stream", () => {
  it("400 for a body without orderId or with an unparsable gps; 202 for the real payload shape", async () => {
    const { base } = startApp();
    const url = `${base}/internal/v1/logistics/on_track`;
    for (const body of [{ gps: "28.49,77.08" }, { orderId: "o1", gps: "garbage" }, { orderId: "o1", gps: "28.49,77.08", path: "x" }]) {
      assert.equal((await post(url, body)).status, 400, JSON.stringify(body));
    }
    const res = await post(url, webhookBody(newOrderId()));
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: true });
  });

  it("URL-based tracking (no gps, config type deferred): 202, nothing pushed, no snapshot, no OSRM call", async () => {
    const { base, osrm } = startApp();
    const orderId = newOrderId();
    const s = await openSse(`${base}/v1/orders/${orderId}/track/events`);
    const { gps: _gps, path: _path, locationTimestamp: _ts, ...rest } = webhookBody(orderId);
    const deferred = {
      ...rest,
      url: "https://lsp.example/track/od1",
      config: { attr: "tracking.url", type: "deferred" },
    };
    const before = metricsSnapshot().track;
    for (const body of [deferred, { ...deferred, gps: null }, { ...deferred, gps: "" }] as Array<Record<string, unknown>>) {
      const res = await post(`${base}/internal/v1/logistics/on_track`, body);
      assert.equal(res.status, 202, JSON.stringify(body.gps));
      assert.deepEqual(await res.json(), { accepted: true });
    }
    await new Promise((r) => setTimeout(r, DEADLINE_MS + 50));
    assert.equal(s.events.length, 0);
    assert.equal((await fetch(`${base}/v1/orders/${orderId}/track`)).status, 404);
    assert.equal((osrm as FakeOsrm).routeCalls.length + (osrm as FakeOsrm).matchCalls.length, 0);
    const afterSnap = metricsSnapshot().track;
    assert.equal(afterSnap.webhooks_no_gps - before.webhooks_no_gps, 3);
    assert.equal(afterSnap.updates_pushed, before.updates_pushed);
    s.close();
  });

  it("pushes one track_update with routing fields to every open stream; the snapshot serves it", async () => {
    const { base } = startApp();
    const orderId = newOrderId();
    const a = await openSse(`${base}/v1/orders/${orderId}/track/events`);
    const b = await openSse(`${base}/v1/orders/${orderId}/track/events`);
    assert.equal(a.res.status, 200);
    assert.match(a.res.headers.get("content-type") ?? "", /text\/event-stream/);

    assert.equal((await post(`${base}/internal/v1/logistics/on_track`, webhookBody(orderId))).status, 202);
    await a.waitFor(() => a.events.length === 1);
    await b.waitFor(() => b.events.length === 1);

    const ev = a.events[0]!;
    assert.equal(ev.event, "track_update");
    assert.equal(ev.id, String(Date.parse("2026-11-10T05:30:34.472Z")));
    assert.deepEqual(ev.data, {
      order_id: orderId,
      stage: "Order-picked-up",
      gps: "28.497671,77.088763",
      gps_timestamp: "2026-11-10T05:30:32.866Z",
      status: "active",
      route_ahead: { polyline: "_p~iF~ps|U_ulLnnqC", to: "drop", distance_m: 2140, duration_s: 380 },
      road_path: ev.data.road_path,
      drop_gps: "28.459469,77.026635",
      store_gps: "28.49534,77.088059",
      updated_at: "2026-11-10T05:30:34.472Z",
    });
    assert.equal(typeof ev.data.road_path, "string");
    assert.deepEqual(b.events[0]!.data, ev.data);

    const snap = await fetch(`${base}/v1/orders/${orderId}/track`);
    assert.equal(snap.status, 200);
    assert.deepEqual(await snap.json(), ev.data);
    a.close();
    b.close();
  });

  it("a stream opened later gets the latest update first; GET before any update is 404", async () => {
    const { base } = startApp();
    const orderId = newOrderId();
    const before = await fetch(`${base}/v1/orders/${orderId}/track`);
    assert.equal(before.status, 404);
    assert.equal(((await before.json()) as any).error.code, "NO_UPDATE_YET");

    await post(`${base}/internal/v1/logistics/on_track`, webhookBody(orderId));
    // Wait until the snapshot exists, then connect.
    for (let i = 0; i < 100 && (await fetch(`${base}/v1/orders/${orderId}/track`)).status !== 200; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const late = await openSse(`${base}/v1/orders/${orderId}/track/events`);
    await late.waitFor(() => late.events.length === 1);
    assert.equal(late.events[0]!.event, "track_update");
    assert.equal(late.events[0]!.data.order_id, orderId);
    late.close();
  });

  it("OSRM slow (CLAUDE.md §6): webhook answers at once; the update still arrives within the deadline, GPS fields only", async () => {
    const { base } = startApp({ osrm: new HangingOsrm() });
    const orderId = newOrderId();
    const s = await openSse(`${base}/v1/orders/${orderId}/track/events`);

    const t0 = performance.now();
    const res = await post(`${base}/internal/v1/logistics/on_track`, webhookBody(orderId));
    assert.equal(res.status, 202);
    assert.ok(performance.now() - t0 < 100, "webhook must not wait for routing");

    await s.waitFor(() => s.events.length === 1, DEADLINE_MS * 4);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < DEADLINE_MS * 3, `update took ${elapsed} ms`);
    const data = s.events[0]!.data;
    assert.equal(data.gps, "28.497671,77.088763");
    assert.equal(data.stage, "Order-picked-up");
    assert.equal(data.drop_gps, "28.459469,77.026635"); // home marker never waits on OSRM
    assert.equal(data.route_ahead, undefined);
    assert.equal(data.road_path, undefined);
    s.close();
  });

  it("no fulfillmentState in the payload: falls back to GET /logistics/orders/:id/status", async () => {
    const { base } = startApp();
    const orderId = newOrderId();
    const s = await openSse(`${base}/v1/orders/${orderId}/track/events`);
    await post(`${base}/internal/v1/logistics/on_track`, webhookBody(orderId, { fulfillmentState: undefined }));
    await s.waitFor(() => s.events.length === 1);
    assert.ok(seen.some((r) => r.method === "GET" && r.url === `/logistics/orders/${orderId}/status`));
    assert.equal(s.events[0]!.data.stage, "Out-for-delivery");
    assert.equal(s.events[0]!.data.route_ahead.to, "drop");
    s.close();
  });

  it("no stage anywhere (status endpoint down): update arrives without route_ahead", async () => {
    statusReply = { status: 500, body: {} };
    const { base } = startApp();
    const orderId = newOrderId();
    const s = await openSse(`${base}/v1/orders/${orderId}/track/events`);
    await post(`${base}/internal/v1/logistics/on_track`, webhookBody(orderId, { fulfillmentState: undefined }));
    await s.waitFor(() => s.events.length === 1);
    assert.equal(s.events[0]!.data.stage, undefined);
    assert.equal(s.events[0]!.data.route_ahead, undefined);
    assert.equal(s.events[0]!.data.gps, "28.497671,77.088763");
    s.close();
  });

  it("final stage: track_update, then track_closed, the stream ends and the snapshot is dropped", async () => {
    const { base } = startApp();
    const orderId = newOrderId();
    await post(`${base}/internal/v1/logistics/on_track`, webhookBody(orderId)); // builds a snapshot
    const s = await openSse(`${base}/v1/orders/${orderId}/track/events`);
    await s.waitFor(() => s.events.length === 1); // the snapshot

    await post(`${base}/internal/v1/logistics/on_track`, webhookBody(orderId, { fulfillmentState: "Order-delivered" }));
    await s.waitFor(() => s.ended);
    assert.deepEqual(s.events.map((e) => e.event), ["track_update", "track_update", "track_closed"]);
    assert.deepEqual(s.events[2]!.data, { order_id: orderId, stage: "Order-delivered" });
    assert.equal(s.events[1]!.data.route_ahead, undefined);
    assert.equal((await fetch(`${base}/v1/orders/${orderId}/track`)).status, 404);
  });

  it("order outside every covered box (Mumbai): GPS-only update, OSRM never called", async () => {
    const osrm = new FakeOsrm();
    const { base } = startApp({ osrm });
    const orderId = newOrderId();
    const s = await openSse(`${base}/v1/orders/${orderId}/track/events`);
    await post(`${base}/internal/v1/logistics/on_track`, {
      ...webhookBody(orderId),
      gps: "19.0760,72.8777",
      path: [{ lat_lng: "19.0760,72.8777", sequence: "1" }],
      startGps: "19.0700,72.8700",
      endGps: "19.0800,72.8800",
    });
    await s.waitFor(() => s.events.length === 1);
    assert.equal(s.events[0]!.data.gps, "19.076,72.8777");
    assert.equal(s.events[0]!.data.route_ahead, undefined);
    assert.equal(s.events[0]!.data.road_path, undefined);
    assert.equal(osrm.routeCalls.length + osrm.matchCalls.length, 0);
    s.close();
  });

  it("the user's Bengaluru order (covered since 2026-11-10): routes built", async () => {
    const osrm = new FakeOsrm();
    const { base } = startApp({ osrm });
    const orderId = newOrderId();
    const s = await openSse(`${base}/v1/orders/${orderId}/track/events`);
    await post(`${base}/internal/v1/logistics/on_track`, {
      ...webhookBody(orderId),
      gps: "12.9740,77.6134",
      path: [{ lat_lng: "12.9730,77.6120", sequence: "1" }, { lat_lng: "12.9740,77.6134", sequence: "2" }],
      startGps: "12.9716,77.5946",
      endGps: "12.9352,77.6245",
    });
    await s.waitFor(() => s.events.length === 1);
    assert.equal(s.events[0]!.data.route_ahead.to, "drop");
    assert.equal(typeof s.events[0]!.data.road_path, "string");
    assert.equal(osrm.routeCalls.length, 1);
    s.close();
  });
});

describe("token guard on the new routes (ENV=PREPROD behavior)", () => {
  it("401 without X-Internal-Token on POST /v1/track, the snapshot, the stream and the webhook", async () => {
    const { base } = startApp({ token: "t0ken" });
    assert.equal((await post(`${base}/v1/track`, { orderId: "od1" })).status, 401);
    assert.equal((await fetch(`${base}/v1/orders/od1/track`)).status, 401);
    assert.equal((await fetch(`${base}/v1/orders/od1/track/events`)).status, 401);
    assert.equal((await post(`${base}/internal/v1/logistics/on_track`, webhookBody("od1"))).status, 401);
    assert.equal(seen.length, 0);
    assert.equal((await post(`${base}/v1/track`, { orderId: "od1" }, { "x-internal-token": "t0ken" })).status, 202);
  });
});

describe("ENV config", () => {
  const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) {
      saved[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  it("parses TEST / PREPROD (any case); unset = PREPROD; anything else throws", () => {
    assert.equal(parseAppEnv("TEST"), "TEST");
    assert.equal(parseAppEnv("preprod"), "PREPROD");
    assert.equal(parseAppEnv(undefined), "PREPROD");
    assert.equal(parseAppEnv(""), "PREPROD");
    assert.throws(() => parseAppEnv("PROD"), /ENV must be TEST or PREPROD/);
  });

  it("TEST: token ignored even if INTERNAL_TOKEN is set; dev viewer on by default", () => {
    withEnv({ ENV: "TEST", INTERNAL_TOKEN: "secret", DEV_VIEWER_ENABLED: undefined }, () => {
      const c = loadConfig();
      assert.equal(c.env, "TEST");
      assert.equal(c.internalToken, undefined);
      assert.equal(c.devViewerEnabled, true);
    });
  });

  it("PREPROD: refuses to start without INTERNAL_TOKEN; with it, the token is enforced and the viewer is off", () => {
    withEnv({ ENV: "PREPROD", INTERNAL_TOKEN: undefined }, () => {
      assert.throws(() => loadConfig(), /ENV=PREPROD requires INTERNAL_TOKEN/);
    });
    withEnv({ ENV: undefined, INTERNAL_TOKEN: undefined }, () => {
      assert.throws(() => loadConfig(), /requires INTERNAL_TOKEN/); // unset = PREPROD: fail closed
    });
    withEnv({ ENV: "PREPROD", INTERNAL_TOKEN: "secret", DEV_VIEWER_ENABLED: undefined }, () => {
      const c = loadConfig();
      assert.equal(c.internalToken, "secret");
      assert.equal(c.devViewerEnabled, false);
    });
  });
});
