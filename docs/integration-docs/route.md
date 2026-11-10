# GET /v1/route

_Created 2026-11-06 (Part 1)._

## Purpose

Road route between two points in the covered area (Delhi NCR: Delhi, Gurugram, Noida, Ghaziabad;
Bengaluru since 2026-11-10), ready to
draw on a map: e.g. a store → home preview before a rider is assigned.

**Access (for now):** internal only. If the service has `INTERNAL_TOKEN` set, send it as
`X-Internal-Token`. App-facing login is still to be decided (`understanding/05`, Q4).

## Request

```bash
curl -H 'X-Internal-Token: <INTERNAL_TOKEN>' \
  'http://127.0.0.1:4100/v1/route?from=28.4950,77.0886&to=28.4595,77.0266'
```

| Query param | Type | Required | Notes |
|---|---|---|---|
| `from` | `"lat,lng"` | yes | Start point. **Latitude first** |
| `to` | `"lat,lng"` | yes | End point |

## Response `200`

```json
{
  "from": "28.495,77.0886",
  "to": "28.4595,77.0266",
  "polyline": "{n|lDkgouMn@f@BN?LGNYPSHe@d@M?kAeASQk@o@…",
  "distance_m": 9507,
  "duration_s": 713
}
```

| Field | Type | Meaning |
|---|---|---|
| `from`, `to` | `"lat,lng"` | The points used, echoed back normalized (e.g. `28.4950` → `28.495`) |
| `polyline` | string | Google encoded polyline, **precision 5**. Decode with any standard decoder (`understanding/06`) |
| `distance_m` | number | Road distance, metres |
| `duration_s` | number | OSRM driving estimate (car profile), seconds. Display-only (not an official ETA) |

The line starts and ends on the nearest road to each point, which can be a few tens of metres
from the requested point (e.g. inside a building or campus).

## Errors

Body: `{ "error": { "code": "...", "message": "..." } }`. For every error, the app should fall back
to a straight line.

| Status | `error.code` | When |
|---|---|---|
| 400 | `INVALID_POINT` | `from`/`to` missing or not `"lat,lng"` |
| 401 | — (`{ "error": "unauthorized" }`) | Missing/wrong `X-Internal-Token` |
| 422 | `OUT_OF_COVERAGE` | A point is outside the covered area. Also catches most lat/lng swaps |
| 404 | `NO_ROUTE` | No road route, a point is more than 200 m from any road, or one point is in NCR and the other in Bengaluru (both covered, but not connected in the map; 2026-11-10) |
| 503 | `ROUTING_UNAVAILABLE` | The routing engine is down or slow. Answered within about 1 s; retry later |

## Timeout budget

One OSRM call, capped at `OSRM_TIMEOUT_MS` (default 1000 ms). A client timeout of 1500 ms is
enough. Measured on the local NCR map: ~120 ms on average.
