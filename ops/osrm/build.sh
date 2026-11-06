#!/usr/bin/env bash
# Build a fresh OSRM dataset into a NEW dated folder for the weekly refresh (never in place under
# a running osrm-routed). Uses the same two images and steps as docker compose, so the coverage
# (OSRM_PBF_URLS / OSRM_BBOX, defaults in ops/osrm/prep.Dockerfile: Delhi NCR) is identical.
#
# Usage: ops/osrm/build.sh [data_dir]       (default: ops/data)
# Then: start a container on the new folder, smoke-test it, switch traffic (docs/deployment/osrm.md).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PREP_IMAGE="osrm-bff/osrm-prep:1"
OSRM_IMAGE="osrm-bff/osrm-ncr:5.27.1"
DATA_DIR="${1:-$HERE/../data}"
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"
OUT="$DATA_DIR/$(date +%Y-%m-%d)"
mkdir -p "$OUT"

docker build -t "$PREP_IMAGE" -f "$HERE/prep.Dockerfile" "$HERE"
docker build -t "$OSRM_IMAGE" "$HERE"

ENV_ARGS=()
for v in OSRM_PBF_URLS OSRM_BBOX OSRM_DATASET OSRM_PROFILE_LUA; do
  if [ -n "${!v:-}" ]; then ENV_ARGS+=(-e "$v=${!v}"); fi
done

# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the /data mount path.
export MSYS_NO_PATHCONV=1
# Step 1: download (or use files in ops/maps/) + clip + merge
docker run --rm "${ENV_ARGS[@]}" -v "$OUT:/data" -v "$HERE/../maps:/maps:ro" "$PREP_IMAGE"
docker run --rm "${ENV_ARGS[@]}" -v "$OUT:/data" "$OSRM_IMAGE" build  # step 2: extract/partition/customize

echo
echo "Built $OUT. Serve it with:"
echo "  docker run -d --name osrm-$(date +%Y%m%d) -v \"$OUT:/data\" -p 127.0.0.1:5001:5000 $OSRM_IMAGE"
echo "then smoke-test port 5001, switch OSRM_BASE_URL / the service alias, and stop the old container."
