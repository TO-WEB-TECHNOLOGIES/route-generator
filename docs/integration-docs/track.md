# Live order tracking: `/v1/track` + stream

_Created 2026-11-10. Audience: the frontend (users app) team._

## Purpose

Shows the rider live on the order map, **with road routes**. The frontend talks only to osrm-bff:

1. It asks for a tracking update with `POST /v1/track`. We forward that to the logistics API, which
   asks the delivery partner (LSP).
2. When the LSP answers, the logistics API forwards it to us. We add the road routes and **push**
   the result to the frontend over a Server-Sent Events (SSE) stream.

```
frontend                         osrm-bff                         logistics API / LSP
   │ GET /v1/orders/{id}/track/events ─►│ (stays open)
   │ ◄── track_update (latest, if any) ─│
   │ POST /v1/track {orderId} ─────────►│ ── POST /logistics/track ───────►│
   │ ◄── 202 TRACK_SENT ────────────────│                                  │ asks the LSP
   │                                    │ ◄── on_track (forwarded) ────────│
   │ ◄── track_update ──────────────────│ (adds routes, ≤ ~1.2 s)
   │ ◄── ": keep-alive" every 25 s ──────│
   │ ... POST /v1/track again every ~15 s while the map is open ...
   │ ◄── track_closed (delivered/cancelled), stream ends
```

**Access.**
- With `ENV=TEST` there are no token checks.
- With `ENV=PREPROD`, every call needs `X-Internal-Token`. That's for internal QA builds only:
  **never ship the token in a release build.** App login is not decided yet.

All coordinates are `"lat,lng"` (latitude first). Polylines are Google encoded, **precision 5**.

---

## `POST /v1/track`

Asks for a fresh rider position. The answer to *this* call is only an acknowledgement: the position
arrives later on the stream.

```bash
curl -X POST http://127.0.0.1:4100/v1/track \
  -H 'Content-Type: application/json' \
  -d '{ "orderId": "od26111026c0dd67" }'
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | yes | The **logistics** order id |

| Status | Body | Frontend does |
|---|---|---|
| `202` | `{ "orderId", "transactionId", "messageId", "status": "TRACK_SENT" }` (from the logistics API) | Wait for `track_update` on the stream |
| any logistics error, e.g. `60012` | the logistics API's error body, **unchanged** | `60012` = not picked up yet: show store + home only, retry slower (~30 s) |
| `400` | `{ "error": { "code": "INVALID_ORDER_ID" } }` | Bug: fix the request |
| `401` | `{ "error": "unauthorized" }` | PREPROD: missing/wrong token |
| `503` | `{ "error": { "code": "LOGISTICS_UNAVAILABLE" } }` | Logistics API down or slow (5 s). Keep the last state, retry on the next tick |

Call it every **~15 s**, only while the map screen is visible. Each call reaches a real LSP.

---

## `GET /v1/orders/{orderId}/track/events` (SSE)

The stream that delivers updates. On connect, it first sends the **latest update** if there is one,
so a reconnecting client never waits for the next one.

```
retry: 3000
: connected

event: track_update
id: 1762752634472
data: {"order_id":"od26111026c0dd67","stage":"Order-picked-up","gps":"28.497671,77.088763", … }

: keep-alive

event: track_closed
data: {"order_id":"od26111026c0dd67","stage":"Order-delivered"}
```

| Event | When | Frontend does |
|---|---|---|
| `track_update` | Every new position (and once on connect, if known) | **Replace** the whole map state with `data` (it's not a diff) |
| `track_closed` | Final stage: `Order-delivered`, `Cancelled`, `RTO-Delivered`, `RTO-Disposed` | Show the final state, stop polling, close the stream. The server ends it |
| `: keep-alive` (comment) | Every 25 s | Nothing (SSE clients ignore comments) |

`id` is the update time in Unix milliseconds. `retry: 3000` makes clients reconnect after 3 s.

### `track_update` fields

| Field | Type | Always? | Draw |
|---|---|---|---|
| `order_id` | string | yes | |
| `gps` | `"lat,lng"` | **no** (since 2026-11-12) | Rider marker (animate old → new over ~1 s). **Missing = URL-based tracking**: the LSP gives no position, only `tracking_url` (see below) |
| `updated_at` | ISO 8601 | yes | |
| `stage` | string | no | Status label. ONDC fulfillment state (`Order-picked-up`, `Out-for-delivery`, …) |
| `gps_timestamp` | ISO 8601 | no | "Updated 20 s ago"; grey the rider out if older than ~2 min |
| `status` | string | no | LSP tracking status (`active`, …) |
| `tracking_url` | string | no | The LSP's tracking page. Show it as "Track on partner site" when there's no `gps` |
| `route_ahead` | object | no | Rider → destination. Orange `#FF7A00` width 5 over navy `#1B2A49` width 8 |
| `route_ahead.polyline` | string | | Decode, precision 5 |
| `route_ahead.to` | `"store"` \| `"drop"` | | Which marker the line ends at |
| `route_ahead.distance_m` / `duration_s` | number | | "2.1 km · 6 min". **Display-only**, not the official ETA |
| `road_path` | string | no | Trail so far, snapped to roads. Navy, width 5, below the route. Built from the rider positions we receive (one per update, 2026-11-12), so it first appears on the order's **second** update with movement and grows from there |
| `drop_gps` | `"lat,lng"` | no | Home marker |
| `store_gps` | `"lat,lng"` | no | Store marker |

**URL-based tracking (2026-11-12).** Some LSPs track by URL only (ONDC config `deferred`). Their
updates have `tracking_url`, `stage`, `status`, `store_gps`, `drop_gps` and **no `gps`**, so there's no
rider marker and no `route_ahead` / `road_path` (nothing to route from). Keep the store and home
markers, draw the dashed straight line store → home, and show the link. Don't move or clear a rider
marker you drew from an earlier update; grey it out instead. **Breaking for clients that assumed
`gps` is always there.**

**Any field missing = not available this update, never an error.** No `route_ahead`: draw a dashed
straight line rider → destination. No `road_path`: draw nothing. Routes only exist inside the
covered area: Delhi NCR (Delhi, Gurugram, Noida, Ghaziabad) and Bengaluru.

| Status | When |
|---|---|
| `200` + stream | Normal |
| `400` `INVALID_ORDER_ID` | Empty or > 128 characters |
| `401` | PREPROD: missing/wrong token |

---

## `GET /v1/orders/{orderId}/track`

The latest `track_update` as plain JSON, for a first render or a manual refresh. Same shape as the
event's `data`.

| Status | Body |
|---|---|
| `200` | the latest `track_update` |
| `404` | `{ "error": { "code": "NO_UPDATE_YET" } }`: nothing received yet, the order already finished, or our cache is briefly unavailable. Live updates on the stream still arrive |
| `400` / `401` | as above |

---

## Frontend example (React Native)

The browser's built-in `EventSource` **can't send headers**, so it only works with `ENV=TEST`. In
React Native, use `react-native-sse`, which can.

```ts
import EventSource from "react-native-sse";
import polyline from "@mapbox/polyline";

const headers = token ? { "X-Internal-Token": token } : {};          // PREPROD QA builds only
const es = new EventSource(`${BASE}/v1/orders/${orderId}/track/events`, { headers });

es.addEventListener("track_update", (e) => {
  const u = JSON.parse(e.data!);
  setMap({
    rider: u.gps, store: u.store_gps, home: u.drop_gps, stage: u.stage,
    ahead: u.route_ahead ? polyline.decode(u.route_ahead.polyline, 5) : null,   // [[lat, lng], …]
    trail: u.road_path ? polyline.decode(u.road_path, 5) : null,
  });
});
es.addEventListener("track_closed", () => { es.close(); clearInterval(poll); });
es.addEventListener("error", () => { /* keep the last state; the library reconnects */ });

// Open the stream first, then start asking.
const requestTrack = () =>
  fetch(`${BASE}/v1/track`, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
                              body: JSON.stringify({ orderId }) });
requestTrack();
const poll = setInterval(requestTrack, 15_000);
// On screen blur/unmount: clearInterval(poll); es.close();
```

Drawing details (styles, fallbacks, camera, marker animation): `understanding/06-drawing-the-map-on-the-app.md`.
Try the whole flow locally in the **Live order** tab of `http://127.0.0.1:4100/dev/route-viewer`.

To watch a driver move without the logistics API (2026-11-13): open
`http://127.0.0.1:4100/dev/live-map?orderId=live-demo-1`, press Start (the road route between the
two points appears), then send the Postman folder "06 live map demo" (or any forwarded `/on_track`
for that `orderId`). Each update moves the driver and redraws the route from its new position.
Dev only, like the route viewer.
