import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { DEFAULT_COVERAGE_BBOX } from "../src/config.js";
import {
  formatLatLng,
  haversineMeters,
  isCovered,
  isInBbox,
  parseBbox,
  parseCoverage,
  parseLatLng,
  toOsrmCoord,
} from "../src/geo/point.js";
import { decodePolyline, encodePolyline, joinPaths } from "../src/geo/polyline.js";

describe("point", () => {
  it('parses our "lat,lng" format', () => {
    assert.deepEqual(parseLatLng("28.4302136,77.0433475"), { lat: 28.4302136, lng: 77.0433475 });
  });

  it("rejects malformed or out-of-range input", () => {
    for (const bad of ["", "28.4", "a,b", "28.4,77.0,1", "91,77", "28,181", ",77", 42, null]) {
      assert.equal(parseLatLng(bad), null, String(bad));
    }
  });

  it("builds OSRM coordinates lng FIRST", () => {
    assert.equal(toOsrmCoord({ lat: 28.43, lng: 77.04 }), "77.04,28.43");
  });

  it("round-trips the wire format", () => {
    assert.equal(formatLatLng(parseLatLng("28.4351,77.0512")!), "28.4351,77.0512");
  });

  it("haversine: 0.001 deg latitude is ~111 m", () => {
    const d = haversineMeters({ lat: 28.43, lng: 77.04 }, { lat: 28.431, lng: 77.04 });
    assert.ok(Math.abs(d - 111.2) < 0.5, `got ${d}`);
  });
});

describe("coverage box", () => {
  const ncr = parseBbox("76.75,28.20,77.80,28.95")!;

  it("parses minLng,minLat,maxLng,maxLat", () => {
    assert.deepEqual(ncr, { minLng: 76.75, minLat: 28.2, maxLng: 77.8, maxLat: 28.95 });
  });

  it("rejects malformed or inverted boxes", () => {
    for (const bad of ["", "1,2,3", "a,b,c,d", "77.8,28.2,76.75,28.95", "76.75,28.95,77.8,28.2", "0,0,200,10", 5]) {
      assert.equal(parseBbox(bad), null, String(bad));
    }
  });

  it("contains all four cities, excludes Mumbai and lat/lng swaps", () => {
    for (const [name, lat, lng] of [
      ["Delhi", 28.6139, 77.209],
      ["Gurugram", 28.4595, 77.0266],
      ["Noida", 28.5355, 77.391],
      ["Ghaziabad", 28.6692, 77.4538],
    ] as const) {
      assert.ok(isInBbox({ lat, lng }, ncr), name);
    }
    assert.ok(!isInBbox({ lat: 19.076, lng: 72.8777 }, ncr), "Mumbai");
    assert.ok(!isInBbox({ lat: 77.0266, lng: 28.4595 }, ncr), "swapped Gurugram");
  });
});

describe("coverage: NCR + Bengaluru (2026-11-10)", () => {
  const coverage = parseCoverage(DEFAULT_COVERAGE_BBOX)!;

  it("parses ;-separated boxes; a single box is still valid; one bad box rejects all", () => {
    assert.equal(coverage.length, 2);
    assert.deepEqual(coverage[1], { minLng: 77.35, minLat: 12.75, maxLng: 77.9, maxLat: 13.25 });
    assert.equal(parseCoverage("76.75,28.20,77.80,28.95")!.length, 1);
    for (const bad of ["", "76.75,28.20,77.80,28.95;", "76.75,28.20,77.80,28.95;1,2,3", 7]) {
      assert.equal(parseCoverage(bad), null, String(bad));
    }
  });

  it("covers both cities; excludes Mumbai, between-city points and lat/lng swaps", () => {
    for (const [name, lat, lng] of [
      ["Delhi", 28.6139, 77.209],
      ["Noida", 28.5355, 77.391],
      ["Bengaluru MG Road", 12.974, 77.6134],
      ["Koramangala", 12.9352, 77.6245],
      ["Whitefield", 12.9698, 77.75],
      ["Electronic City", 12.8452, 77.6602],
      ["Kempegowda airport", 13.1989, 77.7068],
    ] as const) {
      assert.ok(isCovered({ lat, lng }, coverage), name);
    }
    for (const [name, lat, lng] of [
      ["Mumbai", 19.076, 72.8777],
      ["Hyderabad (between the cities)", 17.385, 78.4867],
      ["swapped MG Road", 77.6134, 12.974],
      ["swapped Gurugram", 77.0266, 28.4595],
    ] as const) {
      assert.ok(!isCovered({ lat, lng }, coverage), name);
    }
  });

  it("COVERAGE_BBOX default equals OSRM_BBOX in ops/osrm/prep.Dockerfile (map and service must agree)", () => {
    const dockerfile = readFileSync(new URL("../ops/osrm/prep.Dockerfile", import.meta.url), "utf8");
    const m = dockerfile.match(/OSRM_BBOX="([^"]+)"/);
    assert.ok(m, "OSRM_BBOX not found in prep.Dockerfile");
    assert.equal(m[1], DEFAULT_COVERAGE_BBOX);
  });
});

describe("polyline (precision 5)", () => {
  // Reference example from Google's polyline algorithm documentation.
  const points = [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ];
  const encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

  it("encodes the reference example", () => assert.equal(encodePolyline(points), encoded));
  it("decodes the reference example", () => assert.deepEqual(decodePolyline(encoded), points));
  it("throws on a truncated string", () => assert.throws(() => decodePolyline("_p~iF~ps|")));

  it("joins paths without duplicating the shared point", () => {
    const a = points.slice(0, 2);
    const b = points.slice(1);
    assert.deepEqual(joinPaths(a, b), points);
  });
});
