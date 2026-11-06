# OSRM for Delhi NCR (Delhi, Gurugram, Noida, Ghaziabad): build + serve.
#
# Expects /data/ncr.osm.pbf, produced by the osrm-prep image (prep.Dockerfile). On first start it
# builds the MLD dataset with car.lua; later starts reuse it from the /data volume and just serve.
# docker compose runs both in order: see ops/docker-compose.yml.
#
# No apt-get here on purpose: this base image is Debian 11 (end of life), whose package
# repositories no longer serve updates. Everything below uses only what the image already has.
#
# Never publish port 5000 beyond localhost / the private network: OSRM has no auth.
FROM ghcr.io/project-osrm/osrm-backend:v5.27.1

COPY entrypoint.sh /usr/local/bin/osrm-entrypoint
# Strip CRLF in case the script was checked out on Windows with autocrlf.
RUN sed -i 's/\r$//' /usr/local/bin/osrm-entrypoint && chmod +x /usr/local/bin/osrm-entrypoint

# OSRM_HEALTH_COORD is lng,lat (OSRM order) inside the NCR box: central Gurugram.
ENV OSRM_DATASET="ncr" \
    OSRM_PROFILE_LUA="/opt/car.lua" \
    OSRM_MAX_MATCHING_SIZE="100" \
    OSRM_HEALTH_COORD="77.0266,28.4595"

VOLUME ["/data"]
EXPOSE 5000

# No curl in this image, so the healthcheck speaks HTTP over bash's /dev/tcp.
# Long start period: the first start builds the dataset.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30m --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/5000 && printf 'GET /nearest/v1/driving/%s HTTP/1.0\\r\\n\\r\\n' \"$OSRM_HEALTH_COORD\" >&3 && head -n1 <&3 | grep -q ' 200 '"]

ENTRYPOINT ["osrm-entrypoint"]
CMD ["serve"]
