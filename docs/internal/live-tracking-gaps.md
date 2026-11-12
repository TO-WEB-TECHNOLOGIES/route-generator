# Live tracking: known gaps

_Written 2026-11-12. Scope: the logistics path (`POST /v1/track` → ondc-logistics-api → `/on_track`
webhook → SSE `GET /v1/orders/:orderId/track/events`). Each item is also tracked, with its status
tag, in `docs/ARCHITECTURE_REVIEW.md` (TRACK-01..06). When one is fixed, delete it here and there
and add one line to `docs/CHANGELOG.md`._

## What already works

- Per-order separation. The LSP's `/on_track` carries only `transaction_id`. ondc-logistics-api maps
  that to its order row and forwards `orderId`. Every osrm-bff key (`route:ahead|trail|crumbs|track:{orderId}`)
  and the stream hub are keyed by that `orderId`, so an update only reaches streams opened for that order.
- Stream mechanics: snapshot on connect, `retry: 3000`, keep-alive every 25 s, one `track_update`
  per `/on_track` (routes within `ENRICH_DEADLINE_MS`), `track_closed` + stream end at a final stage.
- Degraded modes: OSRM down/slow, Redis down, out-of-coverage orders, URL-only LSPs all still push.

## Gaps

| ID | Problem | Severity | Fix lives in |
|---|---|---|---|
| TRACK-01 | No access control on the stream / snapshot | **Blocks production** | osrm-bff + app (auth design) |
| TRACK-02 | Stream may never close after delivery | High | logistics + osrm-bff |
| TRACK-03 | Async tracking errors never reach the frontend | Medium | logistics + osrm-bff |
| TRACK-04 | No polling limit per order; no polling without viewers | Medium | osrm-bff |
| TRACK-05 | Streams live in one process's memory | Blocks scaling out | osrm-bff (Redis pub/sub) |
| TRACK-06 | Unknown order ids are accepted | Low | osrm-bff |

### TRACK-01 No access control on the stream / snapshot

- **Today:** `ENV=TEST` checks nothing. `ENV=PREPROD` requires `X-Internal-Token`, but a browser
  `EventSource` can't send headers, so the stream fails with 401 in real browsers. The token must
  never ship in a release build anyway.
- **Effect:** in TEST, anyone who knows or guesses an `orderId` can watch that rider's live position
  and the buyer's home location (`drop_gps`). That's personal data.
- **Options:** a short-lived signed token per order, issued by the backend that knows the buyer
  (passed as a query param or cookie), or the app's real login. Same decision as INT-04 (Q4).

### TRACK-02 Stream may never close after delivery

- **Today:** the stream only closes when an `/on_track` arrives with a final `fulfillmentState`.
- **Problem:** ONDC says tracking becomes inactive after delivery, so an LSP may never send that last
  `/on_track`. Delivery is reported in `/on_status`, which logistics doesn't forward to osrm-bff.
- **Effect:** open maps keep a stale rider position, the frontend keeps polling `POST /v1/track`
  (likely failing), and the snapshot and route caches linger until their 2 h TTL.
- **Fix:** logistics forwards `/on_status` (at least final states) to osrm-bff the same way as
  `/on_track`; osrm-bff then sends `track_closed`. A cheaper fallback is to close when
  `POST /v1/track` returns a "tracking inactive" answer.

### TRACK-03 Async tracking errors never reach the frontend

- **Today:** `POST /logistics/track` answers `202 TRACK_SENT`. If the LSP then rejects tracking
  asynchronously (e.g. `60012`, not trackable before pickup), logistics emits `track_error` only to
  its own clients. It isn't forwarded to osrm-bff.
- **Effect:** the frontend sees a silent map with no updates and no reason, and keeps polling.
- **Fix:** logistics forwards `track_error` (orderId, code, message); osrm-bff pushes a `track_error`
  SSE event. This is a new optional event, an additive contract change in `docs/integration-docs/track.md`.

### TRACK-04 No polling limit per order; no polling without viewers

- **Today:** every open map calls `POST /v1/track` about every 15 s, and osrm-bff forwards each one.
- **Effect:** five viewers means five `/track` calls to the LSP every 15 s for one order, and a risk of
  LSP rate limits or NACKs. When nobody has the map open nothing polls, so the trail has gaps and
  routes are rebuilt from scratch when someone opens it.
- **Fix:** forward at most one `/track` per order per interval (e.g. `TRACK_MIN_INTERVAL_MS`, one Redis
  key with a short TTL) and answer the extra calls with the same 202. Server-side polling without
  viewers is a separate decision (cost vs trail completeness).

### TRACK-05 Streams live in one process's memory

- **Today:** `src/tracking/hub.ts` keeps open streams in a `Map`.
- **Effect:** with two or more osrm-bff processes, the webhook can land on a process that doesn't hold
  the order's streams, so that frontend never gets the update. Run one process until fixed.
- **Fix:** Redis pub/sub per order. Already tracked as SCALE-02.

### TRACK-06 Unknown order ids are accepted

- **Today:** any string up to 128 characters opens a stream and waits. The snapshot answers 404, and
  `POST /v1/track` passes through whatever logistics says.
- **Effect:** typos look like "no updates yet", and an open endpoint can be used to hold connections open.
- **Fix:** check the order with logistics on connect, cache the result briefly, then answer 404
  `UNKNOWN_ORDER`. Best done together with TRACK-01, since the auth token would already name the order.
