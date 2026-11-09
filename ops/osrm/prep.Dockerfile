# Map-prep image: downloads the OpenStreetMap state extracts and clips/merges them to the NCR box.
# Separate from the OSRM image because that one is based on Debian 11 (bullseye), which is end of
# life: its security repository returns 404, so apt-get can't install anything there anymore.
# Debian 12 (bookworm) is supported and ships curl + osmium-tool.
FROM debian:12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates osmium-tool \
 && rm -rf /var/lib/apt/lists/*

COPY prep.sh /usr/local/bin/osrm-prep
# Strip CRLF in case the script was checked out on Windows with autocrlf.
RUN sed -i 's/\r$//' /usr/local/bin/osrm-prep && chmod +x /usr/local/bin/osrm-prep

# Coverage: Delhi, Gurugram, Noida, Ghaziabad.
# - Per-state extracts from openstreetmap.fr (switched from Geofabrik's zones on 2026-11-05: ~279 MB
#   instead of ~549 MB): Delhi (~27 MB), Haryana for Gurugram (~52 MB), Uttar Pradesh for Noida +
#   Ghaziabad (~200 MB). Geofabrik zone equivalents: northern-zone + central-zone.
# - OSRM_BBOX is minlon,minlat,maxlon,maxlat: the four cities plus a small buffer for edge roads.
#   The service's COVERAGE_BBOX (src/config.ts, .env.example) must match it: widen both together.
ENV OSRM_PBF_URLS="https://download.openstreetmap.fr/extracts/asia/india/national_capital_territory_of_delhi-latest.osm.pbf https://download.openstreetmap.fr/extracts/asia/india/haryana-latest.osm.pbf https://download.openstreetmap.fr/extracts/asia/india/uttar_pradesh-latest.osm.pbf" \
    OSRM_BBOX="76.75,28.20,77.80,28.95" \
    OSRM_DATASET="ncr"

VOLUME ["/data"]
ENTRYPOINT ["osrm-prep"]
