# Changes needed in ondc-logistics-api

_Written 2026-11-10 by osrm-bff. **Status: request, for the ondc-logistics-api owner.** The osrm-bff
side (the webhook below) is built and tested as of 2026-11-10.
That repo's own rules apply (plan first, a `changelogs/` entry per change). File and line references
were checked read-only against `../ondc-logistics-api` on 2026-11-10._

## Why

The frontend will show the rider's live position **with road routes**: the route ahead in orange,
the trail snapped to roads in navy, and the home marker. osrm-bff builds those lines, but it only
learns about a new rider position when the logistics API receives an `/on_track`. So the logistics
API must **forward every processed `/on_track` to osrm-bff**, with three extra fields it already
has in its DB.

```
frontend ──POST /v1/track {orderId}──► osrm-bff ──POST /logistics/track {orderId}──► logistics ──► LSP
                                                                                       (no change)
LSP ──/on_track──► logistics ──► existing SSE / stream events (no change)
                       └──NEW: POST {OSRM_BFF_URL}/internal/v1/logistics/on_track──► osrm-bff
                                                                                       │ adds routes
frontend ◄──────────────── SSE "track_update" ─────────────────────────────────────────┘
```

## Checklist

| # | Change | Required? |
|---|---|---|
| 1 | Forward each processed `/on_track` to osrm-bff (fire-and-forget) | **Yes** |
| 2 | Add `fulfillmentState` to that payload | **Strongly recommended**: without it, osrm-bff calls `GET /logistics/orders/:orderId/status` once per update to find the stage |
| 3 | Add `startGps` (store) and `endGps` (home) to that payload | **Yes**: without them there's no route ahead and no home marker |
| 4 | Config: `OSRM_BFF_URL`, `OSRM_BFF_TOKEN`, `OSRM_BFF_TIMEOUT_MS` | **Yes** |
| 5 | Answer the open questions at the end | **Yes**: they decide whether the trail works |

Nothing else changes: not the ONDC ACK, not the existing `order_tracking` / `order_status` events,
not `POST /logistics/track`.

---

## 1. Forward each processed `/on_track` to osrm-bff

**Where:** `src/repositories/track.repository.ts`, in the `/on_track` handler, in the
`if (!response.error && columns) { ... }` block, **after** the existing
`orderSseManager.publish(...)` and `stream.push(..., "order_tracking", ...)` calls (around lines
191–224 on 2026-11-10).

**When:**
- Only for a successfully processed callback (the same condition as the existing `order_tracking` publish).
- **Not** for duplicates (`"duplicate"`), unknown transactions (`"not_found"`), fulfillment
  mismatches (`"invalid_fulfillment"`), or `track_error`.

**How. These rules matter more than the code:**
- **Fire-and-forget.** Don't `await` it inside the callback's critical path, and never let it delay
  or fail the ONDC ACK, the DB transaction or the existing publishes.
- **Timeout** `OSRM_BFF_TIMEOUT_MS` (default 2000) via `AbortSignal.timeout`.
- **Never throws.** Catch everything, and log one line: `orderId`, HTTP status or error, latency.
- **No retries, no queue.** The next `/on_track` replaces this one anyway.
- **Never log the payload.** GPS trails are personal data. Log `orderId` only.
- If `OSRM_BFF_URL` is empty, skip the call entirely, so the feature is off by default.

Suggested shape (adapt to that repo's style):

```ts
// src/utils/osrm-bff.client.ts
export function forwardOnTrack(payload: OsrmBffOnTrack): void {
  const base = process.env.OSRM_BFF_URL;
  if (!base) return;
  const started = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.OSRM_BFF_TOKEN) headers["X-Internal-Token"] = process.env.OSRM_BFF_TOKEN;
  fetch(`${base.replace(/\/+$/, "")}/internal/v1/logistics/on_track`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(process.env.OSRM_BFF_TIMEOUT_MS ?? 2000)),
  })
    .then((res) => console.log("[osrm-bff] on_track forwarded", { orderId: payload.orderId, status: res.status, ms: Date.now() - started }))
    .catch((err) => console.log("[osrm-bff] on_track forward failed", { orderId: payload.orderId, error: String(err?.name ?? err), ms: Date.now() - started }));
}
```

## 2 + 3. The payload

**`POST {OSRM_BFF_URL}/internal/v1/logistics/on_track`**

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Internal-Token` | `OSRM_BFF_TOKEN`. **Required when osrm-bff runs with `ENV=PREPROD`**; ignored with `ENV=TEST` |

**Body:** the **same object you already push as the `order_tracking` stream event**, plus three fields.
Extra fields (`tags`, `config`, `trackedOrderId`, …) are fine: osrm-bff ignores what it doesn't use.

```json
{
  "event": "order_tracking",
  "transactionId": "aff231e9-10fc-4f93-8b8a-4c4b55d115a3",
  "orderId": "od26111026c0dd67",
  "status": "active",
  "url": "https://lsp.example/ondc/track/1",
  "gps": "28.497671,77.088763",
  "locationTimestamp": "2026-11-10T05:30:32.866Z",
  "path": [
    { "lat_lng": "28.495340,77.088059", "sequence": "1" },
    { "lat_lng": "28.497671,77.088763", "sequence": "2" }
  ],
  "updatedAt": "2026-11-10T05:30:34.472Z",
  "fulfillmentId": "1",

  "fulfillmentState": "Order-picked-up",
  "startGps": "28.495340,77.088059",
  "endGps": "28.459469,77.026635"
}
```

| Field | Status | Source in ondc-logistics-api | Used by osrm-bff for |
|---|---|---|---|
| `orderId` | **required** (already sent) | `row.orderId` | Cache key; which frontend streams get the update |
| `gps` | **required** (already sent) | `columns.trackingGps` | Rider marker, start of the route ahead |
| `path[]` | already sent | breadcrumb tags (`lat_lng`, `sequence` as strings) | Trail snapped to roads |
| `locationTimestamp`, `status`, `url`, `updatedAt` | already sent | as today | Passed through to the frontend |
| **`fulfillmentState`** | **NEW, strongly recommended** (fallback: one `GET .../status` per update) | `logisticsOrder.fulfillmentStateCode` (`src/db/schema/logistics-order.schema.ts:61`); `orderRow` is already loaded in the handler | Picks the destination: store before pickup, home after, none at/after delivery |
| **`startGps`** | **NEW, required** | init-order fulfillment `start_gps` (`src/db/schema/init-order.schema.ts:179`, read in `src/repositories/init-order-reader.ts`) | Store marker, route to the store |
| **`endGps`** | **NEW, required** | init-order fulfillment `end_gps` (`init-order.schema.ts:207`, same reader) | Home marker, route to the home |

Notes:
- **All coordinates are `"lat,lng"`** (latitude first), the same as the ONDC `gps` strings. Don't swap them.
- `startGps` / `endGps` never change after `/init`, so cache them per order (memory or Redis)
  instead of querying the init-order tables on every `/on_track`.
- If a value is unknown, **omit the field** (don't send `""` or `null`). osrm-bff then leaves out
  the route for that update; it never fails.

## 4. Config (ondc-logistics-api `.env.example`)

```
# osrm-bff: road routes for live tracking. Empty URL = feature off.
OSRM_BFF_URL=http://127.0.0.1:4100
OSRM_BFF_TOKEN=
OSRM_BFF_TIMEOUT_MS=2000
```

Use `127.0.0.1`, not `localhost`, on Windows: Node resolves `localhost` to IPv6 `::1`.

## What osrm-bff answers

| Status | Meaning | Logistics should |
|---|---|---|
| `202` | `{ "accepted": true }`. Routes are built after answering | nothing |
| `400` | Payload malformed (e.g. no `orderId` or bad `gps`) | log it; it's a bug, don't retry |
| `401` | Missing or wrong `X-Internal-Token` (PREPROD) | check `OSRM_BFF_TOKEN` |
| `5xx` / timeout / connection refused | osrm-bff down | log and move on. **Tracking for logistics' own clients must be unaffected** |

## `POST /logistics/track`: no change, but please confirm

osrm-bff will call it **server to server** with `{ "orderId": "…" }`, forwarding the frontend's
request. There's no `Origin` header, so CORS doesn't apply. Expect up to one call per watched order
about every 15 s, only while someone has the map open.

## 5. Open questions for the logistics owner

1. **How does each LSP number `path[].sequence`?** osrm-bff uses it to know which points are new.
   - A counter that grows for the whole order (`1, 2, … 250`), with all or the latest points each time: **works**.
   - The latest point only, always numbered `"1"`, or a window renumbered `1..N` on every callback:
     **the trail stops growing.** Please share two consecutive real `/on_track` payloads for the same order.
2. **Does every `/on_track` reach this handler for every LSP**, including `live_poll` and push-style configs?
3. **Which `fulfillmentState` values do your LSPs actually send** beyond the ONDC list in
   `docs/integration/post-order.md`? osrm-bff maps that list; unknown values just get no route.
4. **Can test orders on PREPROD use Delhi NCR coordinates?** osrm-bff's map covers Delhi, Gurugram,
   Noida and Ghaziabad only. A Bengaluru order (`12.97,77.61`) gets no routes at all.

## How to verify on your side

- **osrm-bff stopped:** `/on_track` still ACKs, and the `order_tracking` event still reaches your
  clients, unchanged and on time. The log shows one `on_track forward failed` line.
- **osrm-bff running (`ENV=TEST`):** an NCR order logs `on_track forwarded … status: 202`, and
  osrm-bff's dev page (`http://127.0.0.1:4100/dev/route-viewer`) shows the lines.
- **Duplicate `/on_track`:** no second forward.
