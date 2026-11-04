#!/usr/bin/env bash
# Smoke-test an OSRM server from the BFF host.
# Usage: scripts/smoke_test.sh [base_url] [from_lat,from_lng] [to_lat,to_lng]
# Points are given lat,lng (our format); the script converts to OSRM's lng,lat.
set -euo pipefail

BASE="${1:-http://osrm:5000}"
FROM="${2:-28.4302136,77.0433475}"
TO="${3:-28.4351,77.0512}"

flip() { local lat="${1%,*}" lng="${1#*,}"; echo "${lng},${lat}"; }
A=$(flip "$FROM"); B=$(flip "$TO")

fail=0
check() {
  local name="$1" url="$2" start end body code
  start=$(date +%s%N)
  body=$(curl -sS --max-time 2 "$url") || { echo "FAIL $name: request error/timeout"; fail=1; return; }
  end=$(date +%s%N)
  code=$(echo "$body" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p' | head -1)
  if [ "$code" = "Ok" ]; then
    echo "OK   $name ($(( (end-start)/1000000 )) ms)"
  else
    echo "FAIL $name: code=${code:-none}"; echo "$body" | head -c 300; echo; fail=1
  fi
}

check "route" "$BASE/route/v1/driving/$A;$B?overview=full&geometries=polyline"

NOW=$(date +%s)
check "match" "$BASE/match/v1/driving/$A;$B?timestamps=$((NOW-120));$NOW&overview=full&geometries=polyline"

exit $fail
