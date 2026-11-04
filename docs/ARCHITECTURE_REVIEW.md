# osrm-bff — Architecture Review

**Scope:** open bugs, open design questions, and planned integrations only. When an item is fixed
or decided, **delete it here** and add one dated line to `docs/CHANGELOG.md` (`CLAUDE.local.md`
Rule 6).

Status tags: `[OPEN]` not yet decided · `[CONFIRMED]` agreed, fix queued · `[DEFERRED]` not now
(reason noted) · `[WONTFIX]` decided against. Do not implement an item until it is `[CONFIRMED]`.

**Constraint:** the app-facing fields `route_ahead`, `road_path`, `drop_gps` are optional and
additive. Never rename, retype, or make them required without a versioned contract change.

---

## Integration gaps (found 2026-11-04 against `../ondc-api` as it stands)

### INT-01 `[OPEN]` ondc-api doesn't record a timestamped `path` yet
The skill assumes the BFF already keeps the rider trail (`path[]` with `lat_lng` + `sequence`).
`../ondc-api/src/services/track.service.ts` `processOnTrack` stores only the latest `gps` in
`TRACK_CACHE_TTL` (600 s) Redis. There is no trail, and no per-point timestamp, which `/match`
requires. Until ondc-api records `path[]` with timestamps, `road_path` can't be built.
Option: osrm-bff records the raw points itself (one new Redis key). Needs a decision.

### INT-02 `[OPEN]` ondc-api has no 15 s `on_track` push
The skill says the BFF polls the seller and pushes `on_track` about every 15 s. Today `/track` is
frontend-triggered (the cron was removed 2026-07-11, see `../ondc-api/docs/internal/track.md`).
Enrichment then happens only when a client asks. That works, but the trail is sparse and every
viewer's `/track` call hits the BPP. Confirm the target polling design with the BFF owner.

### INT-03 `[OPEN]` ondc-api wiring not written
Needed in ondc-api (not this repo): call `POST /internal/v1/track/enrich` from `processOnTrack`
with a ~1500 ms timeout, merge the result into the cache/SSE payload and `getTrack`, add
`OSRM_BFF_URL` / `OSRM_BFF_TOKEN` config, and update `docs/integration-docs/track.md` there.

## Open design questions (from the skill)

### ROUTE-01 `[OPEN]` Day-one cities/zones, so which Geofabrik extract
Boilerplate default: India northern zone (`ops/osrm/build.sh`). Reversible.

### ROUTE-02 `[OPEN]` Where OSRM runs, and who owns the weekly refresh
Assumed: same VPC as the BFF, private port 5000.

### ROUTE-03 `[OPEN]` `MATCH_MIN_CONFIDENCE` value
Set to 0.5 as a reversible default. Tune from real traces: log the confidence distribution on
staging before fixing it.

### ROUTE-04 `[OPEN]` Low-confidence tail never advances
On low confidence, `last_seq` isn't advanced, so the next update retries with more context. A
persistently unmatchable stretch would keep `road_path` omitted for the rest of the order.
Options: advance past it after N failures (leaving a gap), or match smaller windows.

### ROUTE-05 `[OPEN]` Two-wheeler profile vs `car.lua`
`car.lua` obeys one-way streets, so routes can be longer than what riders actually take. Don't
introduce a custom profile without agreement.

### ROUTE-06 `[OPEN]` Drop GPS source
Is `end.location.gps` reliable for every seller, or should the saved address's lat/lng win? The
service takes whatever `drop_gps` the BFF sends.

### ROUTE-07 `[OPEN]` `route_ahead.duration_s` and the "Arriving in" ETA
Display-only until decided.

### ROUTE-08 `[OPEN]` RTO stages
`RTO-Initiated` / `RTO-Delivered` etc. aren't mapped (no route ahead, cache not cleared until TTL).
Decide whether RTO routes back to the store.

## Scaling notes

### SCALE-01 `[DEFERRED]` Concurrent updates for one order race on `route:trail:*`
Last-writer-wins. The worst case is a duplicate match segment or a lost append that is re-matched
on the next update. Deferred because the cost is only a redundant OSRM call, but ondc-api runs
several PM2 processes, so concurrent updates for one order are possible. Revisit (e.g. a per-order
lock or `WATCH`) once INT-02's push design is settled.
