/**
 * CLAUDE.md §6: when OSRM is down or slow, the enrich call must still come back on time with only
 * the non-routing fields. These tests use the REAL HTTP client against local stub servers.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { metricsSnapshot, resetMetrics } from "../src/metrics.js";
import { createHttpOsrmClient } from "../src/osrm/client.js";
import { enrich } from "../src/routing/enrich.js";
import { MemoryRouteCache, makeDeps, trail } from "./helpers/fakes.js";

const TIMEOUT_MS = 200;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

const input = {
  orderId: "od1",
  stage: "Out-for-delivery",
  rider: { lat: 28.4302136, lng: 77.0433475 },
  dropGps: { lat: 28.4351, lng: 77.0512 },
  path: trail(4),
};

describe("OSRM slow / down", () => {
  const seenUrls: string[] = [];
  const slow = createServer((req) => {
    seenUrls.push(req.url ?? "");
    /* never respond */
  });
  const ok = createServer((req, res) => {
    seenUrls.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    const body = req.url?.startsWith("/route")
      ? { code: "Ok", routes: [{ geometry: "_p~iF~ps|U", distance: 2140.4, duration: 379.6 }] }
      : { code: "Ok", matchings: [{ geometry: "_p~iF~ps|U", confidence: 0.93 }] };
    res.end(JSON.stringify(body));
  });
  let slowUrl = "";
  let okUrl = "";

  before(async () => {
    slowUrl = await listen(slow);
    okUrl = await listen(ok);
  });
  after(() => {
    slow.closeAllConnections();
    slow.close();
    ok.close();
  });

  it("slow OSRM: returns within ~one timeout with only drop_gps", async () => {
    resetMetrics();
    const deps = makeDeps({ osrm: createHttpOsrmClient({ baseUrl: slowUrl, profile: "driving", timeoutMs: TIMEOUT_MS }) });
    const started = performance.now();
    const out = await enrich(deps, input);
    const elapsed = performance.now() - started;
    assert.deepEqual(out, { drop_gps: "28.4351,77.0512" });
    assert.ok(elapsed < TIMEOUT_MS * 2, `took ${elapsed} ms; route and match must run in parallel`);
    assert.equal(metricsSnapshot().osrm.route.outcomes.timeout, 1);
    assert.equal(metricsSnapshot().osrm.match.outcomes.timeout, 1);
  });

  it("OSRM down (connection refused): fast, only drop_gps", async () => {
    const deps = makeDeps({ osrm: createHttpOsrmClient({ baseUrl: "http://127.0.0.1:1", profile: "driving", timeoutMs: TIMEOUT_MS }) });
    const out = await enrich(deps, input);
    assert.deepEqual(out, { drop_gps: "28.4351,77.0512" });
  });

  it("healthy OSRM: sends lng,lat in the URL and maps the response", async () => {
    seenUrls.length = 0;
    const deps = makeDeps({
      osrm: createHttpOsrmClient({ baseUrl: okUrl, profile: "driving", timeoutMs: TIMEOUT_MS }),
      cache: new MemoryRouteCache(),
    });
    const out = await enrich(deps, input);
    assert.deepEqual(out.route_ahead, { polyline: "_p~iF~ps|U", to: "drop", distance_m: 2140, duration_s: 380 });
    assert.equal(out.road_path, "_p~iF~ps|U");
    const routeUrl = seenUrls.find((u) => u.startsWith("/route"))!;
    assert.ok(
      routeUrl.startsWith("/route/v1/driving/77.0433475,28.4302136;77.0512,28.4351?"),
      routeUrl,
    );
    assert.match(routeUrl, /geometries=polyline(&|$)/);
    assert.match(seenUrls.find((u) => u.startsWith("/match"))!, /timestamps=\d+;\d+;\d+;\d+/);
  });

  it("HTTP endpoint answers 200 without routing fields when OSRM is slow", async () => {
    const app = createApp({
      deps: makeDeps({ osrm: createHttpOsrmClient({ baseUrl: slowUrl, profile: "driving", timeoutMs: TIMEOUT_MS }) }),
      internalToken: "t0ken",
    });
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/v1/track/enrich`;
      const body = JSON.stringify({
        order_id: "od1",
        stage: "Out-for-delivery",
        gps: "28.4302136,77.0433475",
        drop_gps: "28.4351,77.0512",
        path: [
          { lat_lng: "28.4300,77.0430", sequence: 1, timestamp: "2026-11-01T04:38:50.000Z" },
          { lat_lng: "28.4302136,77.0433475", sequence: 2, timestamp: "2026-11-01T04:39:05.726Z" },
        ],
      });
      const headers = { "content-type": "application/json", "x-internal-token": "t0ken" };

      const unauth = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json" } });
      assert.equal(unauth.status, 401);

      const res = await fetch(url, { method: "POST", body, headers });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { drop_gps: "28.4351,77.0512" });

      const bad = await fetch(url, { method: "POST", body: JSON.stringify({ order_id: "od1", stage: "x", gps: "nope" }), headers });
      assert.equal(bad.status, 400);
    } finally {
      server.close();
    }
  });
});
