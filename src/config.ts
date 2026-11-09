/**
 * Every tunable lives here, with a default. Mirror changes in `.env.example` and the tunables
 * table in `docs/internal/routing.md` (CLAUDE.local.md Rule 7).
 */
import { parseBbox, type Bbox } from "./geo/point.js";

/**
 * Must match OSRM_BBOX in ops/osrm/prep.Dockerfile (the area the map is built for).
 * If you widen one, widen the other.
 */
export const DEFAULT_COVERAGE_BBOX = "76.75,28.20,77.80,28.95";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config ${name} must be a number, got "${raw}"`);
  return n;
}

export interface Config {
  port: number;
  osrmBaseUrl: string;
  osrmProfile: string;
  /** Per-call OSRM timeout. Routing must never hold up a GPS update (CLAUDE.md §6). */
  osrmTimeoutMs: number;
  redisUrl: string;
  redisKeyPrefix: string;
  redisCommandTimeoutMs: number;
  /** Re-route only if the rider moved more than this (haversine metres) or the stage changed. */
  rerouteThresholdM: number;
  /**
   * Below this OSRM /match confidence (0..1), omit road_path for the update.
   * 0.5 is a reversible default; the design hasn't fixed a value (ARCHITECTURE_REVIEW: ROUTE-03).
   */
  matchMinConfidence: number;
  /** Already-matched points re-sent before the new tail, so the pieces join. */
  matchOverlapPoints: number;
  /** Upper bound on coordinates per /match call (osrm-routed --max-matching-size, default 100). */
  matchMaxPoints: number;
  /**
   * Search radius (m) per point sent to /match as `radiuses`. OSRM's default is too tight for city
   * GPS noise: at ±25 m it dropped 9/25 points; 30 m matched all (ARCHITECTURE_REVIEW ROUTE-10).
   * 0 = don't send (OSRM default).
   */
  matchRadiusM: number;
  /**
   * Area the map covers. Points outside never reach OSRM, which would otherwise snap them to the
   * nearest road however far away (a Mumbai point snapped 1,078 km: ROUTE-09). undefined = no check.
   */
  coverageBbox: Bbox | undefined;
  /** If OSRM had to move a route point further than this (m) to reach a road, treat as "no route". */
  maxSnapDistanceM: number;
  /** If set, /internal/* requires header X-Internal-Token with this value. */
  internalToken: string | undefined;
}

export function loadConfig(): Config {
  const baseUrl = str("OSRM_BASE_URL", "http://osrm:5000").replace(/\/+$/, "");
  if (/router\.project-osrm\.org/i.test(baseUrl)) {
    throw new Error("OSRM_BASE_URL points at the public demo server. Use the private OSRM instance.");
  }
  const token = str("INTERNAL_TOKEN", "");
  // COVERAGE_BBOX: unset = default box; "none" = disable the check.
  const bboxRaw = str("COVERAGE_BBOX", DEFAULT_COVERAGE_BBOX);
  const coverageBbox = bboxRaw === "none" ? undefined : parseBbox(bboxRaw);
  if (coverageBbox === null) {
    throw new Error(`Config COVERAGE_BBOX must be "minLng,minLat,maxLng,maxLat" or "none", got "${bboxRaw}"`);
  }
  return {
    port: num("PORT", 4100),
    osrmBaseUrl: baseUrl,
    osrmProfile: str("OSRM_PROFILE", "driving"),
    osrmTimeoutMs: num("OSRM_TIMEOUT_MS", 1000),
    // 127.0.0.1, not localhost: on Windows Node resolves localhost to IPv6 ::1, and Docker in WSL
    // only listens on IPv4, so the connection is refused.
    redisUrl: str("REDIS_URL", "redis://127.0.0.1:6379"),
    redisKeyPrefix: str("REDIS_KEY_PREFIX", "osrm-bff:dev:"),
    redisCommandTimeoutMs: num("REDIS_COMMAND_TIMEOUT_MS", 200),
    rerouteThresholdM: num("REROUTE_THRESHOLD_M", 30),
    matchMinConfidence: num("MATCH_MIN_CONFIDENCE", 0.5),
    matchOverlapPoints: num("MATCH_OVERLAP_POINTS", 1),
    matchMaxPoints: num("MATCH_MAX_POINTS", 100),
    matchRadiusM: num("MATCH_RADIUS_M", 30),
    coverageBbox,
    maxSnapDistanceM: num("MAX_SNAP_DISTANCE_M", 200),
    internalToken: token === "" ? undefined : token,
  };
}
