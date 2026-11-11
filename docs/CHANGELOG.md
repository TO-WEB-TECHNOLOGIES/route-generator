# CHANGELOG — osrm-bff

Fast-scan index first (date, tag, one line). Fuller entries, if any, go below the index. Open
problems live in `docs/ARCHITECTURE_REVIEW.md`, not here.

## Index

| Date | Tag(s) | One-line summary |
|---|---|---|
| 2026-11-04 | INIT | Boilerplate: TS/Node 22 service with enrich API, OSRM client, Redis route cache, incremental match, ops scripts, docs; skill unpacked into `.claude/skills/`. |
| 2026-11-04 | ROUTE-01, OPS | Coverage decided: Delhi/Gurugram/Noida/Ghaziabad; new `ops/osrm/Dockerfile` downloads the northern + central zones, clips to the NCR box, builds and serves (see docs/deployment/osrm.md). |
| 2026-11-05 | OPS | OSRM image build failed (base is Debian 11, EOL; apt 404s): map prep moved to a separate `osrm-prep` container on Debian 12; OSRM image now has no apt step. |
| 2026-11-05 | OPS | Map source switched to openstreetmap.fr per-state extracts (Delhi, Haryana, UP: ~279 MB vs ~549 MB Geofabrik zones); prep logs no longer flood with curl progress. |
| 2026-11-06 | OPS | Manual maps: `.osm.pbf` files in `ops/maps/` are used instead of downloading (validated, read-only); prep re-runs automatically when inputs change (fingerprint marker). |
| 2026-11-06 | ROUTE-09 | Out-of-coverage points no longer get absurd routes: `COVERAGE_BBOX` guard + `MAX_SNAP_DISTANCE_M` snap check in the OSRM client. |
| 2026-11-06 | ROUTE-10 | `/match` sends `radiuses` (`MATCH_RADIUS_M`=30) and clamps confidence to 1; smoke test `match` passes on real OSRM. |
| 2026-11-06 | API | New `GET /v1/route` (two-point road route; 400/404/422/503 errors), see docs/integration-docs/route.md. |
| 2026-11-06 | FIX | `REDIS_URL` default `localhost` → `127.0.0.1`: on Windows it resolved to IPv6 `::1` and Redis was refused (Docker listens on IPv4 only). |
| 2026-11-06 | TEST | Postman v3 collection `postman/collections/osrm-bff` (28 requests, 98 assertions) + `osrm-bff local` environment; `npm run test:api`. |
| 2026-11-09 | API, TEST | `GET /` answers like `/health`; Postman env file renamed to `*.environment.yaml` (Postman didn't load the old name), collection variables + a check that stops requests sent to OSRM's port 5000 (`InvalidUrl`). |
| 2026-11-09 | API | Enrich accepts logistics breadcrumbs: `path[].timestamp` optional (`/match` then sent without `timestamps`), `sequence` may be a numeric string. Backward compatible. |
| 2026-11-09 | ROUTE-08 | Decided per logistics plan 1.3: `RTO-Initiated` routes to the store; `RTO-Delivered` / `RTO-Disposed` are terminal; intercity stages (`Out-for-pickup`, `In-transit`, …) mapped. |
| 2026-11-09 | D1 | Decided: the frontend calls osrm-bff, which requests track from ondc-logistics-api and pushes the result back (to build in Part 2.4–2.6). |
| 2026-11-09 | TEST | Logistics fixtures + pure mapper `src/logistics/` (`toEnrichInput`), `test/logistics.test.ts`. |
| 2026-11-09 | DEV | `GET /dev/route-viewer`: dev map page drawing `/v1/route` and enrich responses (`DEV_VIEWER_ENABLED`, off in production). |
| 2026-11-10 | API | Live tracking: `POST /v1/track` (forwards to logistics), `POST /internal/v1/logistics/on_track` (webhook), SSE `GET /v1/orders/:id/track/events` + snapshot `GET /v1/orders/:id/track`; see docs/integration-docs/track.md. |
| 2026-11-10 | CONFIG | `ENV` (`TEST` or `PREPROD`) replaces "token only if set": TEST never checks the token, PREPROD requires it and won't start without `INTERNAL_TOKEN`. |
| 2026-11-10 | DOCS | `LOGISTICS_API_CHANGES.md`: what ondc-logistics-api must change (forward `/on_track` + `fulfillmentState`, `startGps`, `endGps`). |
| 2026-11-10 | DEV | Dev viewer "Live order" tab: SSE + `/v1/track` polling, plus a simulated `/on_track` button. |
| 2026-11-10 | OPS, ROUTE | Bengaluru added: `OSRM_BBOX` / `COVERAGE_BBOX` take `;`-separated boxes (NCR;Bengaluru), prep clips each file to every box in one pass, Karnataka extract added; a test keeps the two settings equal. |
| 2026-11-10 | OPS | Render free-tier deployment: `ops/render/` image (osrm-bff + OSRM on 127.0.0.1, NCR graph baked in, `--mmap=1`: ~50 MB at 512 MB/0.1 CPU) and `render.yaml`; see docs/deployment/render.md. |
| 2026-11-10 | OPS | Keep-alive self-ping (`src/keepalive.ts`): GETs our public `/health` every 10 min; on by default on Render (`RENDER_EXTERNAL_URL`). |
| 2026-11-10 | DOCS | `docs/deployment/render-design.md` (why each Render choice, alternatives), `docs/integration-docs/calling-the-api.md` (base URL, token, endpoints, route examples), Render Postman environment. |
| 2026-11-11 | API | Logistics webhook: a forward with no `gps` (URL-based / `deferred` tracking) now gets 202 and pushes nothing, instead of a 400; counted as `track.webhooks_no_gps`. |

---

## 2026-11-04 — INIT

- `bff-road-routing.skill` (zip) extracted to `.claude/skills/bff-road-routing/` (Claude Code only
  loads skills from that folder) and the archive removed. Added an "In the osrm-bff repo" file map
  to `SKILL.md`; the rest is unchanged.
- `CLAUDE.md` / `CLAUDE.local.md` adapted from `../ondc-api/CLAUDE.local.md` and the sibling
  `CLAUDE.md` files (ondc-api has no `CLAUDE.md`). They keep: read-only git/env, plan before
  implementing, contract first, audience-scoped `docs/`, the architecture-review delete-on-fix
  rule, one-line changelog index, a commit suggestion after every change, and a Postman file per route.
- Language: TypeScript on Node 22, the same stack as ondc-api (Express 5, ioredis 5.10).
