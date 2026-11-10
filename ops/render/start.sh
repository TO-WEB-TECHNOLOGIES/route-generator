#!/usr/bin/env bash
# Container start for the Render image (ops/render/Dockerfile): OSRM and osrm-bff in one container.
#
#   1. osrm-routed on 127.0.0.1:5000 (never reachable from outside the container), restarted if it
#      dies. Routing is decoration: osrm-bff keeps serving GPS updates while OSRM is down.
#   2. Wait until OSRM accepts connections (or OSRM_START_TIMEOUT_S passes).
#   3. node dist/index.js on $PORT. The container lives as long as Node does.
#   SIGTERM (Render deploy/restart): Node shuts down gracefully (closes streams), then OSRM stops.
set -uo pipefail

MAP="${OSRM_MAP:-/data/ncr.osrm}"
MMAP=()
# "--mmap=1", not "--mmap": the flag takes an optional value and would swallow the map path.
[ "${OSRM_MMAP:-1}" = "1" ] && MMAP=(--mmap=1)

log() { echo "[start] $*"; }

run_osrm() {
  local child=""
  trap '[ -n "$child" ] && kill -TERM "$child" 2>/dev/null; exit 0' TERM
  while true; do
    osrm-routed --algorithm mld --ip 127.0.0.1 --port 5000 \
      --max-matching-size "${OSRM_MAX_MATCHING_SIZE:-100}" "${MMAP[@]}" "$MAP" &
    child=$!
    wait "$child"
    log "osrm-routed exited (status $?), restarting in 10 s; routing fields are omitted meanwhile"
    sleep 10
  done
}

log "starting osrm-routed (${MMAP[*]:-no mmap}) on 127.0.0.1:5000"
run_osrm &
SUPERVISOR=$!

for i in $(seq 1 "${OSRM_START_TIMEOUT_S:-120}"); do
  if (exec 3<>/dev/tcp/127.0.0.1/5000) 2>/dev/null; then
    log "osrm-routed is up after ${i} s"
    break
  fi
  sleep 1
done

log "starting osrm-bff on port ${PORT:-10000}"
node /app/dist/index.js &
NODE=$!
trap 'kill -TERM "$NODE" 2>/dev/null' TERM INT

wait "$NODE"
status=$?
# `wait` returns early when a signal runs the trap: wait again for Node's graceful shutdown.
if kill -0 "$NODE" 2>/dev/null; then
  wait "$NODE"
  status=$?
fi
kill -TERM "$SUPERVISOR" 2>/dev/null
wait "$SUPERVISOR" 2>/dev/null
log "osrm-bff exited (status $status)"
exit "$status"
