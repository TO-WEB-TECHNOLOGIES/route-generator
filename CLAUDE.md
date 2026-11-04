# CLAUDE.md --- osrm-bff (road routing for order tracking)

## 1. Project Identity

This repository is the **road-routing service behind our BFF** (`../ondc-api`, the F&B buyer
app's backend). It wraps a **self-hosted OSRM server** and turns each rider GPS update into:

- `route_ahead`: the road route from the rider to the current destination (store or drop),
- `road_path`: the rider's trail so far, snapped to roads,
- `drop_gps`: the buyer's delivery point (fixes the missing home marker).

The BFF calls this service once per GPS update and merges the result into `on_track` and
`GET /api/v1/track/:order_id`. **Phones never call a routing server.**

```
seller GPS -> ondc-api (BFF) --POST /internal/v1/track/enrich--> osrm-bff --> OSRM :5000 (private)
                    |                                               |
                    +---- on_track (SSE) to the app                 +--> Redis (route cache)
```

### Core principle

> Understand the existing architecture and contract first. Plan second. Implement third.

Never jump directly from a user request to code.

### The one rule that shapes every change

Routing is **decoration** on top of tracking. The GPS update is the real product. If routing is
slow, down, or wrong, the BFF must still push `on_track` on time with only the existing fields.
Any change that can delay or drop a GPS update because of routing is wrong, whatever else it fixes.

The skill `bff-road-routing` (`.claude/skills/bff-road-routing/`) is the design spec. Read it
before any routing work.

------------------------------------------------------------------------

## 2. HARD RULE --- NEVER PERFORM GIT WRITE OPERATIONS

Claude must **never** run:
- `git add`, `git commit`, `git push`
- `git reset`, `git restore`, `git checkout` when it changes working state
- `git stash`, `git merge`, `git rebase`, `git cherry-pick`
- anything that amends or rewrites history, or modifies staging state

Read-only inspection is allowed: `git status`, `git diff`, `git log`, `git show`, `git blame`,
`git branch --list`, and similar.

If a commit is requested, do not perform it. Give the user the exact command to run themselves
(see `CLAUDE.local.md` Rule 9 for the format).

------------------------------------------------------------------------

## 3. HARD RULE --- PLAN BEFORE IMPLEMENTATION

Before changing code, always provide a plan and wait for explicit approval.

1.  Inspect the relevant repository files.
2.  Identify the affected flow (route ahead, trail matching, cache, OSRM ops, internal API).
3.  Check the contract (§4) and the `bff-road-routing` skill.
4.  Explain the current behavior.
5.  Explain the proposed behavior.
6.  List files that will be changed/created.
7.  Call out assumptions, risks, and contract-sensitive decisions.
8.  Provide the implementation plan.
9.  **STOP and wait for explicit approval.**
10. Only after approval, implement.
11. Run the relevant validation (§11).
12. Summarize exactly what changed.

"Look into this", "what do you think" and "how should we do this" are not approval. Approval is
explicit: "Proceed", "Implement it", "Go ahead with this plan". If the scope changes, re-plan.

------------------------------------------------------------------------

## 4. CONTRACTS ARE THE SOURCE OF TRUTH

Three contracts meet in this service. Never invent or casually infer any of them.

| Contract | Where | Owner |
|---|---|---|
| App-facing `on_track` routing fields | `.claude/skills/bff-road-routing/references/contract.md`; mirrored in `../ondc-api/docs/integration-docs/track.md` and the users app's `documentations/track.md` | BFF + app |
| Internal enrich API (BFF -> this service) | `docs/integration-docs/track-enrich.md` | This repo |
| OSRM HTTP API v5 (`/route`, `/match`) | <https://project-osrm.org/docs/v5.24.0/api/> | OSRM |

### Frozen rules

- The three app-facing fields are **optional and additive**. Never rename, retype, or make them
  required without a versioned contract change. Existing `on_track` fields (`gps`,
  `gps_timestamp`, `path`, `status`, `tracking_url`, `updated_at`) are not ours to change.
- "Absent" means "not available this update", never "error".
- Polylines are **Google encoded, precision 5** (`geometries=polyline`, not `polyline6`).
- **Coordinate order:** our strings are `"lat,lng"`; OSRM URLs and `waypoints[].location` are
  `lng,lat`; decoded polylines are `(lat, lng)`. Parse once into a typed `LatLng`
  (`src/geo/point.ts`) and build URLs from named fields. A lat/lng swap usually still returns
  `Ok`, but routes somewhere absurd. That makes it the most likely bug here.

If a requested change needs a contract change, stop and tell the user.

------------------------------------------------------------------------

## 5. FLOW CONTEXT (per GPS update)

1. **Route ahead.** Stage -> destination (`src/routing/stage.ts`):
   Agent-assigned / At-pickup -> store; Order-picked-up / Out-for-delivery -> drop;
   At-delivery / delivered / cancelled -> none (omit `route_ahead`).
   Re-route only if the rider moved > `REROUTE_THRESHOLD_M` (30 m, haversine) from the point the
   cached route was built from, or the stage changed. Otherwise resend the cached route.
2. **Trail.** Match only the **new tail** of `path` with OSRM `/match` (timestamps in Unix
   seconds, non-decreasing), starting `MATCH_OVERLAP_POINTS` before the last matched sequence, and
   append to the cached polyline. Never re-match the whole trail.
3. Steps 1 and 2 run in parallel. Each has its own OSRM timeout.

------------------------------------------------------------------------

## 6. FAILURE RULES (do not bend these)

- OSRM timeout `OSRM_TIMEOUT_MS` (~1 s). On error/timeout, omit that field. Never throw it to
  the BFF as an error. The enrich endpoint answers 200 with whatever it could build.
- No route, or match confidence below `MATCH_MIN_CONFIDENCE`: omit that field for that update.
- Redis down = cache miss. It never fails the request.
- The BFF calls us with its own short timeout and pushes `on_track` without the fields if we're
  slow. Document that budget in `docs/integration-docs/track-enrich.md` whenever timeouts change.
- Log OSRM latency and error counts (`src/metrics.ts`, `GET /metrics`). A dead container is silent
  for users (the app falls back to straight lines), so metrics are the only alarm.
- Every routing test suite includes an "OSRM down or slow" case asserting the response still comes
  back on time with only the non-routing fields.

------------------------------------------------------------------------

## 7. SECURITY / NETWORK

- OSRM listens on the private network only (port 5000). No public access, no auth.
- This service is internal-only. If `INTERNAL_TOKEN` is set, every `/internal/*` call must carry
  `X-Internal-Token`.
- **Never call the public demo server (`router.project-osrm.org`)** from code, tests or the app.
  It allows ~1 req/s for the whole app, is non-commercial only, and can block us without notice.
  If a change would make the app call any routing API directly in a release build, push back.
- Never log secrets or token values. GPS points are personal data: log `order_id`, not full trails.

------------------------------------------------------------------------

## 8. DATA AUTHORITY

**Seller GPS -> BFF (`ondc-api`) -> this service -> Redis route cache**

- The BFF owns the order, the stage, the GPS and the recorded `path`. We never write them back.
- Our Redis cache (`route:ahead:*`, `route:trail:*`) is **derived and disposable**. It is safe to
  flush at any time; the next update rebuilds it. Never treat it as authoritative.
- No database. Adding one needs an explicit plan and an `ARCHITECTURE_REVIEW.md` entry.

------------------------------------------------------------------------

## 9. IDEMPOTENCY / CONCURRENCY

- The same GPS update delivered twice must not grow the trail twice. `last_seq` in
  `route:trail:{order_id}` is the idempotency boundary.
- Points with a timestamp older than the previous point are dropped before `/match`.
- Two updates for the same order can race (several BFF processes). Last-writer-wins on the trail
  cache is acceptable today because it only costs a re-match. Revisit before scaling out
  (tracked in `docs/ARCHITECTURE_REVIEW.md`).

------------------------------------------------------------------------

## 10. CODE CHANGE DISCIPLINE

Prefer: small localized changes, the existing modules (`geo/`, `osrm/`, `routing/`), named config
values over magic numbers, pure functions with injected dependencies (so tests need no Redis or
OSRM), deterministic behavior.

Avoid: speculative refactors, unrelated renames, new abstractions for one use case, changing the
contract for convenience, formatting churn, Redis key/TTL changes without a plan, new runtime
dependencies without saying why.

------------------------------------------------------------------------

## 11. TESTING / VALIDATION

After implementation:
- `npm run typecheck`
- `npm test` (Node test runner via `tsx`; no Redis/OSRM needed)
- for OSRM/ops changes: `bash .claude/skills/bff-road-routing/scripts/smoke_test.sh <osrm_url>`
  from the BFF host
- inspect the final diff; check coordinate order and polyline precision by hand

Do not claim a check passed unless it was actually run. Do not weaken tests to make an
implementation pass.

------------------------------------------------------------------------

## 12. DOCUMENTATION

Documentation rules, folder layout, the architecture-review workflow and the changelog live in
`CLAUDE.local.md`. A task is not done until its docs are updated.

------------------------------------------------------------------------

## 13. RESPONSE FORMAT

For implementation requests:

### Plan
- Goal
- Current behavior
- Proposed behavior
- Files to change
- Contract impact (app-facing fields / internal API / OSRM usage)
- Cache/data impact (Redis keys, TTLs)
- Validation
- Risks/assumptions

Then wait for approval. After approval:

### Implementation
What actually changed, plus the docs and changelog entries.

### Validation
Commands actually run and their results.

### Remaining
Anything that still needs user action, plus the suggested commit command (`CLAUDE.local.md` Rule 9).

------------------------------------------------------------------------

## 14. WHEN UNSURE

Do not guess. Say what is known, what is uncertain, which file/contract would resolve it, and ask
the minimum necessary question.

These design questions are **open**. If a task depends on one, flag it, or pick a reversible
default and call it out (tracked in `docs/ARCHITECTURE_REVIEW.md`):
- Which cities/zones are needed on day one (which Geofabrik extract).
- Where OSRM runs (same VPC as the BFF) and who owns the weekly refresh.
- Custom two-wheeler profile vs `car.lua`.
- Whether drop GPS is reliable in `end.location.gps` for every seller, or should come from the
  saved address.
- Whether `route_ahead.duration_s` feeds the "Arriving in" ETA. **Until decided: display-only.**
