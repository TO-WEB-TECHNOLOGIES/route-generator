# OSRM for Delhi NCR (Delhi, Gurugram, Noida, Ghaziabad).
#
# On first start the entrypoint downloads the Geofabrik extracts, clips them to the NCR box with
# osmium, builds the MLD dataset with car.lua, and serves it on :5000. The data lives in /data
# (mount a volume), so later starts skip straight to serving.
#
#   docker build -t osrm-bff/osrm-ncr:5.27.1 ops/osrm
#   docker run -d -v osrm-data:/data -p 127.0.0.1:5000:5000 osrm-bff/osrm-ncr:5.27.1
#
# Never publish port 5000 beyond localhost / the private network: OSRM has no auth.
FROM ghcr.io/project-osrm/osrm-backend:v5.27.1

# curl: download extracts + healthcheck. osmium-tool: clip/merge extracts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates osmium-tool \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/osrm-entrypoint
# Strip CRLF in case the script was checked out on Windows with autocrlf.
RUN sed -i 's/\r$//' /usr/local/bin/osrm-entrypoint && chmod +x /usr/local/bin/osrm-entrypoint

# Coverage: Delhi, Gurugram, Noida, Ghaziabad.
# - Delhi + Gurugram are in Geofabrik's northern zone; Noida + Ghaziabad (Uttar Pradesh) are in the
#   central zone (checked against the zones' .poly boundaries on 2026-11-04). Both are downloaded.
# - OSRM_BBOX is minlon,minlat,maxlon,maxlat: the four cities plus a small buffer for edge roads.
# - OSRM_HEALTH_COORD is lng,lat (OSRM order) inside the box: central Gurugram.
ENV OSRM_PBF_URLS="https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf https://download.geofabrik.de/asia/india/central-zone-latest.osm.pbf" \
    OSRM_BBOX="76.75,28.20,77.80,28.95" \
    OSRM_DATASET="ncr" \
    OSRM_PROFILE_LUA="/opt/car.lua" \
    OSRM_MAX_MATCHING_SIZE="100" \
    OSRM_HEALTH_COORD="77.0266,28.4595"

VOLUME ["/data"]
EXPOSE 5000

# Long start period: the very first start downloads ~550 MB and builds the dataset.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45m --retries=3 \
  CMD curl -fsS "http://localhost:5000/nearest/v1/driving/${OSRM_HEALTH_COORD}" > /dev/null || exit 1

ENTRYPOINT ["osrm-entrypoint"]
CMD ["serve"]
