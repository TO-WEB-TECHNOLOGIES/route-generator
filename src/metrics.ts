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
  return { osrm: { route: view(stats.route), match: view(stats.match) } };
}

/** Test helper. */
export function resetMetrics(): void {
  stats.route = fresh();
  stats.match = fresh();
}
