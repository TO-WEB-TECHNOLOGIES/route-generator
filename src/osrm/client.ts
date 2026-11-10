/**
 * OSRM v5 HTTP client for /route and /match. Never throws: every failure becomes a typed result
 * so callers can simply omit the field (CLAUDE.md §6).
 */
import { toOsrmCoord, type LatLng, type TimedPoint } from "../geo/point.js";
import { logger } from "../logger.js";
import { recordOsrm, type OsrmOp, type OsrmOutcome } from "../metrics.js";

export interface RouteOk {
  ok: true;
  polyline: string;
  distanceM: number;
  durationS: number;
}

export interface MatchOk {
  ok: true;
  /** One geometry per matching, in trace order (OSRM splits a trace it can't match in one go). */
  geometries: string[];
  /** Lowest confidence among the matchings, clamped to 0..1 (OSRM can report > 1). */
  minConfidence: number;
}

export interface OsrmFail {
  ok: false;
  reason: Exclude<OsrmOutcome, "ok">;
  /** OSRM `code` (NoRoute, NoMatch, NoSegment, …) or ours: SnapTooFar, HTTP_<status>. */
  code?: string;
}

export interface OsrmClient {
  route(from: LatLng, to: LatLng): Promise<RouteOk | OsrmFail>;
  match(points: readonly TimedPoint[]): Promise<MatchOk | OsrmFail>;
}

export interface HttpOsrmClientOptions {
  baseUrl: string;
  profile: string;
  timeoutMs: number;
  /** Reject a route when OSRM moved a point further than this (m) to reach a road. Unset = no check. */
  maxSnapDistanceM?: number | undefined;
  /** Per-point search radius (m) for /match. Unset or 0 = OSRM default. */
  matchRadiusM?: number | undefined;
}

interface OsrmResponse {
  code?: string;
  routes?: Array<{ geometry?: string; distance?: number; duration?: number }>;
  matchings?: Array<{ geometry?: string; confidence?: number }>;
  /** Input points snapped to the road network; `distance` = how far each was moved (m). */
  waypoints?: Array<{ distance?: number }>;
}

export function createHttpOsrmClient(opts: HttpOsrmClientOptions): OsrmClient {
  /**
   * Calls OSRM. Failures (HTTP/network/timeout/non-Ok code) are recorded in metrics here; for an
   * "Ok" body the caller records the final outcome, because it may still reject the result.
   */
  async function call(op: OsrmOp, url: string): Promise<{ body: OsrmResponse; done: (o: OsrmOutcome) => void } | OsrmFail> {
    const started = performance.now();
    const done = (outcome: OsrmOutcome) => recordOsrm(op, outcome, performance.now() - started);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
      // OSRM answers NoRoute/NoMatch etc. with HTTP 400 and a JSON body, so parse regardless.
      const body = (await res.json().catch(() => ({}))) as OsrmResponse;
      if (body.code === "Ok") return { body, done };
      const code = body.code ?? `HTTP_${res.status}`;
      const isNoResult = res.status < 500 && body.code !== undefined;
      done(isNoResult ? "no_result" : "error");
      if (!isNoResult) logger.warn("osrm", `${op} failed`, { code, status: res.status });
      return { ok: false, reason: isNoResult ? "no_result" : "error", code };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      done(timedOut ? "timeout" : "error");
      logger.warn("osrm", `${op} ${timedOut ? "timed out" : "request error"}`, {
        timeout_ms: opts.timeoutMs,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: timedOut ? "timeout" : "error" };
    }
  }

  const base = `${opts.baseUrl}`;
  const maxSnap = opts.maxSnapDistanceM;
  const radius = opts.matchRadiusM && opts.matchRadiusM > 0 ? opts.matchRadiusM : undefined;

  return {
    async route(from, to) {
      const coords = `${toOsrmCoord(from)};${toOsrmCoord(to)}`;
      const url = `${base}/route/v1/${opts.profile}/${coords}?overview=full&geometries=polyline`;
      const res = await call("route", url);
      if ("ok" in res) return res;
      const { body, done } = res;

      // ROUTE-09: OSRM snaps any point to the nearest road, however far. A point far from every
      // road (or outside the map) would otherwise produce a confident-looking but absurd route.
      const snaps = (body.waypoints ?? []).map((w) => w.distance ?? 0);
      if (maxSnap !== undefined && snaps.some((d) => d > maxSnap)) {
        done("no_result");
        logger.debug("osrm", "route rejected: point too far from any road", {
          snap_m: snaps.map(Math.round),
          max_snap_m: maxSnap,
        });
        return { ok: false, reason: "no_result", code: "SnapTooFar" };
      }

      const r = body.routes?.[0];
      if (!r || typeof r.geometry !== "string") {
        done("no_result");
        return { ok: false, reason: "no_result", code: "NoRoute" };
      }
      done("ok");
      return {
        ok: true,
        polyline: r.geometry,
        distanceM: Math.round(r.distance ?? 0),
        durationS: Math.round(r.duration ?? 0),
      };
    },

    async match(points) {
      const coords = points.map((p) => toOsrmCoord(p.point)).join(";");
      // OSRM needs a timestamp for every coordinate or none. Logistics breadcrumbs have none, so
      // send them only when all points carry one; otherwise OSRM matches on geometry alone.
      const allTimed = points.every((p) => p.unixSeconds !== undefined);
      const timestamps = allTimed ? `timestamps=${points.map((p) => p.unixSeconds).join(";")}&` : "";
      const radiuses = radius !== undefined ? `radiuses=${points.map(() => radius).join(";")}&` : "";
      const url =
        `${base}/match/v1/${opts.profile}/${coords}` +
        `?${timestamps}${radiuses}overview=full&geometries=polyline`;
      const res = await call("match", url);
      if ("ok" in res) return res;
      const { body, done } = res;

      const matchings = (body.matchings ?? []).filter((m) => typeof m.geometry === "string");
      if (matchings.length === 0) {
        done("no_result");
        return { ok: false, reason: "no_result", code: "NoMatch" };
      }
      done("ok");
      return {
        ok: true,
        geometries: matchings.map((m) => m.geometry as string),
        // OSRM can report confidence > 1 (seen: 1.19, 4.11), so clamp before comparing.
        minConfidence: Math.min(1, ...matchings.map((m) => m.confidence ?? 0)),
      };
    },
  };
}
