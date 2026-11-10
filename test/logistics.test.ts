/**
 * Part 2.1–2.3: logistics data (string sequences, no per-point timestamps, intercity/RTO stages)
 * through the mapper, the enrich endpoint parser, and the real OSRM HTTP client.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { DEFAULT_COVERAGE_BBOX } from "../src/config.js";
import { parseBbox, parseSequence } from "../src/geo/point.js";
import { breadcrumbsToPath, toEnrichInput } from "../src/logistics/mapper.js";
import type { LogisticsStatusEvent, LogisticsTrackingEvent, OrderEndpoints } from "../src/logistics/types.js";
import { createHttpOsrmClient } from "../src/osrm/client.js";
import { parseEnrichBody } from "../src/routes/enrich.routes.js";
import { enrich } from "../src/routing/enrich.js";
import { monotonic } from "../src/routing/road-path.js";
import { destinationFor, isTerminalStage } from "../src/routing/stage.js";
import { FakeOsrm, makeDeps, trail } from "./helpers/fakes.js";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/logistics/${name}`, import.meta.url), "utf8")) as T;

const tracking = fixture<LogisticsTrackingEvent>("order_tracking.ncr.json");
const status = fixture<LogisticsStatusEvent>("order_status.ncr.json");
const endpoints = fixture<OrderEndpoints>("order_endpoints.ncr.json");
const NCR = parseBbox(DEFAULT_COVERAGE_BBOX)!;

/** What ondc-logistics-api's track.repository does with ONDC /on_track tags (one group per point). */
function pathFromOnTrackTags(onTrack: any): LogisticsTrackingEvent["path"] {
  return (onTrack.message.tracking.tags as any[])
    .filter((t) => t.code === "path")
    .map((t) => ({
      lat_lng: t.list.find((v: any) => v.code === "lat_lng")?.value,
      sequence: t.list.find((v: any) => v.code === "sequence")?.value,
    }));
}

describe("parseSequence", () => {
  it("accepts numbers and numeric strings", () => {
    assert.equal(parseSequence(3), 3);
    assert.equal(parseSequence("3"), 3);
    assert.equal(parseSequence(" 12 "), 12);
  });
  it("rejects anything else", () => {
    for (const v of ["", "abc", "3a", NaN, Infinity, null, undefined, {}]) assert.equal(parseSequence(v), null, String(v));
  });
});

describe("logistics mapper", () => {
  it("maps the NCR order_tracking fixture: string sequences -> numbers, no timestamps", () => {
    const input = toEnrichInput(tracking, status.fulfillmentState!, endpoints)!;
    assert.equal(input.orderId, "od261109ncr0001");
    assert.equal(input.stage, "Order-picked-up");
    assert.deepEqual(input.rider, { lat: 28.497671, lng: 77.088763 }); // lat first, as in the string
    assert.deepEqual(input.storeGps, { lat: 28.49534, lng: 77.088059 });
    assert.deepEqual(input.dropGps, { lat: 28.459469, lng: 77.026635 });
    assert.deepEqual(input.path.map((p) => p.sequence), [1, 2, 3, 4, 5]);
    assert.ok(input.path.every((p) => p.unixSeconds === undefined));
  });

  it("maps the ONDC contract /on_track breadcrumbs the way logistics forwards them", () => {
    const path = breadcrumbsToPath(pathFromOnTrackTags(fixture("on_track.contract.json")));
    assert.deepEqual(
      path.map((p) => [p.point.lat, p.point.lng, p.sequence]),
      [
        [12.974002, 77.613458, 1],
        [12.974077, 77.6136, 2],
        [12.974098, 77.613699, 3],
      ],
    );
  });

  it("drops bad breadcrumbs (LSP data) instead of failing the update", () => {
    const path = breadcrumbsToPath([
      { lat_lng: "28.4953,77.0880", sequence: "1" },
      { lat_lng: "not-a-point", sequence: "2" },
      { lat_lng: "28.4954,77.0873", sequence: "" },
      { sequence: "4" },
      { lat_lng: "28.4962,77.0878", sequence: "1" }, // duplicate sequence: first wins
      { lat_lng: "28.4969,77.0885", sequence: "5" },
    ]);
    assert.deepEqual(path.map((p) => p.sequence), [1, 5]);
  });

  it("returns null without a usable rider position; endpoints are optional", () => {
    assert.equal(toEnrichInput({ ...tracking, gps: undefined }, "Order-picked-up"), null);
    assert.equal(toEnrichInput({ ...tracking, gps: "garbage" }, "Order-picked-up"), null);
    const noEndpoints = toEnrichInput(tracking, "Order-picked-up")!;
    assert.equal(noEndpoints.storeGps, undefined);
    assert.equal(noEndpoints.dropGps, undefined);
  });

  it("contract fixture (Bengaluru) through enrich: outside NCR, OSRM never called, only drop_gps", async () => {
    const onTrack = fixture<any>("on_track.contract.json");
    const event: LogisticsTrackingEvent = {
      event: "order_tracking",
      orderId: "O2",
      gps: onTrack.message.tracking.location.gps,
      path: pathFromOnTrackTags(onTrack),
      updatedAt: onTrack.message.tracking.location.updated_at,
    };
    const osrm = new FakeOsrm();
    const out = await enrich(
      makeDeps({ osrm, coverage: NCR }),
      toEnrichInput(event, "Out-for-delivery", { endGps: "12.9750,77.6200" })!,
    );
    assert.deepEqual(out, { drop_gps: "12.975,77.62" });
    assert.equal(osrm.routeCalls.length + osrm.matchCalls.length, 0);
  });
});

describe("enrich body: logistics-shaped path", () => {
  const base = { order_id: "o1", stage: "Out-for-delivery", gps: "28.4977,77.0888" };

  it("accepts path points without timestamp and with string sequences", () => {
    const parsed = parseEnrichBody({ ...base, path: tracking.path });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.input.path.map((p) => [p.sequence, p.unixSeconds]), [
      [1, undefined], [2, undefined], [3, undefined], [4, undefined], [5, undefined],
    ]);
  });

  it("still parses timestamps when sent (unchanged behavior)", () => {
    const parsed = parseEnrichBody({ ...base, path: [{ lat_lng: "28.4953,77.0880", sequence: 1, timestamp: "2026-11-09T10:00:00.000Z" }] });
    assert.ok(parsed.ok);
    assert.equal(parsed.input.path[0]!.unixSeconds, Date.parse("2026-11-09T10:00:00.000Z") / 1000);
  });

  it("400s on a non-numeric sequence or an unparsable timestamp", () => {
    for (const point of [
      { lat_lng: "28.4953,77.0880", sequence: "abc" },
      { lat_lng: "28.4953,77.0880", sequence: 1, timestamp: "yesterday" },
    ]) {
      const parsed = parseEnrichBody({ ...base, path: [point] });
      assert.equal(parsed.ok, false, JSON.stringify(point));
    }
  });
});

describe("stage table: logistics states (plan Phase 1.3)", () => {
  it("routes to the store for pickup and return-to-origin", () => {
    for (const s of ["Agent-assigned", "At-pickup", "Out-for-pickup", "RTO-Initiated"]) assert.equal(destinationFor(s), "store", s);
  });
  it("routes to the drop while the order is on its way", () => {
    for (const s of ["Order-picked-up", "Out-for-delivery", "In-transit", "At-destination-hub", "Delivery-rescheduled"]) {
      assert.equal(destinationFor(s), "drop", s);
    }
  });
  it("no route before assignment, on pickup/delivery problems, at delivery", () => {
    for (const s of ["Pending", "Searching-for-Agent", "Pickup-failed", "Pickup-rescheduled", "At-delivery", "Delivery-failed"]) {
      assert.equal(destinationFor(s), null, s);
      assert.equal(isTerminalStage(s), false, s);
    }
  });
  it("RTO-Delivered and RTO-Disposed are terminal (cache cleared)", () => {
    for (const s of ["RTO-Delivered", "RTO-Disposed"]) {
      assert.equal(destinationFor(s), null);
      assert.equal(isTerminalStage(s), true, s);
    }
  });
});

describe("monotonic with untimed points", () => {
  it("keeps untimed points and still drops timed points going backwards", () => {
    const [a, b, c] = trail(3);
    const untimed = { point: b!.point, sequence: 2 };
    const back = { ...c!, unixSeconds: a!.unixSeconds! - 5 };
    assert.deepEqual(monotonic([a!, untimed, back]).map((p) => p.sequence), [1, 2]);
    assert.equal(monotonic(trail(3).map(({ point, sequence }) => ({ point, sequence }))).length, 3);
  });
});

// ---- real HTTP client against a stub OSRM ----
type Reply = { status: number; body: unknown } | "hang";
let reply: Reply;
const urls: string[] = [];
const stub = createServer((req, res) => {
  urls.push(req.url ?? "");
  if (reply === "hang") return;
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body));
});
const okMatch = { status: 200, body: { code: "Ok", matchings: [{ geometry: "_p~iF~ps|U_ulLnnqC", confidence: 0.9 }] } };
const TIMEOUT_MS = 200;
let osrmUrl = "";

before(async () => {
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  osrmUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
after(() => {
  stub.closeAllConnections();
  stub.close();
});
beforeEach(() => {
  urls.length = 0;
  reply = okMatch;
});

const client = (baseUrl = osrmUrl) =>
  createHttpOsrmClient({ baseUrl, profile: "driving", timeoutMs: TIMEOUT_MS, maxSnapDistanceM: 200, matchRadiusM: 30 });

describe("OSRM /match URL with and without timestamps", () => {
  it("no timestamps anywhere: omits the parameter, still sends radiuses and lng,lat", async () => {
    const res = await client().match(toEnrichInput(tracking, "Order-picked-up")!.path);
    assert.ok(res.ok);
    const url = urls[0]!;
    assert.ok(url.startsWith("/match/v1/driving/77.088059,28.49534;77.087364,28.49547;"), url);
    assert.doesNotMatch(url, /timestamps=/);
    assert.match(url, /radiuses=30;30;30;30;30&overview=full&geometries=polyline$/);
  });

  it("all timestamps: sends them (unchanged behavior)", async () => {
    await client().match(trail(3));
    assert.match(urls[0]!, /\?timestamps=\d+;\d+;\d+&radiuses=/);
  });

  it("mixed window: omits timestamps (OSRM needs one per point or none)", async () => {
    const [a, b] = trail(2);
    await client().match([a!, { point: b!.point, sequence: 2 }]);
    assert.doesNotMatch(urls[0]!, /timestamps=/);
  });
});

describe("OSRM slow / down with logistics input (CLAUDE.md §6)", () => {
  const input = toEnrichInput(tracking, "Order-picked-up", endpoints)!;
  const depsWith = (osrmBase?: string) => makeDeps({ osrm: client(osrmBase), coverage: NCR });

  it("slow OSRM: answers within ~one timeout with only drop_gps", async () => {
    reply = "hang";
    const started = performance.now();
    const out = await enrich(depsWith(), input);
    const elapsed = performance.now() - started;
    assert.deepEqual(out, { drop_gps: "28.459469,77.026635" });
    assert.ok(elapsed < TIMEOUT_MS * 3, `took ${elapsed} ms`);
  });

  it("OSRM down (connection refused): only drop_gps, fast", async () => {
    const started = performance.now();
    const out = await enrich(depsWith("http://127.0.0.1:1"), input);
    assert.deepEqual(out, { drop_gps: "28.459469,77.026635" });
    assert.ok(performance.now() - started < TIMEOUT_MS * 3);
  });
});
