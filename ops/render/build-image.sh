#!/usr/bin/env bash
# Build the Render image (ops/render/Dockerfile): osrm-bff + OSRM + the NCR graph you ALREADY built
# with `docker compose -f ops/docker-compose.yml up`. Nothing is rebuilt: the graph files are copied
# out of the compose volume and baked into the image. Run in WSL (where Docker is), from anywhere.
#
#   bash ops/render/build-image.sh ghcr.io/<you>/osrm-bff-render:2026-11-10
#   PUSH=1 bash ops/render/build-image.sh ghcr.io/<you>/osrm-bff-render:2026-11-10   # also push
#
# Log in first for PUSH=1: echo <token> | docker login ghcr.io -u <you> --password-stdin
# The image holds whatever map the volume holds. For an NCR-only image, the volume must have been
# built from NCR files only (ops/maps/ without a Bengaluru file).
set -euo pipefail

cd "$(dirname "$0")/../.."
IMAGE="${1:-osrm-bff-render:$(date -u +%Y-%m-%d)}"
VOLUME="${OSRM_VOLUME:-osrm-bff_osrm-data}"
DATASET="${OSRM_DATASET:-ncr}"
STAGE=ops/render/map

log() { echo "[build-image] $*"; }

rm -rf "$STAGE"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

log "copying the built $DATASET graph from volume $VOLUME"
docker run --rm -v "$VOLUME":/data:ro -v "$PWD/$STAGE":/out alpine sh -c "
  if [ ! -f /data/.$DATASET.built ]; then
    echo 'no built map in the volume: run docker compose -f ops/docker-compose.yml up first'; exit 1
  fi
  echo \"map built \$(cat /data/.$DATASET.built)\"
  cp /data/$DATASET.osrm.* /out/"
log "graph: $(du -sh "$STAGE" | cut -f1)"

log "building $IMAGE (linux/amd64)"
docker build --platform linux/amd64 -f ops/render/Dockerfile -t "$IMAGE" .
log "built $IMAGE ($(docker image inspect "$IMAGE" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1024/1024}'))"

if [ "${PUSH:-0}" = "1" ]; then
  log "pushing $IMAGE"
  docker push "$IMAGE"
fi
