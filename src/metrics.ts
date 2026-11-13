/**
 * In-process OSRM latency/outcome counters, exposed on GET /metrics.
 * A dead OSRM container is invisible to users (the app falls back to straight lines), so these
 * counters are the only alarm. Alert on a sustained non-"ok" rate.
 */
export type OsrmOp = "route" | "match";
export type OsrmOutcome = "ok" | "no_result" | "timeout" | "error";

interface OpStats {
  outcomes: Record<OsrmOutcome, number>;
  latencyMsSum: number;
  latencyMsMax: number;
  lastErrorAt: string | null;
}

const fresh = (): OpStats => ({
  outcomes: { ok: 0, no_result: 0, timeout: 0, error: 0 },
  latencyMsSum: 0,
  latencyMsMax: 0,
  lastErrorAt: null,
});

const stats: Record<OsrmOp, OpStats> = { route: fresh(), match: fresh() };

export function recordOsrm(op: OsrmOp, outcome: OsrmOutcome, latencyMs: number): void {
  const s = stats[op];
  s.outcomes[outcome] += 1;
  s.latencyMsSum += latencyMs;
  s.latencyMsMax = Math.max(s.latencyMsMax, latencyMs);
  if (outcome === "timeout" || outcome === "error") s.lastErrorAt = new Date().toISOString();
}

// ---- ondc-logistics-api calls and the track push (2026-11-10) ----
export type LogisticsOp = "track" | "status";
/** rejected = the logistics API answered non-2xx (e.g. 60012 before pickup). */
export type LogisticsOutcome = "ok" | "rejected" | "timeout" | "error";

const freshLogistics = () => ({
  outcomes: { ok: 0, rejected: 0, timeout: 0, error: 0 } as Record<LogisticsOutcome, number>,
  latencyMsSum: 0,
  latencyMsMax: 0,
});
let logistics: Record<LogisticsOp, ReturnType<typeof freshLogistics>> = { track: freshLogistics(), status: freshLogistics() };

export function recordLogistics(op: LogisticsOp, outcome: LogisticsOutcome, latencyMs: number): void {
  const s = logistics[op];
  s.outcomes[outcome] += 1;
  s.latencyMsSum += latencyMs;
  s.latencyMsMax = Math.max(s.latencyMsMax, latencyMs);
}

const freshTrack = () => ({
  webhooks: 0,
  webhooks_no_gps: 0,
  updates_pushed: 0,
  routing_deadline_hit: 0,
  // Our own breadcrumbs (ROUTE-11): added, or skipped as older / not moved.
  crumbs_added: 0,
  crumbs_skipped_older: 0,
  crumbs_skipped_not_moved: 0,
});
let track = freshTrack();
export function recordTrack(event: keyof ReturnType<typeof freshTrack>): void {
  track[event] += 1;
}
/** Set by the stream hub so /metrics can report open frontend streams. */
let openStreams: () => number = () => 0;
export function setOpenStreamsGauge(fn: () => number): void {
  openStreams = fn;
}

export function metricsSnapshot() {
  const view = (s: OpStats) => {
    const calls = Object.values(s.outcomes).reduce((a, b) => a + b, 0);
    return {
      calls,
      outcomes: { ...s.outcomes },
      latency_ms_avg: calls ? Math.round(s.latencyMsSum / calls) : 0,
      latency_ms_max: Math.round(s.latencyMsMax),
      last_error_at: s.lastErrorAt,
    };
  };
  const lview = (s: ReturnType<typeof freshLogistics>) => {
    const calls = Object.values(s.outcomes).reduce((a, b) => a + b, 0);
    return {
      calls,
      outcomes: { ...s.outcomes },
      latency_ms_avg: calls ? Math.round(s.latencyMsSum / calls) : 0,
      latency_ms_max: Math.round(s.latencyMsMax),
    };
  };
  return {
    osrm: { route: view(stats.route), match: view(stats.match) },
    logistics: { track: lview(logistics.track), status: lview(logistics.status) },
    track: { ...track, open_streams: openStreams() },
  };
}

/** Test helper. */
export function resetMetrics(): void {
  stats.route = fresh();
  stats.match = fresh();
  logistics = { track: freshLogistics(), status: freshLogistics() };
  track = freshTrack();
}
