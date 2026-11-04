import type { LatLng, TimedPoint } from "../../src/geo/point.js";
import type { MatchOk, OsrmClient, OsrmFail, RouteOk } from "../../src/osrm/client.js";
import type { RouteAheadEntry, RouteCache, TrailEntry } from "../../src/routing/cache.js";
import type { EnrichDeps } from "../../src/routing/enrich.js";

export class MemoryRouteCache implements RouteCache {
  ahead = new Map<string, RouteAheadEntry>();
  trail = new Map<string, TrailEntry>();
  async getAhead(id: string) { return this.ahead.get(id) ?? null; }
  async setAhead(id: string, e: RouteAheadEntry) { this.ahead.set(id, e); }
  async getTrail(id: string) { return this.trail.get(id) ?? null; }
  async setTrail(id: string, e: TrailEntry) { this.trail.set(id, e); }
  async clear(id: string) { this.ahead.delete(id); this.trail.delete(id); }
}

export class FakeOsrm implements OsrmClient {
  routeCalls: Array<{ from: LatLng; to: LatLng }> = [];
  matchCalls: TimedPoint[][] = [];
  routeResult: RouteOk | OsrmFail = { ok: true, polyline: "_p~iF~ps|U_ulLnnqC", distanceM: 2140, durationS: 380 };
  matchResult: MatchOk | OsrmFail = { ok: true, geometries: ["_p~iF~ps|U_ulLnnqC"], minConfidence: 0.9 };
  async route(from: LatLng, to: LatLng) { this.routeCalls.push({ from, to }); return this.routeResult; }
  async match(points: readonly TimedPoint[]) { this.matchCalls.push([...points]); return this.matchResult; }
}

export function makeDeps(overrides: Partial<EnrichDeps> = {}): EnrichDeps & { osrm: OsrmClient; cache: RouteCache } {
  return {
    osrm: new FakeOsrm(),
    cache: new MemoryRouteCache(),
    rerouteThresholdM: 30,
    matchMinConfidence: 0.5,
    matchOverlapPoints: 1,
    matchMaxPoints: 100,
    ...overrides,
  };
}

/** Points ~111 m apart heading north, 15 s apart. */
export function trail(n: number, startSeq = 1): TimedPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    point: { lat: 28.43 + (startSeq - 1 + i) * 0.001, lng: 77.04 },
    sequence: startSeq + i,
    unixSeconds: 1_793_500_000 + (startSeq - 1 + i) * 15,
  }));
}
