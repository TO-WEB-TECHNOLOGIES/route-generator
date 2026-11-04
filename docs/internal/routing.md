# Routing — Internal Notes

_Created 2026-11-04 (initial boilerplate)._ Design spec: `.claude/skills/bff-road-routing/SKILL.md`.

## Module map

| File | Role |
|---|---|
| `src/index.ts` | Wires config, Redis, OSRM client, HTTP server; graceful shutdown |
| `src/app.ts` | Express app: `/health`, `/metrics`, `/internal/v1/track/enrich`, token guard |
| `src/routes/enrich.routes.ts` | Input validation (`parseEnrichBody`) -> `enrich()` |
| `src/routing/enrich.ts` | Orchestrator. Runs route-ahead and road-path in parallel (`Promise.allSettled`). Never throws |
| `src/routing/stage.ts` | Stage -> destination, terminal stages |
| `src/routing/route-ahead.ts` | Cached route + 30 m / stage-change re-route check |
| `src/routing/road-path.ts` | Incremental `/match` of the trail tail, appended to the cached polyline |
| `src/routing/cache.ts` | Redis keys, TTL constants, `RouteCache` interface (Redis errors = miss) |
| `src/osrm/client.ts` | `/route` and `/match` over `fetch` with `AbortSignal.timeout`. Returns typed results, never throws |
| `src/geo/point.ts` | `"lat,lng"` parsing, `toOsrmCoord` (lng first), haversine |
| `src/geo/polyline.ts` | Encode/decode precision 5, `joinPaths` |
| `src/metrics.ts` | OSRM call outcomes + latency, served on `/metrics` |
| `src/config.ts` | All tunables |

Dependencies are injected (`EnrichDeps`), so `test/` runs with in-memory fakes and needs no
Redis or OSRM. `test/osrm-failure.test.ts` drives the real HTTP client against stub servers.

## Redis keys

All keys carry `REDIS_KEY_PREFIX` (ioredis `keyPrefix`). The cache is derived and disposable.

| Key | Value | TTL constant | Deleted by |
|---|---|---|---|
| `route:ahead:{order_id}` | `{ polyline, distance_m, duration_s, to, from: {lat,lng}, stage }` | `ROUTE_AHEAD_TTL_S` = 7200 | `cache.clear()` on terminal stage, else TTL |
| `route:trail:{order_id}` | `{ polyline, last_seq }` | `ROUTE_TRAIL_TTL_S` = 7200 | `cache.clear()` on terminal stage, else TTL |

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
| `INTERNAL_TOKEN` | empty | If set, `/internal/*` requires `X-Internal-Token` |

## Algorithm notes

**Route ahead.** Reuse the cached route when `stage` and `to` match and
`haversine(cached.from, rider) <= REROUTE_THRESHOLD_M`. `distance_m` / `duration_s` therefore
go stale by up to 30 m of movement; acceptable while they're display-only. On OSRM failure the
field is omitted; the cached route is not resent.

**Road path.** Sort `path` by `sequence`. Tail = points with `sequence > last_seq`. Window =
last `MATCH_OVERLAP_POINTS` already-matched points + tail, with decreasing timestamps dropped,
capped at `MATCH_MAX_POINTS` (oldest first, so a backlog catches up over several updates). All
matchings must reach `MATCH_MIN_CONFIDENCE`. Their geometries are decoded, joined onto the
cached polyline (`joinPaths` drops a duplicate join point), re-encoded, and `last_seq` advances to
the window's last sequence. If there's nothing new (a duplicate update), the cached polyline is
resent with no OSRM call. The overlap stretch is drawn twice, on the same road.

## Gotchas

- Coordinate order: see the cheat sheet in the skill's `references/contract.md`. A swap still
  returns `Ok`.
- OSRM answers `NoRoute`/`NoMatch` with HTTP 400 plus a JSON body. The client parses the body
  regardless of status and counts those as `no_result`, not `error`.
- `slice(-0)` returns the whole array, which is why `MATCH_OVERLAP_POINTS=0` is special-cased.
