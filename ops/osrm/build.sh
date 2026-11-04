#!/usr/bin/env bash
# Build an OSRM MLD dataset into a NEW dated folder (never in place under a running osrm-routed).
# Usage: ops/osrm/build.sh [extract_url] [data_dir]
# Default extract: Geofabrik India northern zone (Delhi NCR, Haryana). Day-one zones are still an
# open question; see docs/ARCHITECTURE_REVIEW.md (ROUTE-01).
# The build needs far more RAM than serving; run it on a bigger machine or as a one-off job.
set -euo pipefail

URL="${1:-https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf}"
DATA_DIR="${2:-$(dirname "$0")/../data}"
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"
IMAGE="ghcr.io/project-osrm/osrm-backend:v5.27.1"
STAMP="$(date +%Y-%m-%d)"
OUT="$DATA_DIR/$STAMP"

mkdir -p "$OUT"
echo "==> Downloading $URL into $OUT"
curl -fL --retry 3 -o "$OUT/region-latest.osm.pbf" "$URL"

run() { docker run --rm -t -v "$OUT:/data" "$IMAGE" "$@"; }
echo "==> osrm-extract (car.lua)"
run osrm-extract -p /opt/car.lua /data/region-latest.osm.pbf
echo "==> osrm-partition"
run osrm-partition /data/region-latest.osrm
echo "==> osrm-customize"
run osrm-customize /data/region-latest.osrm

echo
echo "Built $OUT. Next (docs/deployment/osrm.md, 'Weekly refresh'):"
echo "  1. start a new osrm-routed on $OUT and run the smoke test against it"
echo "  2. switch the service alias / OSRM_BASE_URL to it, stop the old container"
echo "  3. keep the previous dated folder until the next refresh (rollback)"
echo "For local dev: ln -sfn $STAMP $DATA_DIR/current"
