# POST /internal/v1/track/enrich

_Created 2026-11-04 (initial boilerplate)._

## Purpose

Called by the BFF (`ondc-api`) **once per new rider GPS position**, right before it pushes
`on_track`. Returns the optional road-routing fields. The BFF spreads the response object into the
`on_track` event and the `GET /api/v1/track/:order_id` response, because the field names already
match the app-facing contract.

Internal only: reachable on the private network, never from phones.

## Request

```bash
curl -X POST http://osrm-bff:4100/internal/v1/track/enrich \
  -H 'Content-Type: application/json' \
  -H 'X-Internal-Token: <INTERNAL_TOKEN>' \
  -d '{
    "order_id": "od261101d3d87dff",
    "stage": "Out-for-delivery",
    "gps": "28.4302136,77.0433475",
    "store_gps": "28.4211,77.0366",
    "drop_gps": "28.4351,77.0512",
    "path": [
      { "lat_lng": "28.4290012,77.0421150", "sequence": 1, "timestamp": "2026-11-01T04:38:35.120Z" },
      { "lat_lng": "28.4302136,77.0433475", "sequence": 2, "timestamp": "2026-11-01T04:39:05.726Z" }
    ]
  }'
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `order_id` | string | yes | Cache key |
| `stage` | string | yes | ONDC fulfillment state as the caller has it. Hyperlocal and intercity/RTO codes are both understood (stage table below) |
| `gps` | `"lat,lng"` | yes | Current rider position |
| `store_gps` | `"lat,lng"` | no | Needed for the route before pickup |
| `drop_gps` | `"lat,lng"` | no | Needed for the route after pickup; echoed back. Source: fulfillment `end.location.gps`, else the saved address |
| `path` | array | no | The rider's recorded trail. Send the **whole** recorded path each time; the service matches only the new tail |
| `path[].lat_lng` | `"lat,lng"` | yes | |
| `path[].sequence` | number, or numeric string (`"3"`) | yes | Increasing per order |
| `path[].timestamp` | ISO-8601 string or Unix seconds | **no** (since 2026-11-09) | When the point was recorded. Send it when you have it: it improves matching. Points going back in time are ignored. If any point in a batch lacks one, the trail is matched on geometry alone |

**Request shape change (2026-11-09, backward compatible).** ONDC `/on_track` breadcrumbs, as
forwarded by `ondc-logistics-api`, carry string sequences and no per-point time. Every request that
was valid before is still valid and gives the same result.

| | Before 2026-11-09 | Since 2026-11-09 |
|---|---|---|
| `path[].timestamp` | required, else 400 | optional; if sent, it must parse, else 400 |
| `path[].sequence` | number only | number or numeric string |

```json
"path": [
  { "lat_lng": "28.495340,77.088059", "sequence": "1" },
  { "lat_lng": "28.495470,77.087364", "sequence": "2" }
]
```

### Stage table

| Stage | `route_ahead.to` |
|---|---|
| `Agent-assigned`, `At-pickup`, `Out-for-pickup`, `RTO-Initiated` (return to the store) | `store` |
| `Order-picked-up`, `Out-for-delivery`, `In-transit`, `At-destination-hub`, `Delivery-rescheduled` | `drop` |
| `Pending`, `Searching-for-Agent`, `Pickup-failed`, `Pickup-rescheduled`, `At-delivery`, `Delivery-failed`, anything unknown | omitted |
| `Order-delivered`, `Delivered`, `Cancelled`, `RTO-Delivered`, `RTO-Disposed` (final) | omitted, cache dropped |

All coordinates are **`"lat,lng"`**. The service converts to OSRM's `lng,lat` internally.

## Response

**Always `200`** when the input is valid, even if OSRM or Redis is down. Missing fields mean "not
available this update". Forward exactly what you get.

```json
{
  "route_ahead": { "polyline": "<encoded>", "to": "drop", "distance_m": 2140, "duration_s": 380 },
  "road_path": "<encoded>",
  "drop_gps": "28.4351,77.0512"
}
```

| Field | Type | When present |
|---|---|---|
| `route_ahead` | object | Stage has a destination (store before pickup, drop after) and OSRM found a route |
| `route_ahead.polyline` | string | Google encoded polyline, **precision 5** |
| `route_ahead.to` | `"store"` \| `"drop"` | |
| `route_ahead.distance_m` | number | Road distance left, metres |
| `route_ahead.duration_s` | number | OSRM driving estimate, seconds. **Display-only** until the ETA decision is made |
| `road_path` | string | At least 2 path points and a confident match. Encoded, precision 5 |
| `drop_gps` | `"lat,lng"` | Whenever `drop_gps` was sent |

On a final stage (`Order-delivered`, `Cancelled`, `RTO-Delivered`, `RTO-Disposed`) the service drops its cache for the order and returns only
`drop_gps`.

**Outside the covered area** (Delhi, Gurugram, Noida, Ghaziabad; updated 2026-11-06): when the
rider or destination is outside it, `route_ahead` is omitted, and trail points outside it are
ignored for `road_path`. Previously such orders could get an absurd route snapped to the edge of
the map. Same response shape; the fields are just absent.

## Status codes the caller must handle

| Code | Meaning | BFF action |
|---|---|---|
| 200 | Fields (possibly none) | Merge and push `on_track` |
| 400 | Malformed input (`{ "error": "..." }`) | Bug in the caller. Log it, push `on_track` without routing fields |
| 401 | Missing/wrong `X-Internal-Token` | Config error. Push without routing fields |
| timeout / 5xx / connection error | Service unhealthy | Push `on_track` **without** routing fields. Never delay or drop the GPS update |

## Timeout budget

The service makes the OSRM `/route` and `/match` calls in parallel, each capped at
`OSRM_TIMEOUT_MS` (default 1000 ms), plus Redis calls capped at `REDIS_COMMAND_TIMEOUT_MS`
(200 ms). **Recommended BFF client timeout: 1500 ms.** If you call with less, you'll sometimes
drop fields that were on their way. That's safe, just less useful.
