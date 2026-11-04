# Running OSRM

One OSRM container on a private network, reachable only from the BFF, built from an OpenStreetMap extract of the regions we deliver in.

## Map data

Download an India extract from Geofabrik. A regional zone covering our cities (for example the northern zone for Delhi NCR and Haryana) builds faster and needs less memory than all of India. Which zones are needed on day one is still an open question.

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
