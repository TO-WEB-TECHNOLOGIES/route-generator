/**
 * Every tunable lives here, with a default. Mirror changes in `.env.example` and the tunables
 * table in `docs/internal/routing.md` (CLAUDE.local.md Rule 7).
 */

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
  /** If set, /internal/* requires header X-Internal-Token with this value. */
  internalToken: string | undefined;
}

export function loadConfig(): Config {
  const baseUrl = str("OSRM_BASE_URL", "http://osrm:5000").replace(/\/+$/, "");
  if (/router\.project-osrm\.org/i.test(baseUrl)) {
    throw new Error("OSRM_BASE_URL points at the public demo server. Use the private OSRM instance.");
  }
  const token = str("INTERNAL_TOKEN", "");
  return {
    port: num("PORT", 4100),
    osrmBaseUrl: baseUrl,
    osrmProfile: str("OSRM_PROFILE", "driving"),
    osrmTimeoutMs: num("OSRM_TIMEOUT_MS", 1000),
    redisUrl: str("REDIS_URL", "redis://localhost:6379"),
    redisKeyPrefix: str("REDIS_KEY_PREFIX", "osrm-bff:dev:"),
    redisCommandTimeoutMs: num("REDIS_COMMAND_TIMEOUT_MS", 200),
    rerouteThresholdM: num("REROUTE_THRESHOLD_M", 30),
    matchMinConfidence: num("MATCH_MIN_CONFIDENCE", 0.5),
    matchOverlapPoints: num("MATCH_OVERLAP_POINTS", 1),
    matchMaxPoints: num("MATCH_MAX_POINTS", 100),
    internalToken: token === "" ? undefined : token,
  };
}
