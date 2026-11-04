# on_track contract: road routing fields

Applies to the `on_track` event and to `GET /api/v1/track/:order_id` (admin viewer). All new fields are optional. Unchanged fields: `gps`, `gps_timestamp`, `path`, `status`, `tracking_url`, `updated_at`.

| Field | Type | Meaning |
|---|---|---|
| `route_ahead` | object or absent | Road route from the rider to the current destination |
| `route_ahead.polyline` | string | Google encoded polyline, precision 5 (OSRM `geometries=polyline`) |
| `route_ahead.to` | `"store"` or `"drop"` | Which destination the route goes to |
| `route_ahead.distance_m` | number | Road distance left, in meters |
| `route_ahead.duration_s` | number | OSRM driving time estimate, in seconds |
| `road_path` | string or absent | Trail so far snapped to roads, encoded polyline, precision 5 |
| `drop_gps` | `"lat,lng"` or absent | Buyer's delivery point, for the home marker |

Absent means "not available this update", never "error". Clients must treat every new field as optional.

Why encoded polylines: a 5 km route is a few hundred bytes, against several KB as a list of "lat,lng" strings.

## Example

```json
{
  "order_id": "od261101d3d87dff",
  "gps": "28.4302136,77.0433475",
  "gps_timestamp": "2026-11-01T04:39:05.726Z",
  "path": [{ "lat_lng": "28.4302136,77.0433475", "sequence": 1 }],
  "status": "active",
  "tracking_url": null,
  "updated_at": "2026-11-01T10:09:05.746+05:30",
  "route_ahead": {
    "polyline": "<encoded polyline>",
    "to": "drop",
    "distance_m": 2140,
    "duration_s": 380
  },
  "road_path": "<encoded polyline>",
  "drop_gps": "28.4351,77.0512"
}
```

## Coordinate order cheat sheet

| Place | Order |
|---|---|
| `gps`, `drop_gps`, `path[].lat_lng` | lat,lng |
| OSRM URL coordinates | lng,lat |
| OSRM response `waypoints[].location` | [lng, lat] |
| Decoded Google polyline | (lat, lng) pairs |
