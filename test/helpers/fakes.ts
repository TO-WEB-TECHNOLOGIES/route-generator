import type { LatLng, TimedPoint } from "../../src/geo/point.js";
import type { MatchOk, OsrmClient, OsrmFail, RouteOk } from "../../src/osrm/client.js";
import type { CrumbsEntry, RouteAheadEntry, RouteCache, TrailEntry } from "../../src/routing/cache.js";
import type { EnrichDeps } from "../../src/routing/enrich.js";

export class MemoryRouteCache implements RouteCache {
  ahead = new Map<string, RouteAheadEntry>();
  trail = new Map<string, TrailEntry>();
  crumbs = new Map<string, CrumbsEntry>();
  async getAhead(id: string) { return this.ahead.get(id) ?? null; }
  async setAhead(id: string, e: RouteAheadEntry) { this.ahead.set(id, e); }
  async getTrail(id: string) { return this.trail.get(id) ?? null; }
  async setTrail(id: string, e: TrailEntry) { this.trail.set(id, e); }
  async getCrumbs(id: string) { return this.crumbs.get(id) ?? null; }
  async setCrumbs(id: string, e: CrumbsEntry) { this.crumbs.set(id, e); }
  async clear(id: string) { this.ahead.delete(id); this.trail.delete(id); this.crumbs.delete(id); }
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

import type { TrackSnapshotStore } from "../../src/tracking/snapshot.js";
import type { TrackUpdate } from "../../src/tracking/service.js";

export class MemorySnapshotStore implements TrackSnapshotStore {
  map = new Map<string, TrackUpdate>();
  async get(id: string) { return this.map.get(id) ?? null; }
  async set(id: string, u: TrackUpdate) { this.map.set(id, u); }
  async delete(id: string) { this.map.delete(id); }
}

/** OSRM that never answers: for "routing slower than the deadline" tests. */
export class HangingOsrm implements OsrmClient {
  route(): Promise<RouteOk | OsrmFail> { return new Promise(() => {}); }
  match(): Promise<MatchOk | OsrmFail> { return new Promise(() => {}); }
}

export interface SseEvent { event: string; data: any; id?: string }

/** Minimal SSE client over fetch (tests only). */
export async function openSse(url: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const events: SseEvent[] = [];
  const state = { ended: false };
  if (res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev: Partial<SseEvent> = {};
            for (const line of block.split("\n")) {
              if (line.startsWith("event: ")) ev.event = line.slice(7);
              else if (line.startsWith("id: ")) ev.id = line.slice(4);
              else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
            }
            if (ev.event) events.push(ev as SseEvent);
          }
        }
      } catch {
        /* aborted */
      }
      state.ended = true;
    })();
  } else {
    state.ended = true;
  }
  return {
    res,
    events,
    get ended() { return state.ended; },
    close: () => ctrl.abort(),
    async waitFor(pred: () => boolean, ms = 2000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out; events so far: ${JSON.stringify(events)}`);
    },
  };
}
