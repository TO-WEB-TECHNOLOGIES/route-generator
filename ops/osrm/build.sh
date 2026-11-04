#!/usr/bin/env bash
# Build a fresh OSRM dataset into a NEW dated folder for the weekly refresh (never in place under
# a running osrm-routed). Uses the same image and steps as the serving container, so the coverage
# (OSRM_PBF_URLS / OSRM_BBOX, defaults in ops/osrm/Dockerfile: Delhi NCR) is identical.
#
# Usage: ops/osrm/build.sh [data_dir]       (default: ops/data)
# Then: start a container on the new folder, smoke-test it, switch traffic (docs/deployment/osrm.md).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="osrm-bff/osrm-ncr:5.27.1"
DATA_DIR="${1:-$HERE/../data}"
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"
OUT="$DATA_DIR/$(date +%Y-%m-%d)"
mkdir -p "$OUT"

docker build -t "$IMAGE" "$HERE"

ENV_ARGS=()
for v in OSRM_PBF_URLS OSRM_BBOX OSRM_DATASET OSRM_PROFILE_LUA; do
  if [ -n "${!v:-}" ]; then ENV_ARGS+=(-e "$v=${!v}"); fi
done

# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the /data mount path.
MSYS_NO_PATHCONV=1 docker run --rm "${ENV_ARGS[@]}" -v "$OUT:/data" "$IMAGE" build

echo
echo "Built $OUT. Serve it with:"
echo "  docker run -d --name osrm-$(date +%Y%m%d) -v \"$OUT:/data\" -p 127.0.0.1:5001:5000 $IMAGE"
echo "then smoke-test port 5001, switch OSRM_BASE_URL / the service alias, and stop the old container."
