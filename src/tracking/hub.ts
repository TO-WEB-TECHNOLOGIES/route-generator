/**
 * Open frontend SSE streams per order (GET /v1/orders/:orderId/track/events).
 * In memory and per process: run ONE osrm-bff process until this moves to Redis pub/sub
 * (docs/ARCHITECTURE_REVIEW.md SCALE-02).
 *
 * Wire format (text/event-stream):
 *   retry: 3000                      once, on connect: client reconnect delay
 *   event: track_update / id / data  one per /on_track
 *   event: track_closed              final stage reached; the server then ends the stream
 *   : keep-alive                     every SSE_KEEPALIVE_MS so proxies don't drop an idle stream
 */
import type { Response } from "express";
import { logger } from "../logger.js";

export type SendFn = (event: string, data: unknown, id?: string) => void;

const frame = (event: string, data: unknown, id?: string) =>
  `event: ${event}\n${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

export class TrackStreamHub {
  private readonly streams = new Map<string, Set<Response>>();

  constructor(private readonly keepaliveMs: number) {}

  /** Starts the stream on `res`. Returns a sender for this stream only (e.g. the initial snapshot). */
  subscribe(orderId: string, res: Response): SendFn {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx: don't buffer the stream
    res.flushHeaders();
    res.write("retry: 3000\n: connected\n\n");

    const set = this.streams.get(orderId) ?? new Set<Response>();
    set.add(res);
    this.streams.set(orderId, set);

    const keepalive = setInterval(() => res.write(": keep-alive\n\n"), this.keepaliveMs);
    keepalive.unref();
    res.on("close", () => {
      clearInterval(keepalive);
      const s = this.streams.get(orderId);
      s?.delete(res);
      if (s?.size === 0) this.streams.delete(orderId);
    });
    logger.info("track", "stream opened", { order_id: orderId, streams: set.size });
    return (event, data, id) => res.write(frame(event, data, id));
  }

  publish(orderId: string, event: string, data: unknown, id?: string): number {
    const set = this.streams.get(orderId);
    if (!set) return 0;
    const encoded = frame(event, data, id);
    for (const res of set) res.write(encoded);
    return set.size;
  }

  /** Sends a final event and ends every stream of the order. */
  close(orderId: string, event: string, data: unknown): void {
    const set = this.streams.get(orderId);
    if (!set) return;
    const encoded = frame(event, data);
    for (const res of set) res.end(encoded);
    this.streams.delete(orderId);
  }

  /** Shutdown: open SSE responses would otherwise keep server.close() waiting forever. */
  closeAll(): void {
    for (const set of this.streams.values()) for (const res of set) res.end();
    this.streams.clear();
  }

  openStreams(): number {
    let n = 0;
    for (const set of this.streams.values()) n += set.size;
    return n;
  }
}
