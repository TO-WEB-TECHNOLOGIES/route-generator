/**
 * ondc-logistics-api HTTP client. Never throws: every failure is a typed result.
 *  - requestTrack: POST /logistics/track { orderId }; the response is passed through to the frontend.
 *  - getFulfillmentState: GET /logistics/orders/:orderId/status, the fallback when a forwarded
 *    /on_track carries no fulfillmentState (LOGISTICS_API_CHANGES.md, change 2).
 */
import { logger } from "../logger.js";
import { recordLogistics } from "../metrics.js";

export type TrackForward =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "unavailable"; reason: "not_configured" | "timeout" | "error" };

export interface LogisticsClient {
  requestTrack(orderId: string): Promise<TrackForward>;
  /** null when unknown or the logistics API is unreachable. */
  getFulfillmentState(orderId: string): Promise<string | null>;
}

export interface HttpLogisticsClientOptions {
  /** undefined = not configured: requestTrack answers unavailable, getFulfillmentState null. */
  baseUrl: string | undefined;
  timeoutMs: number;
}

const isTimeout = (err: unknown) => (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";

export function createHttpLogisticsClient(opts: HttpLogisticsClientOptions): LogisticsClient {
  const base = opts.baseUrl;

  return {
    async requestTrack(orderId) {
      if (!base) return { kind: "unavailable", reason: "not_configured" };
      const started = performance.now();
      try {
        const res = await fetch(`${base}/logistics/track`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = text === "" ? null : JSON.parse(text);
        } catch {
          /* non-JSON body: pass the text through */
        }
        recordLogistics("track", res.ok ? "ok" : "rejected", performance.now() - started);
        logger.info("logistics", "track forwarded", { order_id: orderId, status: res.status });
        return { kind: "response", status: res.status, body };
      } catch (err) {
        const reason = isTimeout(err) ? "timeout" : "error";
        recordLogistics("track", reason, performance.now() - started);
        logger.warn("logistics", "track forward failed", { order_id: orderId, reason, error: (err as Error).message });
        return { kind: "unavailable", reason };
      }
    },

    async getFulfillmentState(orderId) {
      if (!base) return null;
      const started = performance.now();
      try {
        const res = await fetch(`${base}/logistics/orders/${encodeURIComponent(orderId)}/status`, {
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        if (!res.ok) {
          recordLogistics("status", "rejected", performance.now() - started);
          return null;
        }
        const body = (await res.json()) as { fulfillmentState?: unknown };
        recordLogistics("status", "ok", performance.now() - started);
        return typeof body.fulfillmentState === "string" && body.fulfillmentState !== "" ? body.fulfillmentState : null;
      } catch (err) {
        recordLogistics("status", isTimeout(err) ? "timeout" : "error", performance.now() - started);
        return null;
      }
    },
  };
}
