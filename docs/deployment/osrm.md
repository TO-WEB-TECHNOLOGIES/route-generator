# Deploying OSRM and osrm-bff

_Created 2026-11-04 (initial boilerplate)._ Ops spec: `.claude/skills/bff-road-routing/references/osrm-ops.md`.

## Topology

```
[ ondc-api (BFF) ] --HTTP 4100--> [ osrm-bff ] --HTTP 5000--> [ osrm-routed ]
                                        |
                                        +--> [ Redis ]
```

All on the private network (same VPC as the BFF; final placement is still open: ROUTE-02).
Neither port is public. OSRM has no auth, so the network is its only protection.

## Coverage: Delhi NCR (decided 2026-11-04)

Day-one cities: **Delhi, Gurugram, Noida, Ghaziabad.** They span two Geofabrik zones (checked
against the zones' `.poly` boundaries on 2026-11-04):

| File | From | Size | Covers |
|---|---|---|---|
| `northern-zone-latest.osm.pbf` | <https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf> | ~214 MB | Delhi, Gurugram (Haryana) |
| `central-zone-latest.osm.pbf` | <https://download.geofabrik.de/asia/india/central-zone-latest.osm.pbf> | ~335 MB | Noida, Greater Noida, Ghaziabad (Uttar Pradesh) |

The image downloads both, clips each to the box `76.75,28.20,77.80,28.95` (minlon,minlat,maxlon,maxlat)
with `osmium extract --strategy smart`, and merges them into `ncr.osm.pbf`. The clipped dataset
is small, so the build needs a few GB of RAM rather than the tens a full-India build needs. Outside the box OSRM
returns `NoSegment`/`NoRoute`, and the service just omits the routing fields.

To add a city later: widen `OSRM_BBOX` (and add its zone to `OSRM_PBF_URLS` if needed), then
rebuild (`OSRM_FORCE_REBUILD=1`, or a fresh dated folder via `build.sh`).

## Image: `ops/osrm/Dockerfile`

Based on `ghcr.io/project-osrm/osrm-backend:v5.27.1`, plus `curl` and `osmium-tool`.
`ops/osrm/entrypoint.sh`:

- `serve` (default): if `/data` has no built dataset, download → clip → merge →
  `osrm-extract -p /opt/car.lua` → `osrm-partition` → `osrm-customize`; then
  `osrm-routed --algorithm mld --max-matching-size 100` on :5000.
- `build`: same build steps, then exit (used by `build.sh`).

| Env | Default |
|---|---|
| `OSRM_PBF_URLS` | the two zone URLs above (space-separated) |
| `OSRM_BBOX` | `76.75,28.20,77.80,28.95` (empty = no clipping) |
| `OSRM_DATASET` | `ncr` (files are `/data/ncr.osrm*`) |
| `OSRM_PROFILE_LUA` | `/opt/car.lua` |
| `OSRM_MAX_MATCHING_SIZE` | `100` (must be >= `MATCH_MAX_POINTS`) |
| `OSRM_FORCE_REBUILD` | unset (`1` = rebuild over existing data, before serving) |
| `OSRM_KEEP_SOURCES` | unset (`1` = keep the downloaded zone files in `/data/src`) |
| `OSRM_HEALTH_COORD` | `77.0266,28.4595` (lng,lat for the `/nearest` healthcheck) |

`--algorithm mld` must match the partition/customize pipeline (the default, CH, won't serve this data).

## Local dev

```bash
docker compose -f ops/docker-compose.yml up -d            # OSRM + Redis
docker compose -f ops/docker-compose.yml logs -f osrm     # first start: download + build, several minutes
npm run smoke -- http://localhost:5000                    # once "starting osrm-routed" appears
```

Run the service with `npm run dev` (`.env`: `OSRM_BASE_URL=http://localhost:5000`), or add
`--profile app --build` to run it in Docker too. Rebuild from scratch:
`docker compose -f ops/docker-compose.yml down -v` (drops the `osrm-data` volume).

Windows / Docker Desktop: if the build dies with exit code 137, raise the WSL2 memory limit
(`%UserProfile%\.wslconfig`, `[wsl2] memory=6GB`) and restart Docker Desktop.

## Verify

From the BFF host:

```bash
bash .claude/skills/bff-road-routing/scripts/smoke_test.sh http://osrm:5000
curl -s http://osrm-bff:4100/health
curl -s http://osrm-bff:4100/metrics
```

## Weekly refresh (no downtime)

1. `bash ops/osrm/build.sh` builds a new dated folder `ops/data/<YYYY-MM-DD>/` (same image, same coverage).
2. Start a new container on it (the script prints the command, on port 5001) and smoke-test it.
3. Switch the service alias (or `OSRM_BASE_URL`) to the new container, then stop the old one.
4. Keep the previous folder until the next refresh, for rollback.

Never rebuild in place under a running `osrm-routed`. Owner of this job: **open** (ROUTE-02).

## Alerts

Scrape `GET /metrics`. Alert when `osrm.*.outcomes.timeout + error` is a sustained share of
calls. Users won't report it: the app silently falls back to straight lines.

## Service env

See `.env.example`. Required in each environment: `OSRM_BASE_URL`, `REDIS_URL`,
`REDIS_KEY_PREFIX` (per-env, e.g. `osrm-bff:prod:`), `INTERNAL_TOKEN`.
