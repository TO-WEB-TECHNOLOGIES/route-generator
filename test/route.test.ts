/**
 * Part 1: GET /v1/route, the OSRM snap-distance guard (ROUTE-09), /match radiuses + confidence
 * clamp (ROUTE-10), and the coverage guard in enrich. Uses the REAL HTTP client against a stub
 * OSRM whose answer each test sets.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { DEFAULT_COVERAGE_BBOX } from "../src/config.js";
import { parseBbox } from "../src/geo/point.js";
import { createHttpOsrmClient } from "../src/osrm/client.js";
import { enrich } from "../src/routing/enrich.js";
import { FakeOsrm, makeDeps, trail } from "./helpers/fakes.js";

const NCR = parseBbox(DEFAULT_COVERAGE_BBOX)!;
const TIMEOUT_MS = 200;

// ---- stub OSRM: tests set `reply`; every request URL is recorded in `urls` ----
type Reply = { status: number; body: unknown } | "hang";
let reply: Reply = { status: 200, body: {} };
const urls: string[] = [];
const stub = createServer((req, res) => {
  urls.push(req.url ?? "");
  if (reply === "hang") return; // never answer
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body));
});

const okRoute = (snapM = [3.6, 18.7]) => ({
  status: 200,
  body: {
    code: "Ok",
    routes: [{ geometry: "_p~iF~ps|U_ulLnnqC", distance: 9507.1, duration: 812.6 }],
    waypoints: snapM.map((distance) => ({ distance })),
  },
});

let osrmUrl = "";
let baseUrl = "";
let closeApp = () => {};

before(async () => {
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  osrmUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  const osrm = createHttpOsrmClient({
    baseUrl: osrmUrl,
    profile: "driving",
    timeoutMs: TIMEOUT_MS,
    maxSnapDistanceM: 200,
    matchRadiusM: 30,
  });
  const app = createApp({ deps: makeDeps({ osrm, coverage: NCR }), internalToken: "t0ken" });
  const server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeApp = () => server.close();
});
after(() => {
  closeApp();
  stub.closeAllConnections();
  stub.close();
});
beforeEach(() => {
  urls.length = 0;
  reply = okRoute();
});

const getRoute = (query: string, token: string | null = "t0ken") =>
  fetch(`${baseUrl}/v1/route?${query}`, { headers: token ? { "x-internal-token": token } : {} });

const CYBER_HUB = "28.4950,77.0886";
const SECTOR_29 = "28.4595,77.0266";

describe("GET /v1/route", () => {
  it("200: maps the OSRM route and sends lng,lat to OSRM", async () => {
    const res = await getRoute(`from=${CYBER_HUB}&to=${SECTOR_29}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      from: "28.495,77.0886", // echoed back normalized (trailing zero dropped): same point
      to: SECTOR_29,
      polyline: "_p~iF~ps|U_ulLnnqC",
      distance_m: 9507,
      duration_s: 813,
    });
    assert.ok(urls[0]!.startsWith("/route/v1/driving/77.0886,28.495;77.0266,28.4595?"), urls[0]);
  });

  it("400 INVALID_POINT for missing or malformed points", async () => {
    for (const q of [`from=${CYBER_HUB}`, `from=abc&to=${SECTOR_29}`, `from=${CYBER_HUB}&to=91,77`, ""]) {
      const res = await getRoute(q);
      assert.equal(res.status, 400, q);
      assert.equal(((await res.json()) as any).error.code, "INVALID_POINT");
    }
    assert.equal(urls.length, 0, "OSRM must not be called");
  });

  it("422 OUT_OF_COVERAGE without calling OSRM (Mumbai, and a lat/lng swap)", async () => {
    for (const q of [`from=19.0760,72.8777&to=${SECTOR_29}`, `from=77.0886,28.4950&to=${SECTOR_29}`]) {
      const res = await getRoute(q);
      assert.equal(res.status, 422, q);
      assert.equal(((await res.json()) as any).error.code, "OUT_OF_COVERAGE");
    }
    assert.equal(urls.length, 0);
  });

  it("404 NO_ROUTE when OSRM says NoRoute (HTTP 400 + JSON body)", async () => {
    reply = { status: 400, body: { code: "NoRoute", message: "Impossible route" } };
    const res = await getRoute(`from=${CYBER_HUB}&to=${SECTOR_29}`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as any).error.code, "NO_ROUTE");
  });

  it("404 NO_ROUTE when a point had to snap further than 200 m (ROUTE-09)", async () => {
    reply = okRoute([1_078_161.6, 3.2]); // what real OSRM returned for a Mumbai point
    const res = await getRoute(`from=${CYBER_HUB}&to=${SECTOR_29}`);
    assert.equal(res.status, 404);
  });

  it("503 ROUTING_UNAVAILABLE within ~one timeout when OSRM hangs", async () => {
    reply = "hang";
    const started = performance.now();
    const res = await getRoute(`from=${CYBER_HUB}&to=${SECTOR_29}`);
    const elapsed = performance.now() - started;
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as any).error.code, "ROUTING_UNAVAILABLE");
    assert.ok(elapsed < TIMEOUT_MS * 3, `took ${elapsed} ms`);
  });

  it("503 when OSRM returns a 5xx", async () => {
    reply = { status: 502, body: {} };
    assert.equal((await getRoute(`from=${CYBER_HUB}&to=${SECTOR_29}`)).status, 503);
  });

  it("401 without the internal token", async () => {
    assert.equal((await getRoute(`from=${CYBER_HUB}&to=${SECTOR_29}`, null)).status, 401);
    assert.equal(urls.length, 0);
  });
});

describe("OSRM client /match (ROUTE-10)", () => {
  const client = () =>
    createHttpOsrmClient({ baseUrl: osrmUrl, profile: "driving", timeoutMs: TIMEOUT_MS, matchRadiusM: 30 });

  it("sends one radius per point", async () => {
    reply = { status: 200, body: { code: "Ok", matchings: [{ geometry: "_p~iF~ps|U", confidence: 0.96 }] } };
    await client().match(trail(3));
    assert.match(urls[0]!, /[?&]radiuses=30;30;30(&|$)/);
  });

  it("clamps confidence above 1 (OSRM reported 1.19 and 4.11 in real tests)", async () => {
    reply = { status: 200, body: { code: "Ok", matchings: [{ geometry: "_p~iF~ps|U", confidence: 4.11 }] } };
    const r = await client().match(trail(2));
    assert.ok(r.ok && r.minConfidence === 1, JSON.stringify(r));
  });

  it("omits radiuses when not configured", async () => {
    reply = { status: 200, body: { code: "Ok", matchings: [{ geometry: "_p~iF~ps|U", confidence: 0.9 }] } };
    await createHttpOsrmClient({ baseUrl: osrmUrl, profile: "driving", timeoutMs: TIMEOUT_MS }).match(trail(2));
    assert.doesNotMatch(urls[0]!, /radiuses=/);
  });
});

describe("enrich coverage guard (ROUTE-09)", () => {
  const MUMBAI = { lat: 19.076, lng: 72.8777 };
  const MUMBAI_DROP = { lat: 18.922, lng: 72.8355 };

  it("an order outside NCR never reaches OSRM and gets only drop_gps", async () => {
    const deps = makeDeps({ coverage: NCR });
    const mumbaiTrail = trail(4).map((p) => ({ ...p, point: { lat: p.point.lat - 9.4, lng: p.point.lng - 4.2 } }));
    const out = await enrich(deps, {
      orderId: "odX",
      stage: "Out-for-delivery",
      rider: MUMBAI,
      dropGps: MUMBAI_DROP,
      path: mumbaiTrail,
    });
    assert.deepEqual(out, { drop_gps: "18.922,72.8355" });
    assert.equal((deps.osrm as FakeOsrm).routeCalls.length, 0);
    assert.equal((deps.osrm as FakeOsrm).matchCalls.length, 0);
  });

  it("drops only the trail points outside NCR", async () => {
    const deps = makeDeps({ coverage: NCR });
    const pts = trail(4);
    pts[1] = { ...pts[1]!, point: MUMBAI }; // one wild GPS fix
    await enrich(deps, {
      orderId: "odY",
      stage: "Out-for-delivery",
      rider: pts[3]!.point,
      dropGps: { lat: 28.4351, lng: 77.0512 },
      path: pts,
    });
    assert.deepEqual((deps.osrm as FakeOsrm).matchCalls[0]!.map((p) => p.sequence), [1, 3, 4]);
    assert.equal((deps.osrm as FakeOsrm).routeCalls.length, 1);
  });
});

describe("GET / and GET /health", () => {
  it("200 {status: ok} without a token and without calling OSRM, even when OSRM hangs", async () => {
    reply = "hang";
    for (const path of ["/", "/health"]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200, path);
      assert.deepEqual(await res.json(), { status: "ok" });
    }
    assert.equal(urls.length, 0);
  });
});
