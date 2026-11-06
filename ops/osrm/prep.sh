#!/usr/bin/env bash
# Step 1 of 2 (runs in the osrm-prep container): produce /data/<dataset>.osm.pbf for the NCR box.
#   inputs -> clip each to OSRM_BBOX -> merge into one file.
# Inputs, in order of preference:
#   1. Map files you downloaded yourself, dropped in ops/maps/ (mounted read-only at /maps).
#   2. Otherwise, download each URL in OSRM_PBF_URLS.
# Step 2 (osrm container, entrypoint.sh) turns that file into a routable graph and serves it.
#
# Re-runs are skipped while the inputs and box are unchanged (fingerprint in the prep marker).
# Add/replace a file in ops/maps/ and the map is rebuilt automatically. OSRM_FORCE_REBUILD=1
# redoes it regardless.
set -euo pipefail

DATA=/data
MAPS="${OSRM_LOCAL_MAPS_DIR:-/maps}"
NAME="${OSRM_DATASET:-ncr}"
OUT="$DATA/$NAME.osm.pbf"
BUILT_MARKER="$DATA/.$NAME.built"   # written by entrypoint.sh after a successful OSRM build
PREP_MARKER="$DATA/.$NAME.prepped"  # first line: fingerprint of the inputs it was built from

log() { echo "[osrm-prep] $*"; }

# Local map files: *.pbf only (ignores browser partials like *.crdownload / *.part).
local_files=()
if [ -d "$MAPS" ]; then
  while IFS= read -r -d '' f; do local_files+=("$f"); done \
    < <(find "$MAPS" -maxdepth 1 -type f -name '*.pbf' -print0 | sort -z)
fi

if [ "${#local_files[@]}" -gt 0 ]; then
  source_desc="local:$(for f in "${local_files[@]}"; do printf '%s=%s;' "$(basename "$f")" "$(stat -c %s "$f")"; done)"
else
  source_desc="urls:${OSRM_PBF_URLS:?no files in ops/maps/ and OSRM_PBF_URLS is empty}"
fi
fingerprint="$source_desc|bbox:${OSRM_BBOX:-none}"

if [ "${OSRM_FORCE_REBUILD:-0}" != "1" ] && [ -s "$OUT" ] && [ -f "$PREP_MARKER" ] \
   && [ "$(head -n1 "$PREP_MARKER")" = "$fingerprint" ]; then
  log "map already prepared from the same inputs ($(sed -n 2p "$PREP_MARKER")), nothing to do"
  exit 0
fi

src="$DATA/src"
mkdir -p "$src"
rm -f "$PREP_MARKER"
rm -f "$BUILT_MARKER"   # new map input => the osrm container must rebuild its graph

inputs=()
if [ "${#local_files[@]}" -gt 0 ]; then
  log "using ${#local_files[@]} map file(s) from ops/maps/ (no download)"
  for f in "${local_files[@]}"; do
    # Catches truncated/half-finished downloads before they reach the OSRM build. -e reads the
    # whole file (a header-only check passes truncated files); a few seconds per 100 MB.
    if ! osmium fileinfo -e --no-progress "$f" > /dev/null 2>&1; then
      log "ERROR: $(basename "$f") is not a valid/complete .osm.pbf file (incomplete download?). Re-download it."
      exit 1
    fi
    log "  $(basename "$f") ($(du -h "$f" | cut -f1)) ok"
    inputs+=("$f")
  done
else
  for url in $OSRM_PBF_URLS; do
    file="$src/$(basename "$url")"
    if [ ! -s "$file" ]; then
      log "downloading $url"
      started=$(date +%s)
      # -sS: no progress meter (it floods `docker logs`), but still print errors.
      curl -fL -sS --retry 3 -o "$file.part" "$url"
      mv "$file.part" "$file"
      log "downloaded $(du -h "$file" | cut -f1) in $(( $(date +%s) - started ))s"
    else
      log "reusing $file"
    fi
    inputs+=("$file")
  done
fi

clipped=()
i=0
for file in "${inputs[@]}"; do
  if [ -n "${OSRM_BBOX:-}" ]; then
    i=$((i + 1))
    log "clipping $(basename "$file") to bbox $OSRM_BBOX"
    osmium extract --overwrite --no-progress --strategy smart --set-bounds -b "$OSRM_BBOX" \
      -o "$src/clip-$i.osm.pbf" "$file"
    clipped+=("$src/clip-$i.osm.pbf")
  else
    clipped+=("$file")
  fi
done

if [ "${#clipped[@]}" -gt 1 ]; then
  log "merging ${#clipped[@]} extracts into $OUT"
  osmium merge --overwrite --no-progress -o "$OUT" "${clipped[@]}"
else
  cp "${clipped[0]}" "$OUT"
fi

# Only temporary/downloaded files are removed. Files in ops/maps/ are yours and are never touched.
rm -f "$src"/clip-*.osm.pbf
[ "${OSRM_KEEP_SOURCES:-0}" = "1" ] || rm -rf "$src"
printf '%s\n%s\n' "$fingerprint" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PREP_MARKER"
log "ready: $OUT ($(du -h "$OUT" | cut -f1))"
