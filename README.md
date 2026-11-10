# osrm-bff

Road routing for order tracking. The BFF (`ondc-api`) sends each rider GPS update here. This
service asks a **self-hosted OSRM** for the route ahead and the road-snapped trail, and returns the
optional `on_track` fields `route_ahead`, `road_path`, `drop_gps`. Phones never call a routing server.

Routing is decoration: if OSRM or Redis is down, the endpoint still answers `200` within about
one OSRM timeout, with those fields left out.

## Quick start

```bash
npm install
cp .env.example .env        # point OSRM_BASE_URL / REDIS_URL at your instances
npm run dev                 # http://localhost:4100
npm test                    # no Redis/OSRM needed
npm run typecheck
```

OSRM + Redis in Docker (coverage: Delhi NCR (Delhi, Gurugram, Noida, Ghaziabad) and Bengaluru). The first start downloads
and builds the map, which takes several minutes:

```bash
npm run osrm        # starts OSRM + Redis and shows logs; ready at "starting osrm-routed" (Ctrl+C stops)
npm run osrm:bg     # same, in the background
npm run osrm:stop   # stop both (map data is kept)
npm run smoke -- http://127.0.0.1:5000   # 127.0.0.1, not localhost: on Windows localhost resolves to IPv6
```

## Endpoints

| Route | Purpose |
|---|---|
| `POST /internal/v1/track/enrich` | Routing fields for one GPS update: `docs/integration-docs/track-enrich.md` |
| `GET /v1/route` | Road route between two points: `docs/integration-docs/route.md` |
| `POST /v1/track`, `GET /v1/orders/:orderId/track[/events]` | Live tracking for the frontend: forward to logistics, SSE push with routes. `docs/integration-docs/track.md` |
| `POST /internal/v1/logistics/on_track` | ondc-logistics-api forwards each `/on_track` here: `LOGISTICS_API_CHANGES.md` |
| `GET /`, `GET /health` | Liveness (no dependency checks) |
| `GET /metrics` | OSRM call outcomes and latency |
| `GET /dev/route-viewer` | **Dev only** (`DEV_VIEWER_ENABLED`, off in production): map page that draws `/v1/route` and enrich responses the way the app should. Open `http://127.0.0.1:4100/dev/route-viewer` |

How the app should draw these responses: `understanding/06-drawing-the-map-on-the-app.md`.

### API tests (Postman)

`postman/collections/osrm-bff/` is a Postman v3 collection (one YAML file per request) with
37 requests and ~115 assertions:

| Folder | What it checks |
|---|---|
| `01 health` | `/`, `/health`, `/metrics`, plus a warm-up route (a freshly started OSRM can be slow on its first requests) |
| `02 route` | `/v1/route` in each NCR city, Bengaluru, and across states; NCR to Bengaluru = 404 (the decoded line starts and ends at the right points), then 400 / 401 / 422 cases |
| `03 enrich: order lifecycle` | One order through every stage: route to store, route to drop + trail, duplicate update, 11 m move (cached), new points (trail grows), at delivery, delivered (cache cleared) |
| `04 enrich: edge cases` | Order outside NCR, stages without a destination, logistics-shaped breadcrumbs (no timestamps), RTO back to the store, malformed bodies, missing token |
| `05 track: logistics webhook` | Forwarded `/on_track` -> snapshot with routes -> delivered drops it; 400s (SSE itself: dev viewer Live order tab) |

Run it with the service up (`npm run dev`) and OSRM running:

```powershell
npm run test:api
# or, with your token:
postman collection run postman/collections/osrm-bff -e postman/environments/osrm-bff-local.environment.yaml --env-var "internalToken=<INTERNAL_TOKEN from .env>"
```

In the Postman app, open the `postman/` folder (or import the collection) and select the
**osrm-bff local** environment (it works without one too: the collection has the same defaults).
`baseUrl` is the service, `http://127.0.0.1:4100`, never OSRM's port 5000. OSRM answers our
paths with `{"code":"InvalidUrl"}`, and the collection now stops early with a clear message if
`baseUrl` points at 5000. Use `127.0.0.1`, not `localhost`.

A cloud copy lives in **USTART's workspace** (collection `osrm-bff`, environment `osrm-bff local`),
created 2026-11-07 from these files via the Postman API. It is **not linked** to the repo: the
files here are the source of truth, and changes must be re-uploaded (or linked via
`postman workspace connect-git` once the repo has a git remote).

Single-request files per route (repo convention): `postman/*.json`.

## Layout

```
src/
  geo/        point parsing (lat,lng <-> OSRM lng,lat), haversine, polyline (precision 5)
  osrm/       /route + /match client: timeouts, metrics, never throws
  routing/    stage table, route-ahead, incremental road-path, Redis cache, enrich orchestrator
  routes/     HTTP validation
test/         node:test suites (fakes + stub OSRM servers)
ops/          docker-compose, OSRM build script
docs/         integration-docs/, internal/, deployment/, ARCHITECTURE_REVIEW.md, CHANGELOG.md
.claude/skills/bff-road-routing/   design spec (read first)
```

Working rules for Claude/agents: `CLAUDE.md` and `CLAUDE.local.md`.
