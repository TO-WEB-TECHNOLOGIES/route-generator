# Running OSRM

One OSRM container on a private network, reachable only from the BFF, built from an OpenStreetMap extract of the regions we deliver in.

## Map data

Day-one coverage (decided 2026-11-04): **Delhi, Gurugram, Noida, Ghaziabad.** Delhi NCR spans three states: Delhi, Haryana (Gurugram) and Uttar Pradesh (Noida, Ghaziabad). Since 2026-11-05 the source is the openstreetmap.fr per-state extracts (`download.openstreetmap.fr/extracts/asia/india/{national_capital_territory_of_delhi,haryana,uttar_pradesh}-latest.osm.pbf`, ~279 MB total). The Geofabrik fallback is two zones (~549 MB): `northern-zone` (Delhi, Haryana) + `central-zone` (UP); the northern zone alone does **not** cover Noida/Ghaziabad. A prep container (`ops/osrm/prep.Dockerfile`, Debian 12 + osmium; the OSRM image itself is Debian 11, end of life, so nothing can be apt-installed into it) downloads the files, clips each to the box `76.75,28.20,77.80,28.95` with `osmium extract`, and merges them. That builds much faster, and with far less memory, than a whole zone or all of India. **Bengaluru added 2026-11-10:** `OSRM_BBOX` is now a `;`-separated list of boxes, one per region (`76.75,28.20,77.80,28.95;77.35,12.75,77.90,13.25`). Every input file is clipped to every box in one `osmium extract -c` pass and the pieces are merged, so the map holds two separate road networks (NCR to Bengaluru = `NoRoute`). Karnataka's openstreetmap.fr extract is in `OSRM_PBF_URLS`. Adding a city = append its box to `OSRM_BBOX` **and** the service's `COVERAGE_BBOX` (a unit test checks they match), add its extract, rebuild. Map files downloaded by hand go in `ops/maps/` and are used instead of downloading (see `ops/maps/README.md`). Details: `docs/deployment/osrm.md`.

## Profile

Start with `car.lua`. It obeys one-way streets, so a two-wheeler that cuts a short wrong-way stretch gets a longer route. A custom two-wheeler profile is an open question; don't introduce one without agreement.

## Build and serve (MLD pipeline)

Official image: `ghcr.io/project-osrm/osrm-backend`.

```
osrm-extract -p /opt/car.lua /data/region-latest.osm.pbf
osrm-partition /data/region-latest.osrm
osrm-customize /data/region-latest.osrm
osrm-routed --algorithm mld /data/region-latest.osrm   # listens on :5000
```

The `--algorithm mld` flag must match the partition/customize pipeline; `osrm-routed` defaults to CH and won't serve MLD-only data without it.

## Network

Port 5000 on the private network only. No public access, no auth.

## Weekly refresh (no downtime)

1. Download a fresh extract into a new dated folder.
2. Run the three build steps there.
3. Start a new container on the new folder, run `scripts/smoke_test.sh` against it.
4. Switch the BFF's OSRM address (or the service alias) to the new container, then stop the old one.
5. Keep the previous folder until the next refresh, for rollback.

Never rebuild in place under a running `osrm-routed`.

## Sizing (approximate, confirm with a test build)

The build step needs far more memory than serving. Build on a larger machine or as a one-off job; serve a regional extract from a few GB of RAM. One instance handles hundreds of requests per second, far above our load.

## Monitoring

Log OSRM latency and error/timeout counts from the BFF. Alert on sustained errors: the app silently falls back to straight lines, so nobody will report a dead container otherwise.
