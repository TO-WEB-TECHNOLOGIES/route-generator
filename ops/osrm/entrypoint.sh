#!/usr/bin/env bash
# Step 2 of 2 (runs in the osrm container). Expects /data/<dataset>.osm.pbf from prep.sh (step 1).
#   serve  (default) build the OSRM dataset if not built yet, then run osrm-routed on :5000
#   build  build the OSRM dataset and exit (used by ops/osrm/build.sh for refreshes)
#   other  run the given command (e.g. bash)
#
# Building happens only BEFORE osrm-routed starts, never under a running server.
# A fresh map from prep.sh deletes the built marker, so the graph is rebuilt automatically.
# OSRM_FORCE_REBUILD=1 here rebuilds the graph from the existing .osm.pbf.
set -euo pipefail

DATA=/data
NAME="${OSRM_DATASET:-ncr}"
PBF="$DATA/$NAME.osm.pbf"
BASE="$DATA/$NAME.osrm"
MARKER="$DATA/.$NAME.built"

log() { echo "[osrm-entrypoint] $*"; }

build() {
  if [ ! -s "$PBF" ]; then
    log "ERROR: $PBF not found. Run the osrm-prep container first (docker compose does this automatically)."
    exit 1
  fi
  rm -f "$MARKER"
  local profile="${OSRM_PROFILE_LUA:-/opt/car.lua}"
  log "osrm-extract ($profile)"
  osrm-extract -p "$profile" "$PBF"
  log "osrm-partition"
  osrm-partition "$BASE"
  log "osrm-customize"
  osrm-customize "$BASE"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
  log "dataset ready: $BASE"
}

case "${1:-serve}" in
  build)
    build
    ;;
  serve)
    if [ "${OSRM_FORCE_REBUILD:-0}" = "1" ] || [ ! -f "$MARKER" ]; then
      build
    else
      log "using dataset built $(cat "$MARKER")"
    fi
    log "starting osrm-routed on :5000"
    exec osrm-routed --algorithm mld --port 5000 \
      --max-matching-size "${OSRM_MAX_MATCHING_SIZE:-100}" "$BASE"
    ;;
  *)
    exec "$@"
    ;;
esac
