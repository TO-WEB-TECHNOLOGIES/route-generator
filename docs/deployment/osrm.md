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

## Build map data (MLD)

```bash
bash ops/osrm/build.sh                                   # default: Geofabrik India northern zone
bash ops/osrm/build.sh https://download.geofabrik.de/asia/india/southern-zone-latest.osm.pbf
```

This writes `ops/data/<YYYY-MM-DD>/region-latest.osrm*` using `ghcr.io/project-osrm/osrm-backend:v5.27.1`
(`osrm-extract -p /opt/car.lua`, `osrm-partition`, `osrm-customize`). The build needs far more RAM
than serving. Run it on a larger machine or as a one-off job. Confirm sizing with a test build.

## Serve

```bash
osrm-routed --algorithm mld --max-matching-size 100 /data/<date>/region-latest.osrm   # :5000
```

`--algorithm mld` must match the partition/customize pipeline (the default, CH, won't serve this
data). `--max-matching-size` must be >= `MATCH_MAX_POINTS`.

Local dev: `ln -sfn <date> ops/data/current && docker compose -f ops/docker-compose.yml up`.

## Verify

From the BFF host:

```bash
bash .claude/skills/bff-road-routing/scripts/smoke_test.sh http://osrm:5000
curl -s http://osrm-bff:4100/health
curl -s http://osrm-bff:4100/metrics
```

## Weekly refresh (no downtime)

1. `ops/osrm/build.sh` into a new dated folder.
2. Start a new `osrm-routed` on it and run the smoke test against it.
3. Switch the service alias (or `OSRM_BASE_URL`) to the new container, then stop the old one.
4. Keep the previous folder until the next refresh, for rollback.

Never rebuild in place under a running `osrm-routed`. Owner of this job: **open** (ROUTE-02).

## Alerts

Scrape `GET /metrics`. Alert when `osrm.*.outcomes.timeout + error` is a sustained share of
calls. Users won't report it: the app silently falls back to straight lines.

## Service env

See `.env.example`. Required in each environment: `OSRM_BASE_URL`, `REDIS_URL`,
`REDIS_KEY_PREFIX` (per-env, e.g. `osrm-bff:prod:`), `INTERNAL_TOKEN`.
