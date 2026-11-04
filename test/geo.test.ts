import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLatLng, haversineMeters, parseLatLng, toOsrmCoord } from "../src/geo/point.js";
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
