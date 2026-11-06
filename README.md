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

OSRM + Redis in Docker (coverage: Delhi, Gurugram, Noida, Ghaziabad). The first start downloads
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
| `GET /health` | Liveness (no dependency checks) |
| `GET /metrics` | OSRM call outcomes and latency |

Postman request files: `postman/`.

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
