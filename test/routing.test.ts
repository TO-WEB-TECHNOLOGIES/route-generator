import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodePolyline } from "../src/geo/polyline.js";
import { enrich } from "../src/routing/enrich.js";
import { monotonic } from "../src/routing/road-path.js";
import { destinationFor, isTerminalStage } from "../src/routing/stage.js";
import { FakeOsrm, MemoryRouteCache, makeDeps, trail } from "./helpers/fakes.js";

const STORE = { lat: 28.42, lng: 77.03 };
const DROP = { lat: 28.4351, lng: 77.0512 };
const RIDER = { lat: 28.4302136, lng: 77.0433475 };

const base = { orderId: "od1", rider: RIDER, storeGps: STORE, dropGps: DROP, path: [] };

describe("stage -> destination", () => {
  it("routes to the store before pickup and to the drop after", () => {
    assert.equal(destinationFor("Agent-assigned"), "store");
    assert.equal(destinationFor("At-pickup"), "store");
    assert.equal(destinationFor("Order-picked-up"), "drop");
    assert.equal(destinationFor("Out-for-delivery"), "drop");
  });
  it("stops routing at delivery, on terminal and unknown stages", () => {
    for (const s of ["At-delivery", "Order-delivered", "Cancelled", "Pending", "whatever"]) {
      assert.equal(destinationFor(s), null, s);
    }
    assert.ok(isTerminalStage("Order-delivered"));
    assert.ok(!isTerminalStage("At-delivery"));
  });
});

describe("route ahead", () => {
  it("routes rider -> store before pickup", async () => {
    const deps = makeDeps();
    const out = await enrich(deps, { ...base, stage: "At-pickup" });
    assert.equal(out.route_ahead?.to, "store");
    assert.deepEqual((deps.osrm as FakeOsrm).routeCalls[0], { from: RIDER, to: STORE });
    assert.equal(out.drop_gps, "28.4351,77.0512");
  });

  it("reuses the cached route when the rider moved < 30 m, re-routes beyond", async () => {
    const deps = makeDeps();
    const osrm = deps.osrm as FakeOsrm;
    await enrich(deps, { ...base, stage: "Out-for-delivery" });
    await enrich(deps, { ...base, stage: "Out-for-delivery", rider: { lat: RIDER.lat + 0.0001, lng: RIDER.lng } }); // ~11 m
    assert.equal(osrm.routeCalls.length, 1);
    await enrich(deps, { ...base, stage: "Out-for-delivery", rider: { lat: RIDER.lat + 0.0005, lng: RIDER.lng } }); // ~55 m
    assert.equal(osrm.routeCalls.length, 2);
  });

  it("re-routes on a stage change even without movement", async () => {
    const deps = makeDeps();
    await enrich(deps, { ...base, stage: "At-pickup" });
    const out = await enrich(deps, { ...base, stage: "Order-picked-up" });
    assert.equal((deps.osrm as FakeOsrm).routeCalls.length, 2);
    assert.equal(out.route_ahead?.to, "drop");
  });

  it("omits route_ahead at delivery and clears the cache on a terminal stage", async () => {
    const deps = makeDeps();
    const cache = deps.cache as MemoryRouteCache;
    await enrich(deps, { ...base, stage: "Out-for-delivery", path: trail(3) });
    assert.equal((await enrich(deps, { ...base, stage: "At-delivery" })).route_ahead, undefined);
    const done = await enrich(deps, { ...base, stage: "Order-delivered" });
    assert.deepEqual(done, { drop_gps: "28.4351,77.0512" });
    assert.equal(cache.ahead.size + cache.trail.size, 0);
  });

  it("omits route_ahead when OSRM has no route", async () => {
    const deps = makeDeps();
    (deps.osrm as FakeOsrm).routeResult = { ok: false, reason: "no_result", code: "NoRoute" };
    const out = await enrich(deps, { ...base, stage: "Out-for-delivery" });
    assert.equal(out.route_ahead, undefined);
    assert.equal(out.drop_gps, "28.4351,77.0512");
  });
});

describe("road path (incremental match)", () => {
  it("matches only the new tail plus the overlap point", async () => {
    const deps = makeDeps();
    const osrm = deps.osrm as FakeOsrm;
    await enrich(deps, { ...base, stage: "Out-for-delivery", path: trail(5) });
    await enrich(deps, { ...base, stage: "Out-for-delivery", path: trail(8) });
    assert.deepEqual(osrm.matchCalls[1]!.map((p) => p.sequence), [5, 6, 7, 8]);
  });

  it("a duplicate update doesn't call OSRM again and resends the cached trail", async () => {
    const deps = makeDeps();
    const first = await enrich(deps, { ...base, stage: "Out-for-delivery", path: trail(5) });
    const again = await enrich(deps, { ...base, stage: "Out-for-delivery", path: trail(5) });
    assert.equal((deps.osrm as FakeOsrm).matchCalls.length, 1);
    assert.equal(again.road_path, first.road_path);
  });

  it("appends the new match to the cached trail", async () => {
    const deps = makeDeps();
    const osrm = deps.osrm as FakeOsrm;
    osrm.matchResult = { ok: true, geometries: ["_p~iF~ps|U"], minConfidence: 0.9 }; // (38.5,-120.2)
    await enrich(deps, { ...base, stage: "Out-for-delivery", path: trail(3) });
    osrm.matchResult = { ok: true, geometries: ["_flwFn`faV"], minConfidence: 0.9 }; // (40.7,-120.95)
    const out = await enrich(deps, { ...base, stage: "Out-for-delivery", path: trail(5) });
    assert.deepEqual(decodePolyline(out.road_path!), [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
    ]);
  });

  it("omits road_path on low confidence and does not advance the cursor", async () => {
    const deps = makeDeps();
    (deps.osrm as FakeOsrm).matchResult = { ok: true, geometries: ["_p~iF~ps|U"], minConfidence: 0.2 };
    const out = await enrich(deps, { ...base, stage: "Out-for-delivery", path: trail(4) });
    assert.equal(out.road_path, undefined);
    assert.equal((deps.cache as MemoryRouteCache).trail.size, 0);
  });

  it("caps a long backlog at matchMaxPoints, oldest first", async () => {
    const deps = makeDeps({ matchMaxPoints: 10 });
    await enrich(deps, { ...base, stage: "Out-for-delivery", path: trail(25) });
    const call = (deps.osrm as FakeOsrm).matchCalls[0]!;
    assert.equal(call.length, 10);
    assert.equal(call[0]!.sequence, 1);
    assert.equal((deps.cache as MemoryRouteCache).trail.get("od1")?.last_seq, 10);
  });

  it("drops points whose timestamp goes backwards", () => {
    const pts = trail(3);
    const bad = [pts[0]!, { ...pts[1]!, unixSeconds: pts[0]!.unixSeconds - 5 }, pts[2]!];
    assert.deepEqual(monotonic(bad).map((p) => p.sequence), [1, 3]);
  });

  it("needs at least two points to match", async () => {
    const deps = makeDeps();
    const out = await enrich(deps, { ...base, stage: "Out-for-delivery", path: trail(1) });
    assert.equal(out.road_path, undefined);
    assert.equal((deps.osrm as FakeOsrm).matchCalls.length, 0);
  });
});
