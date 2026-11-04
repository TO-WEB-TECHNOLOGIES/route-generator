---
name: bff-road-routing
description: "How our BFF adds road routes to order tracking using a self-hosted OSRM server. Use this skill for any work on rider tracking routes: building or changing the on_track event, GET /api/v1/track/:order_id, the route_ahead / road_path / drop_gps fields, OSRM /route or /match calls, the Redis route cache, the OSRM container, map extracts and the weekly refresh, or the app drawing routes on the order map. Also use it when someone mentions OSRM, Geofabrik, car.lua, snapping the rider trail to roads, the orange/navy route lines, the missing home marker, or removing the phones' calls to the public OSRM demo server, even if they don't say \"routing\"."
---

# Road routing on the BFF (self-hosted OSRM)

The BFF runs its own OSRM server on a private network. Each time the BFF builds an `on_track` event, it adds the road route from the rider to the current destination and the rider's trail snapped to roads. Phones never call a routing server.

Keep that last point in mind for every change: the public demo server (router.project-osrm.org) allows about 1 request per second for the whole app, non-commercial only, and can block us without notice. Phone-side routing at 100 active orders is ~7 req/s steady plus trail-backfill bursts. Routing once per order on the BFF means one call per GPS update no matter how many phones watch the order, and every viewer sees the same line. So if a change would make the app call OSRM (or any routing API) directly in a release build, push back and route through the BFF instead.

## Where things live

- OSRM container: private network, port 5000, reachable only from the BFF. No auth, no public access.
- Redis: route cache, next to the BFF.
- App: receives only finished encoded polylines inside `on_track`.
- Contract docs: `documentations/track.md` in the users app repo. Update it whenever the fields change.

Read `references/contract.md` before touching the event payload, and `references/osrm-ops.md` before touching the container, the map data or the refresh job.

### In the `osrm-bff` repo

The routing logic lives in its own service (`osrm-bff`), which sits next to the BFF (`ondc-api`) on the private network. The BFF calls `POST /internal/v1/track/enrich` once per GPS update and merges the returned fields into `on_track`. The service never throws routing failures back as errors: it returns 200 with whichever fields it could build.

| Concern | File |
|---|---|
| `"lat,lng"` parsing, OSRM `lng,lat` formatting, haversine | `src/geo/point.ts` |
| Polyline encode/decode (precision 5) | `src/geo/polyline.ts` |
| OSRM `/route` + `/match` client (timeout, metrics) | `src/osrm/client.ts` |
| Stage → destination table | `src/routing/stage.ts` |
| Route ahead + 30 m re-route check | `src/routing/route-ahead.ts` |
| Incremental trail matching | `src/routing/road-path.ts` |
| Redis keys + TTL constants | `src/routing/cache.ts` |
| Orchestration (never throws) | `src/routing/enrich.ts` |
| Tunables (timeouts, thresholds) | `src/config.ts` |
| Internal API contract | `docs/integration-docs/track-enrich.md` |

## What the BFF does on each new GPS position

The BFF already polls the seller for GPS and pushes `on_track` about every 15 s. When a new position arrives, do these two steps before pushing.

### 1. Route ahead (rider → destination)

Pick the destination from the order stage:

| Stage | Destination | `route_ahead.to` |
|---|---|---|
| Agent-assigned, At-pickup | store GPS | `"store"` |
| Order-picked-up, Out-for-delivery | buyer drop GPS | `"drop"` |
| At-delivery, delivered, cancelled | none: stop routing, omit `route_ahead` | — |

Drop GPS comes from the fulfillment's `end.location.gps`, or the saved address's lat/lng. Send it as `drop_gps` too; this is what fixes the missing home marker on orders opened from another device.

Call:

```
GET http://osrm:5000/route/v1/driving/{rider_lng},{rider_lat};{dest_lng},{dest_lat}?overview=full&geometries=polyline
```

OSRM takes **lng,lat**. Our `gps` strings are **"lat,lng"**. Swapping them is the most likely bug here: the request usually still succeeds but routes somewhere absurd or returns `NoRoute`. Parse once into a typed point and build the URL from named fields.

Only re-route when the rider moved more than ~30 m (haversine) from the point the cached route was built from, or the stage changed. Otherwise resend the cached route. This keeps the line stable while the rider waits at a light and cuts OSRM load.

From the response, take `routes[0].geometry`, `routes[0].distance` (→ `distance_m`) and `routes[0].duration` (→ `duration_s`).

### 2. Trail snapped to roads (`road_path`)

Send the rider's recorded points (the existing `path`) with their timestamps to OSRM `/match`, which is built for noisy GPS traces:

```
GET http://osrm:5000/match/v1/driving/{lng,lat;lng,lat;...}?timestamps={t1;t2;...}&overview=full&geometries=polyline
```

Timestamps are Unix seconds and must not decrease. Match only the new tail on each update: keep the already-matched polyline and last matched sequence in Redis, match from a point or two before that sequence (so the pieces join), and append. Don't re-match the whole trail each time; it grows with the order and gets slower.

If OSRM returns no matching or a low `confidence`, leave `road_path` out for that update rather than sending a bad line. The threshold isn't fixed in the design yet; make it a config value and note what you chose.

## Cache (Redis)

| Key | Value | TTL |
|---|---|---|
| `route:ahead:{order_id}` | polyline, distance_m, duration_s, rider point and stage it was built from | 2 h |
| `route:trail:{order_id}` | matched trail polyline + last matched sequence | 2 h |

Store the rider point and stage with the route ahead; the 30 m / stage-change check needs them.

## Failure rules (don't bend these)

Routing is decoration on top of tracking. The GPS update is the real product, so:

- OSRM timeout ~1 s. On error or timeout, push `on_track` without the new fields. Never delay or drop the GPS update because routing failed.
- No route, or low match confidence: omit that field for that update. The app falls back to straight lines.
- Log OSRM latency and error counts so a dead container shows up.

When writing tests, include one where OSRM is down or slow and assert that `on_track` still goes out on time with only the existing fields.

## Contract summary

Three optional fields, added to both `on_track` and `GET /api/v1/track/:order_id` (admin viewer): `route_ahead` (object: `polyline`, `to`, `distance_m`, `duration_s`), `road_path` (string), `drop_gps` ("lat,lng"). Existing fields (`gps`, `gps_timestamp`, `path`, `status`, `tracking_url`, `updated_at`) don't change, so older app versions keep working. Never rename, retype or make the new fields required without a versioned contract change. Full field table and example in `references/contract.md`.

Polylines are Google encoded, precision 5 (OSRM `geometries=polyline`, not `polyline6`). Both sides must agree on precision or the line lands in the wrong place.

## App side

Once the BFF ships the fields:

- Draw `route_ahead.polyline` in orange with a navy border, `road_path` in navy, in release builds too.
- Use `drop_gps` for the home marker.
- If a field is absent, fall back to straight lines; don't show an error.
- Remove the debug-only phone calls to the public OSRM server.

## Open questions: flag, don't decide silently

These are still open in the design. If a task depends on one, say so and ask, or pick a reversible default and call it out:

- Which cities/zones are needed on day one, and so which Geofabrik extract.
- Where OSRM runs (same VPC as the BFF) and who owns the weekly refresh.
- Custom two-wheeler profile vs `car.lua` (car.lua obeys one-way streets, so routes can be longer than what riders actually take).
- Whether drop GPS is reliably in `end.location.gps` for every seller, or should come from the saved address.
- Whether `route_ahead.duration_s` feeds the "Arriving in" ETA or stays display-only. Until decided, keep it display-only.

## Rollout checklist

- [ ] OSRM on staging with one regional extract; `scripts/smoke_test.sh` passes from the BFF host
- [ ] `route_ahead`, `road_path`, `drop_gps` in `on_track` and `GET /track/:order_id` on staging
- [ ] Kill OSRM mid-order: `on_track` still arrives every ~15 s without the new fields
- [ ] Live test order: store route before pickup, drop route after pickup, nothing after delivery
- [ ] Ship the app update that draws the fields, then turn it on in production
- [ ] Weekly map refresh job and an alert on OSRM errors
