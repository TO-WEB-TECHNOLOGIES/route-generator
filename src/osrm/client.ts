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
  /** Lowest confidence among the matchings (0..1). */
  minConfidence: number;
}

export interface OsrmFail {
  ok: false;
  reason: Exclude<OsrmOutcome, "ok">;
  /** OSRM `code`, e.g. NoRoute, NoMatch, TooBig. */
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
}

interface OsrmResponse {
  code?: string;
  routes?: Array<{ geometry?: string; distance?: number; duration?: number }>;
  matchings?: Array<{ geometry?: string; confidence?: number }>;
}

export function createHttpOsrmClient(opts: HttpOsrmClientOptions): OsrmClient {
  async function call(op: OsrmOp, url: string): Promise<OsrmResponse | OsrmFail> {
    const started = performance.now();
    const done = (outcome: OsrmOutcome) => recordOsrm(op, outcome, performance.now() - started);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
      // OSRM answers NoRoute/NoMatch etc. with HTTP 400 and a JSON body, so parse regardless.
      const body = (await res.json().catch(() => ({}))) as OsrmResponse;
      if (body.code === "Ok") {
        done("ok");
        return body;
      }
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

  return {
    async route(from, to) {
      const coords = `${toOsrmCoord(from)};${toOsrmCoord(to)}`;
      const url = `${base}/route/v1/${opts.profile}/${coords}?overview=full&geometries=polyline`;
      const body = await call("route", url);
      if ("ok" in body) return body;
      const r = body.routes?.[0];
      if (!r || typeof r.geometry !== "string") return { ok: false, reason: "no_result", code: "NoRoute" };
      return {
        ok: true,
        polyline: r.geometry,
        distanceM: Math.round(r.distance ?? 0),
        durationS: Math.round(r.duration ?? 0),
      };
    },

    async match(points) {
      const coords = points.map((p) => toOsrmCoord(p.point)).join(";");
      const timestamps = points.map((p) => p.unixSeconds).join(";");
      const url =
        `${base}/match/v1/${opts.profile}/${coords}` +
        `?timestamps=${timestamps}&overview=full&geometries=polyline`;
      const body = await call("match", url);
      if ("ok" in body) return body;
      const matchings = (body.matchings ?? []).filter((m) => typeof m.geometry === "string");
      if (matchings.length === 0) return { ok: false, reason: "no_result", code: "NoMatch" };
      return {
        ok: true,
        geometries: matchings.map((m) => m.geometry as string),
        minConfidence: Math.min(...matchings.map((m) => m.confidence ?? 0)),
      };
    },
  };
}
