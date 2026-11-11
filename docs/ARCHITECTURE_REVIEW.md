# osrm-bff — Architecture Review

**Scope:** open bugs, open design questions, and planned integrations only. When an item is fixed
or decided, **delete it here** and add one dated line to `docs/CHANGELOG.md` (`CLAUDE.local.md`
Rule 6).

Status tags: `[OPEN]` not yet decided · `[CONFIRMED]` agreed, fix queued · `[DEFERRED]` not now
(reason noted) · `[WONTFIX]` decided against. Do not implement an item until it is `[CONFIRMED]`.

**Constraint:** the app-facing fields `route_ahead`, `road_path`, `drop_gps` are optional and
additive. Never rename, retype, or make them required without a versioned contract change.

---

## Integration via ondc-logistics-api (2026-11-04)

### INT-04 `[OPEN]` Logistics integration: osrm-bff side built, logistics change and app auth pending
Full plan and read-only findings: `task/osrm-via-logistics-api-plan.md`; order of work in parts:
`task/phased-development-plan.md`; proposed app-facing flow (decisions Q1–Q6):
`understanding/05-map-downloads-and-frontend-flow.md`.
- **D1 decided 2026-11-09, built 2026-11-10 on the osrm-bff side:** the frontend calls `POST /v1/track`;
  we forward to `POST /logistics/track`; logistics forwards each `/on_track` to our webhook (Q2: webhook,
  not SSE); we push `track_update` over SSE (D2: one event, routing under `ENRICH_DEADLINE_MS`); the
  frontend polls `/v1/track` (D4). See `docs/integration-docs/track.md`.
- **Pending, ondc-logistics-api:** the forward itself plus `fulfillmentState`, `startGps`, `endGps`
  (`LOGISTICS_API_CHANGES.md`). Without the GPS fields there's no route ahead and no home marker.
  Without `fulfillmentState` we fall back to one `GET .../status` call per update.
- **D5 decided 2026-11-09:** logistics stages mapped per plan Phase 1.3 (see `docs/CHANGELOG.md`).
- Timestamp-less breadcrumbs: now accepted (2026-11-09). Match confidence on untimed traces is still
  to be measured on real OSRM (ROUTE-03).
- **Blocking for production:** osrm-bff is now app-facing, so it needs app auth (understanding/05 Q4).
  Today there is `ENV=TEST` (no checks) or `ENV=PREPROD` (the shared `X-Internal-Token`, which must
  never ship in a release build). Browser `EventSource` can't send headers either.
- **Confirm:** with D1, do INT-01..03 (ondc-api calling enrich) still apply, or are they superseded?
- `/track` is valid only after pickup (LSP NACK `60012`), so no "route to store" from this path.
- **Preprod can't show routes end to end (2026-11-11):** the workbench `/on_track` always returns a
  fixed Bengaluru rider (`12.9740,77.6134`) while `/search`/`/init` use Gurugram. Markers show in
  NCR, no route is built (coverage guard). Test routes with hand-made NCR webhook calls.
- Logistics' open questions (`LOGISTICS_API_CHANGES.md` §5) answered 2026-11-11.
- Still open: D6 (tests in the logistics repo). D3 settled for our side: snake_case to the frontend.

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

## Operations

### OPS-01 `[OPEN]` Automated deploy to Render on push (2026-11-11)
Today the Render image is built on a laptop (graph copied from the local Docker volume), pushed to
GHCR by hand, and `render.yaml` / the dashboard is edited to deploy. Plan:
`task/github-actions-render-deploy-plan.md` (CI on every PR, map base image built rarely, app image
built + deployed via a Render deploy hook on push to `main`). Open: which remote hosts CI
(`origin` personal vs `neworigin` org), and who owns the Render deploy hook secret.

## Performance

### PERF-01 `[DEFERRED]` Cache for `GET /v1/route` pairs
Proposed `route:pair:{from}:{to}` (coordinates rounded ~10 m). Deferred 2026-11-06: OSRM answers
in ~120 ms locally and handles hundreds of req/s; there are no load numbers that justify a cache
yet. Revisit with a before/after metric once real traffic exists (CLAUDE.local.md Rule 7).

## Open design questions (from the skill)

### ROUTE-02 `[OPEN]` Where OSRM runs, and who owns the weekly refresh
Assumed: same VPC as the BFF, private port 5000. **2026-11-10, demo/QA:** Render free tier, OSRM
inside the osrm-bff container on 127.0.0.1 (`docs/deployment/render.md`). Production hosting
(Render paid private service, or one EC2 `t3.small` with compose) and the refresh owner are still
open.

### ROUTE-03 `[OPEN]` `MATCH_MIN_CONFIDENCE` value
Set to 0.5 as a reversible default. Tune from real traces: log the confidence distribution on
staging before fixing it. Synthetic evidence (2026-11-06, local NCR OSRM, `radiuses=30`): realistic
25-point traces at 0 / ±10 / ±25 m noise scored 0.96–0.97, so 0.5 isn't dropping good traces.

### ROUTE-04 `[OPEN]` Low-confidence tail never advances
On low confidence, `last_seq` isn't advanced, so the next update retries with more context. A
persistently unmatchable stretch would keep `road_path` omitted for the rest of the order.
Options: advance past it after N failures (leaving a gap), or match smaller windows.

### ROUTE-11 `[OPEN]` Logistics breadcrumbs don't grow the trail (2026-11-10, evidence 2026-11-11)
Since 2026-11-09 `sequence` is the only ordering and the idempotency boundary (`last_seq`) for
logistics input, which has no per-point time. **Confirmed 2026-11-11** (logistics owner, real
workbench `/on_track`, `config.type` `live_poll`): every callback carries **one** breadcrumb,
numbered `"1"`, equal to `gps`. After the first update every point looks like a duplicate
(`1 <= last_seq`), and one point can't be matched anyway, so `road_path` never appears on preprod.
Logistics passes LSP tags through unchanged and has no real-LSP samples; an LSP that renumbers a
window `1..N` or resets mid-order would fail the same way.
**Proposed fix (option B, awaiting approval):** osrm-bff records its own breadcrumbs from each
forwarded `gps` + `locationTimestamp`, numbered by us, in a new key `route:crumbs:{order_id}`
(named TTL, same lifetime as `route:trail:*`, cleared on a final stage). Skip a point whose
timestamp isn't newer than the last one, or whose position didn't change. Use it whenever the LSP's
`path` doesn't advance past `last_seq`. Bonus: real timestamps for `/match` (helps ROUTE-03, and is
the "osrm-bff records raw points" option in INT-01). Needs a Redis key plan (CLAUDE.local.md Rule 7).

### ROUTE-05 `[OPEN]` Two-wheeler profile vs `car.lua`
`car.lua` obeys one-way streets, so routes can be longer than what riders actually take. Don't
introduce a custom profile without agreement.

### ROUTE-06 `[OPEN]` Drop GPS source
Is `end.location.gps` reliable for every seller, or should the saved address's lat/lng win? The
service takes whatever `drop_gps` the BFF sends.

### ROUTE-07 `[OPEN]` `route_ahead.duration_s` and the "Arriving in" ETA
Display-only until decided.

## Scaling notes

### SCALE-02 `[DEFERRED]` Frontend SSE streams live in one process's memory (2026-11-10)
`src/tracking/hub.ts` keeps open streams in a Map. With several osrm-bff processes, the webhook can
land on a process that doesn't hold the order's streams, so that frontend never gets the update.
Run **one** process until this moves to Redis pub/sub (publish per order, every process forwards to
its own streams). Deferred: no multi-process deployment yet.

### SCALE-01 `[DEFERRED]` Concurrent updates for one order race on `route:trail:*`
Last-writer-wins. The worst case is a duplicate match segment or a lost append that is re-matched
on the next update. Deferred because the cost is only a redundant OSRM call, but ondc-api runs
several PM2 processes, so concurrent updates for one order are possible. Revisit (e.g. a per-order
lock or `WATCH`) once INT-02's push design is settled.
