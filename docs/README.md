# docs/ — Documentation Index

Same audience-scoped layout as `../ondc-api/docs/` (see `CLAUDE.local.md` Rules 2, 4, 6, 8).

| Path | Audience | What's there |
|---|---|---|
| `integration-docs/` | BFF (`ondc-api`) engineer calling this service | `track-enrich.md`: the internal enrich API contract and timeout budget |
| `internal/` | Engineer working on this service | `routing.md`: module map, Redis keys/TTLs, tunables, algorithm notes, gotchas |
| `deployment/` | Whoever runs OSRM and this service | `osrm.md`: map build, serving, weekly refresh, sizing, alerts |
| `ARCHITECTURE_REVIEW.md` | Lead/CTO | Everything still open: bugs, open design questions, planned integrations |
| `CHANGELOG.md` | Anyone | What shipped: one-line index, optional detail below |

**The app-facing `on_track` contract** (`route_ahead`, `road_path`, `drop_gps`) is defined in
`.claude/skills/bff-road-routing/references/contract.md` and mirrored in
`../ondc-api/docs/integration-docs/track.md` and the users app's `documentations/track.md`.

**Rule of thumb:** if the BFF engineer needs it to call us, it goes in `integration-docs/`. If only
someone changing this service needs it, `internal/`. If it's about running OSRM or this service,
`deployment/`.
