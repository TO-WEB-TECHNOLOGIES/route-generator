#!/usr/bin/env bash
# OSRM container entrypoint.
#   serve  (default) build the dataset if /data has none yet, then run osrm-routed on :5000
#   build  build the dataset into /data and exit (used by ops/osrm/build.sh for refreshes)
#   other  run the given command (e.g. bash)
#
# Building happens only BEFORE osrm-routed starts, never under a running server.
# Set OSRM_FORCE_REBUILD=1 to rebuild over existing data (e.g. after changing the box or URLs).
set -euo pipefail

DATA=/data
NAME="${OSRM_DATASET:-ncr}"
BASE="$DATA/$NAME.osrm"
MARKER="$DATA/.$NAME.built"

log() { echo "[osrm-entrypoint] $*"; }

prepare() {
  local src="$DATA/src" clipped=() url file i=0
  mkdir -p "$src"
  rm -f "$MARKER"

  for url in ${OSRM_PBF_URLS:?OSRM_PBF_URLS is empty}; do
    file="$src/$(basename "$url")"
    if [ ! -s "$file" ]; then
      log "downloading $url"
      curl -fL --retry 3 -o "$file.part" "$url"
      mv "$file.part" "$file"
    else
      log "reusing $file"
    fi

    if [ -n "${OSRM_BBOX:-}" ]; then
      i=$((i + 1))
      log "clipping $(basename "$file") to bbox $OSRM_BBOX"
      osmium extract --overwrite --strategy smart --set-bounds -b "$OSRM_BBOX" \
        -o "$src/clip-$i.osm.pbf" "$file"
      clipped+=("$src/clip-$i.osm.pbf")
    else
      clipped+=("$file")
    fi
  done

  if [ "${#clipped[@]}" -gt 1 ]; then
    log "merging ${#clipped[@]} extracts"
    osmium merge --overwrite -o "$DATA/$NAME.osm.pbf" "${clipped[@]}"
  else
    cp "${clipped[0]}" "$DATA/$NAME.osm.pbf"
  fi

  local profile="${OSRM_PROFILE_LUA:-/opt/car.lua}"
  log "osrm-extract ($profile)"
  osrm-extract -p "$profile" "$DATA/$NAME.osm.pbf"
  log "osrm-partition"
  osrm-partition "$BASE"
  log "osrm-customize"
  osrm-customize "$BASE"

  rm -f "$src"/clip-*.osm.pbf
  [ "${OSRM_KEEP_SOURCES:-0}" = "1" ] || rm -rf "$src"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
  log "dataset ready: $BASE"
}

case "${1:-serve}" in
  build)
    prepare
    ;;
  serve)
    if [ "${OSRM_FORCE_REBUILD:-0}" = "1" ] || [ ! -f "$MARKER" ]; then
      prepare
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
