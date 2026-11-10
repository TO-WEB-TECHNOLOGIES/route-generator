/**
 * Keep-alive pinger for hosts that put an idle service to sleep (Render's free tier sleeps a web
 * service after ~15 min without inbound traffic). It GETs our own PUBLIC /health URL every
 * KEEPALIVE_INTERVAL_MS. It must be the public URL: a call to localhost never passes the host's
 * proxy, so it doesn't count as traffic.
 *
 * It can only keep a running instance awake; it can't wake a sleeping one (its timer is asleep
 * too). Off unless a URL is configured (src/config.ts). Never throws; failures are logged only.
 */
import { logger } from "./logger.js";

export interface KeepaliveOptions {
  url: string;
  intervalMs: number;
  timeoutMs: number;
}

/** Starts pinging; returns a stop function (called on shutdown). */
export function startKeepalive(opts: KeepaliveOptions): () => void {
  let failures = 0;
  const ping = async () => {
    try {
      const res = await fetch(opts.url, { signal: AbortSignal.timeout(opts.timeoutMs) });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failures > 0) logger.info("keepalive", "ping ok again", { after_failures: failures });
      failures = 0;
      logger.debug("keepalive", "ping ok", { status: res.status });
    } catch (err) {
      failures += 1;
      logger.warn("keepalive", "ping failed", { url: opts.url, failures, error: (err as Error).message });
    }
  };
  const timer = setInterval(() => void ping(), opts.intervalMs);
  timer.unref(); // never keeps the process alive on its own
  logger.info("keepalive", "started", { url: opts.url, interval_ms: opts.intervalMs });
  return () => clearInterval(timer);
}
