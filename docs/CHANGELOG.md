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
