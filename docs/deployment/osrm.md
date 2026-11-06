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

Day-one cities: **Delhi, Gurugram, Noida, Ghaziabad**, across three states. Source:
**openstreetmap.fr per-state extracts** (switched from Geofabrik on 2026-11-05: half the download):

| File | From | Size | Covers |
|---|---|---|---|
| `national_capital_territory_of_delhi-latest.osm.pbf` | <https://download.openstreetmap.fr/extracts/asia/india/national_capital_territory_of_delhi-latest.osm.pbf> | ~27 MB | Delhi |
| `haryana-latest.osm.pbf` | <https://download.openstreetmap.fr/extracts/asia/india/haryana-latest.osm.pbf> | ~52 MB | Gurugram |
| `uttar_pradesh-latest.osm.pbf` | <https://download.openstreetmap.fr/extracts/asia/india/uttar_pradesh-latest.osm.pbf> | ~200 MB | Noida, Greater Noida, Ghaziabad |

Fallback (Geofabrik, ~549 MB total): `asia/india/northern-zone-latest.osm.pbf` (Delhi, Haryana) +
`asia/india/central-zone-latest.osm.pbf` (Uttar Pradesh), set via `OSRM_PBF_URLS`. Zone
membership was checked against Geofabrik's `.poly` boundaries on 2026-11-04.

The `osrm-prep` image downloads them, clips each to the box `76.75,28.20,77.80,28.95` (minlon,minlat,maxlon,maxlat)
with `osmium extract --strategy smart`, and merges them into `ncr.osm.pbf`. The clipped dataset
is small, so the build needs a few GB of RAM rather than the tens a full-India build needs. Outside the box OSRM
returns `NoSegment`/`NoRoute`, and the service just omits the routing fields.

To add a city later: widen `OSRM_BBOX` (and add its zone to `OSRM_PBF_URLS` if needed), then
rebuild (`OSRM_FORCE_REBUILD=1` on `osrm-prep`, or a fresh dated folder via `build.sh`).

## Images: two steps, two containers (changed 2026-11-05)

The official OSRM image is based on **Debian 11 (bullseye), which is end of life**. Its security
repository now returns 404, so `apt-get install` fails inside it. We therefore never install
anything into it, and do the map prep in a separate, supported image.

| Step | Image (file) | Base | Does |
|---|---|---|---|
| 1 | `osrm-bff/osrm-prep:1` (`ops/osrm/prep.Dockerfile`, `prep.sh`) | `debian:12-slim` + `curl`, `osmium-tool` | inputs (files in `ops/maps/`, else download) → clip to `OSRM_BBOX` → merge → `/data/ncr.osm.pbf`. Runs once and exits; skips while inputs are unchanged |
| 2 | `osrm-bff/osrm-ncr:5.27.1` (`ops/osrm/Dockerfile`, `entrypoint.sh`) | `ghcr.io/project-osrm/osrm-backend:v5.27.1`, unchanged | if not built: `osrm-extract -p /opt/car.lua` → `osrm-partition` → `osrm-customize`; then `osrm-routed --algorithm mld --max-matching-size 100` on :5000. `build` mode = build and exit (for `build.sh`) |

Compose starts step 2 only after step 1 exits successfully (`service_completed_successfully`).
Both share the `osrm-data` volume. Markers in `/data`: `.ncr.prepped` (step 1 done; its first
line is a **fingerprint** of the inputs: file names + sizes, or the URL list, plus the box),
`.ncr.built` (step 2 done). When the fingerprint changes, prep runs again and deletes
`.ncr.built`, so the graph is rebuilt automatically.

### Manual maps: `ops/maps/` (added 2026-11-06)

Put browser-downloaded `.osm.pbf` files in `ops/maps/` (git-ignored except its README). Compose
mounts it read-only at `/maps` in `osrm-prep`. If any `*.pbf` is there, prep uses those files and
**downloads nothing**; otherwise it falls back to `OSRM_PBF_URLS`. Each file is fully read with
`osmium fileinfo -e` first, so a truncated download is rejected with a clear message. Browser
partials (`.crdownload`, `.part`) are ignored. Every `.pbf` in the folder is merged, so use one
set of files (see `ops/maps/README.md`). Files in `ops/maps/` are never modified or deleted.

The OSRM healthcheck uses bash's `/dev/tcp` (there's no `curl` in that image) to call
`/nearest` on `OSRM_HEALTH_COORD`.

| Env | Used by | Default |
|---|---|---|
| `OSRM_LOCAL_MAPS_DIR` | prep | `/maps` (where `ops/maps/` is mounted; any `*.pbf` there wins over the URLs) |
| `OSRM_PBF_URLS` | prep | the three state URLs above (space-separated); used only when `ops/maps/` has no `.pbf` |
| `OSRM_BBOX` | prep | `76.75,28.20,77.80,28.95` (empty = no clipping) |
| `OSRM_DATASET` | both | `ncr` (files are `/data/ncr.osm.pbf`, `/data/ncr.osrm*`) |
| `OSRM_FORCE_REBUILD` | both | unset. Rarely needed now that input changes are detected. On prep, `1` re-prepares regardless (which forces a graph rebuild); on osrm, `1` rebuilds the graph from the existing `.osm.pbf` |
| `OSRM_KEEP_SOURCES` | prep | unset (`1` = keep the downloaded zone files in `/data/src`) |
| `OSRM_PROFILE_LUA` | osrm | `/opt/car.lua` |
| `OSRM_MAX_MATCHING_SIZE` | osrm | `100` (must be >= `MATCH_MAX_POINTS`) |
| `OSRM_HEALTH_COORD` | osrm | `77.0266,28.4595` (lng,lat for the `/nearest` healthcheck) |

`--algorithm mld` must match the partition/customize pipeline (the default, CH, won't serve this data).

## Local dev

```bash
docker compose -f ops/docker-compose.yml up               # prep (first time), then OSRM + Redis; Ctrl+C stops
npm run smoke -- http://127.0.0.1:5000                    # once "starting osrm-routed" appears
```

Measured 2026-11-06 (NCR, car.lua): `/data` volume **657 MB** (`ncr.osm.pbf` 55 MB + graph),
images 141 MB (prep) + 214 MB (osrm) + 58 MB (redis), OSRM RAM **~430 MB** serving.

Run the service with `npm run dev` (`.env`: `OSRM_BASE_URL=http://127.0.0.1:5000`; on Windows,
`localhost` resolves to IPv6 `::1`, which Docker in WSL doesn't listen on), or add
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

1. `bash ops/osrm/build.sh` builds a new dated folder `ops/data/<YYYY-MM-DD>/` (same two images, same coverage).
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
