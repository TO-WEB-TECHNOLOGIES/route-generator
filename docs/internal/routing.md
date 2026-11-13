# Routing — Internal Notes

_Created 2026-11-04 (initial boilerplate)._ Design spec: `.claude/skills/bff-road-routing/SKILL.md`.

## Module map

| File | Role |
|---|---|
| `src/index.ts` | Wires config, Redis, OSRM client, HTTP server; graceful shutdown |
| `src/app.ts` | Express app: `/` and `/health` (same liveness handler, 2026-11-09), `/metrics`, `/v1/route`, `/internal/v1/track/enrich`, shared token guard (`requireInternalToken`) |
| `src/routes/enrich.routes.ts` | Input validation (`parseEnrichBody`) -> `enrich()` |
| `src/routes/route.routes.ts` | `GET /v1/route`: validation, coverage check, OSRM result -> 200/400/404/422/503 (added 2026-11-06) |
| `src/routing/enrich.ts` | Orchestrator. Coverage guard, then runs route-ahead and road-path in parallel (`Promise.allSettled`). Never throws |
| `src/routing/stage.ts` | Stage -> destination, terminal stages. Hyperlocal + logistics/intercity/RTO codes (2026-11-09) |
| `src/routing/route-ahead.ts` | Cached route + 30 m / stage-change re-route check |
| `src/routing/road-path.ts` | Incremental `/match` of the trail tail, appended to the cached polyline |
| `src/routing/cache.ts` | Redis keys, TTL constants, `RouteCache` interface (Redis errors = miss) |
| `src/osrm/client.ts` | `/route` and `/match` over `fetch` with `AbortSignal.timeout`. Returns typed results, never throws |
| `src/geo/point.ts` | `"lat,lng"` parsing, `toOsrmCoord` (lng first), haversine, `Bbox` / `parseBbox` / `isInBbox` |
| `src/geo/polyline.ts` | Encode/decode precision 5, `joinPaths` |
| `src/metrics.ts` | OSRM call outcomes + latency, logistics calls, track counters (`webhooks`, `webhooks_no_gps`, `updates_pushed`, `routing_deadline_hit`), served on `/metrics` |
| `src/config.ts` | All tunables |
| `src/keepalive.ts` | Self-ping of our public `/health` to stay awake on free hosts (2026-11-10) |
| `ops/render/` | Render free-tier image: one container with OSRM on 127.0.0.1 + osrm-bff (`docs/deployment/render.md`) |
| `src/logistics/types.ts` | Structural copies of ondc-logistics-api's `order_tracking` / `order_status` events + our proposed `OrderEndpoints` (2026-11-09) |
| `src/logistics/mapper.ts` | Pure `toEnrichInput()` / `breadcrumbsToPath()`: string sequences, no timestamps; bad LSP breadcrumbs dropped, not fatal (2026-11-09) |
| `src/routes/track.routes.ts` | Frontend: `POST /v1/track` (forward to logistics), `GET /v1/orders/:orderId/track` (snapshot), `.../track/events` (SSE) (2026-11-10) |
| `src/routes/logistics-webhook.routes.ts` | `POST /internal/v1/logistics/on_track`: validates, answers 202, then `handleOnTrack()` (2026-11-10) |
| `src/tracking/service.ts` | `handleOnTrack()`: stage (payload, else `GET .../status`) + enrich under `ENRICH_DEADLINE_MS`, then push + snapshot. Never throws |
| `src/tracking/hub.ts` | In-memory SSE streams per order (one process only: SCALE-02), keep-alive, close on final stage |
| `src/tracking/snapshot.ts` | Latest `track_update` per order in Redis |
| `src/tracking/crumbs.ts` | Pure `appendCrumb()` / `crumbsToPath()`: our own rider breadcrumbs for the logistics path, which drive the trail instead of the LSP's `path[]` (2026-11-12, ROUTE-11) |
| `src/logistics/client.ts` | `requestTrack()` / `getFulfillmentState()` over `fetch` with timeout. Never throws |
| `src/routes/dev-viewer.routes.ts` | `GET /dev/route-viewer`: dev map page (Leaflet + OSM tiles) drawing `/v1/route` and enrich responses. Only when `DEV_VIEWER_ENABLED` (2026-11-09). "Features" tab: every route and webhook scenario, one click each; `GET /dev/route-viewer/info` = mode and tunables, never secrets (2026-11-12) |
| `src/routes/dev-live-map.routes.ts` | `GET /dev/live-map` (2026-11-13): dev page for manual live-tracking tests. Planned route from `/v1/route`, then the order's SSE stream: the driver marker glides to each `track_update.gps`, `route_ahead` / `road_path` redrawn, straight-line fallback when `route_ahead` is absent. Never calls `POST /v1/track`. Query: `orderId`, `from`, `to`, `autostart=1`. Same switch as the route viewer. Driven by Postman "06 live map demo" |
| `test/fixtures/logistics/` | Logistics-shaped test data (see its README) |

Dependencies are injected (`EnrichDeps`), so `test/` runs with in-memory fakes and needs no
Redis or OSRM. `test/osrm-failure.test.ts` drives the real HTTP client against stub servers.

## Redis keys

All keys carry `REDIS_KEY_PREFIX` (ioredis `keyPrefix`). The cache is derived and disposable.

| Key | Value | TTL constant | Deleted by |
|---|---|---|---|
| `route:ahead:{order_id}` | `{ polyline, distance_m, duration_s, to, from: {lat,lng}, stage }` | `ROUTE_AHEAD_TTL_S` = 7200 | `cache.clear()` on terminal stage, else TTL |
| `route:trail:{order_id}` | `{ polyline, last_seq }` | `ROUTE_TRAIL_TTL_S` = 7200 | `cache.clear()` on terminal stage, else TTL |
| `route:crumbs:{order_id}` | `{ next_seq, points: [{ lat, lng, t, seq }] }`: our own breadcrumbs, newest last, at most `CRUMBS_MAX_POINTS`. Logistics path only | `ROUTE_CRUMBS_TTL_S` = 7200 | `cache.clear()` on terminal stage (`enrich()`), else TTL. Added 2026-11-12 |
| `route:track:{order_id}` | latest `TrackUpdate` (what the frontend got last) | `TRACK_SNAPSHOT_TTL_S` = 7200 | `snapshots.delete()` on a final stage (`tracking/service.ts`), else TTL. Added 2026-11-10 |

## Tunables

| Env var | Default | Meaning |
|---|---|---|
| `OSRM_BASE_URL` | `http://osrm:5000` | Private OSRM. Startup refuses `router.project-osrm.org` |
| `OSRM_PROFILE` | `driving` | URL profile segment (the server's profile is fixed at build time: `car.lua`) |
| `OSRM_TIMEOUT_MS` | 1000 | Per OSRM call |
| `REDIS_COMMAND_TIMEOUT_MS` | 200 | Per Redis command; offline queue disabled so a dead Redis fails fast |
| `REROUTE_THRESHOLD_M` | 30 | Re-route when the rider moved more than this from the cached route's origin |
| `MATCH_MIN_CONFIDENCE` | 0.5 | **Reversible default**, not from the design (ROUTE-03). Below this, omit `road_path` |
| `MATCH_OVERLAP_POINTS` | 1 | Already-matched points re-sent so pieces join (skill: "a point or two") |
| `MATCH_MAX_POINTS` | 100 | Cap per `/match`; must be <= `osrm-routed --max-matching-size` |
| `MATCH_RADIUS_M` | 30 | Per-point `/match` search radius (`radiuses`). OSRM's default dropped 9/25 points at ±25 m noise; 30 m matched all (2026-11-06). 0 = OSRM default |
| `COVERAGE_BBOX` | `76.75,28.20,77.80,28.95;77.35,12.75,77.90,13.25` | Area the map covers: one box per region (NCR;Bengaluru since 2026-11-10), `;`-separated, each `minLng,minLat,maxLng,maxLat`; `none` = off. A point is covered if it's in any box. **Must equal `OSRM_BBOX`** in `ops/osrm/prep.Dockerfile` (checked by `test/geo.test.ts`) |
| `MAX_SNAP_DISTANCE_M` | 200 | A `/route` whose `waypoints[].distance` (how far OSRM moved a point to reach a road) exceeds this is treated as no route (`SnapTooFar`) |
| `ENV` | `PREPROD` when unset | `TEST`: no token checks. `PREPROD`: `X-Internal-Token` required on `/internal/*` and `/v1/*`, and startup fails without `INTERNAL_TOKEN` (2026-11-10) |
| `INTERNAL_TOKEN` | empty | The shared secret. Ignored with `ENV=TEST` |
| `DEV_VIEWER_ENABLED` | `true` with `ENV=TEST`, else `false` | Serve the dev map pages `/dev/route-viewer` and `/dev/live-map` (2026-11-09; default from `ENV` since 2026-11-10; live map 2026-11-13) |
| `LOGISTICS_BASE_URL` | empty | ondc-logistics-api. Empty = `POST /v1/track` answers 503 and there's no stage fallback |
| `LOGISTICS_TIMEOUT_MS` | 5000 | Per call to the logistics API (`/logistics/track`, `.../status`) |
| `ENRICH_DEADLINE_MS` | 1200 | Max time the stage lookup + enrich may hold back a `track_update` (> `OSRM_TIMEOUT_MS`, so a normal OSRM failure still fits) |
| `CRUMB_MIN_MOVE_M` | 10 | Logistics path: a rider position closer than this (haversine m) to our last breadcrumb isn't added (standing still, or the same `/on_track` again). Reversible default (2026-11-12) |
| `CRUMBS_MAX_POINTS` | 120 | Logistics path: newest N breadcrumbs kept per order. Keep >= `MATCH_MAX_POINTS` + `MATCH_OVERLAP_POINTS` so a backlog isn't trimmed before it's matched |
| `SSE_KEEPALIVE_MS` | 25000 | Keep-alive comment interval on frontend streams |
| `KEEPALIVE_URL` | `RENDER_EXTERNAL_URL` + `/health` on Render, else off | Self-ping target so a free host doesn't sleep the service (2026-11-10). `none` = off. Must be the public URL |
| `KEEPALIVE_INTERVAL_MS` | 600000 | Ping interval (under Render's ~15 min idle limit) |

## Algorithm notes

**Coverage guard (2026-11-06).** In `enrich()`, `route_ahead` is only computed when the rider and
the destination are both inside `COVERAGE_BBOX`. Trail points outside it are dropped before
`/match`. `/v1/route` answers 422 for out-of-box points. Neither calls OSRM.

**Route ahead.** Reuse the cached route when `stage` and `to` match and
`haversine(cached.from, rider) <= REROUTE_THRESHOLD_M`. `distance_m` / `duration_s` therefore
go stale by up to 30 m of movement; acceptable while they're display-only. On OSRM failure the
field is omitted; the cached route is not resent.

**Road path.** Sort `path` by `sequence`. Tail = points with `sequence > last_seq`. Window =
last `MATCH_OVERLAP_POINTS` already-matched points + tail, with decreasing timestamps dropped
(untimed points are kept),
capped at `MATCH_MAX_POINTS` (oldest first, so a backlog catches up over several updates). All
matchings must reach `MATCH_MIN_CONFIDENCE`. Their geometries are decoded, joined onto the
cached polyline (`joinPaths` drops a duplicate join point), re-encoded, and `last_seq` advances to
the window's last sequence. If there's nothing new (a duplicate update), the cached polyline is
resent with no OSRM call. The overlap stretch is drawn twice, on the same road.

**Untimed points (2026-11-09).** OSRM `/match` takes a timestamp for every coordinate or none. The
client sends `timestamps` only when every point in the window has one; otherwise it leaves the
parameter out and OSRM matches on geometry alone (logistics breadcrumbs never carry time).
`sequence` is then the only ordering. Confidence on untimed traces is still to be measured on
real OSRM (ROUTE-03).

**Live tracking (2026-11-10).** `POST /v1/track` forwards `{orderId}` to the logistics API and passes
its answer through. The logistics API forwards each processed `/on_track` to the webhook, which
answers 202 first. A forward with no `gps` (URL-based tracking, ONDC config `deferred`) is counted
in `track.webhooks_no_gps` and, if it has a `url`, goes through `handleOnTrack()` like any other:
`track_update` without `gps`, no breadcrumb, no OSRM call (`toEnrichInput()` returns null), snapshot
saved (2026-11-12; replaces the 2026-11-11 "nothing pushed" rule). With neither `gps` nor `url`
nothing is pushed. A `gps` that is present but unparsable is still a 400. `handleOnTrack()`:
1. Builds the GPS-only update: `gps`, `gps_timestamp`, `status`, `tracking_url`, `drop_gps`,
   `store_gps`, `stage` from the payload. None of these wait on routing.
2. Races "routing" against `ENRICH_DEADLINE_MS`. Routing = stage from the payload, else
   `GET /logistics/orders/:id/status`, else `Unknown` (no route ahead); then the usual `enrich()`.
   If routing loses, the update goes out without `route_ahead` / `road_path`, and enrich keeps going
   in the background (its cache writes help the next update).
   On this path the trail input is **our own breadcrumbs**, not the LSP's `path[]` (next note).
3. Publishes `track_update` to the order's open streams, then saves the snapshot, or on a final
   stage sends `track_closed`, ends the streams and deletes the snapshot.

**Our own breadcrumbs (2026-11-12, ROUTE-11).** The LSP's `path[]` can't drive the trail: the
workbench sends one point numbered `"1"` on every `/on_track`, the ONDC spec doesn't say whether
sequence 1 is the oldest or newest point (its example has `gps` = sequence 1), and LSPs may
renumber or send none. So after the stage is known (skipped on a final stage), `handleOnTrack()`
appends the update's `gps` to `route:crumbs:{order_id}` with time = `locationTimestamp` (else the
receive time) and our own `seq` 1, 2, 3, ... Skipped (counted in `/metrics` `track.crumbs_skipped_*`):
older than the last crumb, or within `CRUMB_MIN_MOVE_M` of it. Same time but moved: stored at
last `t` + 1 s so `/match` timestamps never decrease. The crumbs go to the unchanged
`computeRoadPath()`, whose `last_seq` now counts our `seq`, and `/match` gets real `timestamps`.
Effects: the first update of an order has no `road_path` (one point); points the LSP recorded
between our updates are not used. `POST /internal/v1/track/enrich` (ondc-api) still uses the
caller's `path`.

A new stream gets the snapshot first. `index.ts` calls `hub.closeAll()` on shutdown, because open
SSE responses would otherwise keep `server.close()` waiting forever.

## Gotchas

- Coordinate order: see the cheat sheet in the skill's `references/contract.md`. A swap still
  returns `Ok`.
- OSRM answers `NoRoute`/`NoMatch` with HTTP 400 plus a JSON body. The client parses the body
  regardless of status and counts those as `no_result`, not `error`.
- `slice(-0)` returns the whole array, which is why `MATCH_OVERLAP_POINTS=0` is special-cased.
- OSRM snaps every point to the nearest road **however far away**: a Mumbai point came back `Ok`,
  snapped 1,078 km to the NCR edge. Hence the coverage box and `MAX_SNAP_DISTANCE_M`. See
  `docs/CHANGELOG.md` 2026-11-06 ROUTE-09.
- OSRM can report `/match` confidence above 1 (seen 1.19, 4.11). The client clamps to 1 before
  comparing with `MATCH_MIN_CONFIDENCE`. See 2026-11-06 ROUTE-10.
- Metrics for a `/route` rejected as `SnapTooFar` count as `no_result`, not `ok`.
- Logistics path: never use the LSP's `path[].sequence` as `last_seq`. It repeats (workbench always
  `"1"`), so the trail froze. See `docs/CHANGELOG.md` 2026-11-12 ROUTE-11. After deploying that
  change, a `route:trail:*` built from LSP numbering self-heals once our `seq` passes it (or flush).

- On Windows, use `127.0.0.1`, not `localhost`, for **both OSRM and Redis**: Node resolves
  `localhost` to IPv6 `::1`, which Docker in WSL doesn't listen on (`ECONNREFUSED ::1:6379`). The
  `REDIS_URL` default is `redis://127.0.0.1:6379` for this reason (2026-11-06).
