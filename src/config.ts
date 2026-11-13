/**
 * Every tunable lives here, with a default. Mirror changes in `.env.example` and the tunables
 * table in `docs/internal/routing.md` (CLAUDE.local.md Rule 7).
 */
import { parseCoverage, type Coverage } from "./geo/point.js";

/**
 * The area the map is built for: one box per region, ";"-separated (minLng,minLat,maxLng,maxLat).
 * Delhi NCR (Delhi, Gurugram, Noida, Ghaziabad) and Bengaluru (2026-11-10).
 * Must equal OSRM_BBOX in ops/osrm/prep.Dockerfile; test/geo.test.ts fails if they drift.
 */
export const DEFAULT_COVERAGE_BBOX = "76.75,28.20,77.80,28.95;77.35,12.75,77.90,13.25";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`Config ${name} must be true or false, got "${raw}"`);
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config ${name} must be a number, got "${raw}"`);
  return n;
}

/** Deployment environment. TEST: no token checks. PREPROD: token required on every guarded route. */
export type AppEnv = "TEST" | "PREPROD";

export interface Config {
  env: AppEnv;
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
   * Area the map covers (one box per region). Points outside never reach OSRM, which would otherwise
   * snap them to the nearest road however far away (a Mumbai point snapped 1,078 km: ROUTE-09).
   * undefined = no check.
   */
  coverage: Coverage | undefined;
  /** If OSRM had to move a route point further than this (m) to reach a road, treat as "no route". */
  maxSnapDistanceM: number;
  /**
   * Token that /internal/*, /v1/route and /v1/track* require as X-Internal-Token. Always undefined
   * with ENV=TEST (no checks); always set with ENV=PREPROD (startup fails without INTERNAL_TOKEN).
   */
  internalToken: string | undefined;
  /** Serve the dev map page at /dev/route-viewer. Default: on with ENV=TEST, off with ENV=PREPROD. */
  devViewerEnabled: boolean;
  /** ondc-logistics-api base URL (no trailing slash). undefined = POST /v1/track answers 503. */
  logisticsBaseUrl: string | undefined;
  /** Per-call timeout for ondc-logistics-api (POST /logistics/track, GET .../status). */
  logisticsTimeoutMs: number;
  /**
   * Max time routing (stage lookup + enrich) may hold back a track_update. After it, the update is
   * pushed with only the GPS fields: routing never delays the GPS update (CLAUDE.md §1).
   */
  enrichDeadlineMs: number;
  /**
   * Logistics path: a rider position closer than this (m) to our last recorded breadcrumb is not
   * added (rider standing still, or the same /on_track again). See src/tracking/crumbs.ts (ROUTE-11).
   */
  crumbMinMoveM: number;
  /** Logistics path: newest N breadcrumbs kept per order (route:crumbs:*). >= MATCH_MAX_POINTS. */
  crumbsMaxPoints: number;
  /** Interval of the SSE keep-alive comment, so proxies don't drop an idle stream. */
  sseKeepaliveMs: number;
  /**
   * Our own public /health URL, pinged so a free host doesn't put the service to sleep
   * (src/keepalive.ts). Default: RENDER_EXTERNAL_URL + "/health" when Render sets it, else off.
   */
  keepaliveUrl: string | undefined;
  keepaliveIntervalMs: number;
}

/** ENV: unset = PREPROD (fail closed). */
export function parseAppEnv(raw: string | undefined): AppEnv {
  const v = (raw ?? "").trim().toUpperCase();
  if (v === "") return "PREPROD";
  if (v === "TEST" || v === "PREPROD") return v;
  throw new Error(`Config ENV must be TEST or PREPROD, got "${raw}"`);
}

export function loadConfig(): Config {
  const baseUrl = str("OSRM_BASE_URL", "http://osrm:5000").replace(/\/+$/, "");
  if (/router\.project-osrm\.org/i.test(baseUrl)) {
    throw new Error("OSRM_BASE_URL points at the public demo server. Use the private OSRM instance.");
  }
  const env = parseAppEnv(process.env.ENV);
  const token = str("INTERNAL_TOKEN", "");
  if (env === "PREPROD" && token === "") {
    throw new Error("ENV=PREPROD requires INTERNAL_TOKEN (set ENV=TEST for local development without a token)");
  }
  // KEEPALIVE_URL: unset = Render's own public URL if running on Render, else off; "none" = off.
  const renderUrl = str("RENDER_EXTERNAL_URL", "").replace(/\/+$/, "");
  const keepaliveRaw = str("KEEPALIVE_URL", renderUrl ? `${renderUrl}/health` : "none");
  const logisticsBaseUrl = str("LOGISTICS_BASE_URL", "").replace(/\/+$/, "");
  // COVERAGE_BBOX: unset = default boxes; "none" = disable the check.
  const bboxRaw = str("COVERAGE_BBOX", DEFAULT_COVERAGE_BBOX);
  const coverage = bboxRaw === "none" ? undefined : parseCoverage(bboxRaw);
  if (coverage === null) {
    throw new Error(`Config COVERAGE_BBOX must be "minLng,minLat,maxLng,maxLat" boxes separated by ";", or "none", got "${bboxRaw}"`);
  }
  return {
    env,
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
    coverage,
    maxSnapDistanceM: num("MAX_SNAP_DISTANCE_M", 200),
    internalToken: env === "TEST" || token === "" ? undefined : token,
    devViewerEnabled: bool("DEV_VIEWER_ENABLED", env === "TEST"),
    logisticsBaseUrl: logisticsBaseUrl === "" ? undefined : logisticsBaseUrl,
    logisticsTimeoutMs: num("LOGISTICS_TIMEOUT_MS", 5000),
    enrichDeadlineMs: num("ENRICH_DEADLINE_MS", 1200),
    crumbMinMoveM: num("CRUMB_MIN_MOVE_M", 10),
    crumbsMaxPoints: num("CRUMBS_MAX_POINTS", 120),
    sseKeepaliveMs: num("SSE_KEEPALIVE_MS", 25000),
    keepaliveUrl: keepaliveRaw === "none" ? undefined : keepaliveRaw,
    // 10 min: under Render's ~15 min idle limit, with room for one failed ping.
    keepaliveIntervalMs: num("KEEPALIVE_INTERVAL_MS", 10 * 60 * 1000),
  };
}
