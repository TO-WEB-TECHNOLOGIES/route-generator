# CLAUDE.local.md

Project-specific behavioral overrides. These rules extend and take precedence over `CLAUDE.md` for
this repository. Adapted from `../ondc-api/CLAUDE.local.md` (2026-11-04); the principles are the
same, and the ONDC-specific parts are replaced with their routing equivalents.

---

## 0. Git and Environment Files Are Read-Only — No Exceptions

**Never stage, modify, remove, or commit anything in git, and never write to any `.env`/secrets
file. This is absolute. There is no "the user asked for it in this turn" exception.**

- Read-only git commands are always allowed: `git status`, `git diff`, `git log`, `git show`,
  `git blame`, `git branch` (listing), and similar.
- Never run `git add`, `git rm`, `git commit`, `git push`, `git reset`, `git checkout`/`git restore`,
  `git stash`, `git merge`, `git rebase`, `git cherry-pick`, or anything else that stages, removes,
  modifies or commits tracked state, **including when the user explicitly asks in the current
  request.** "Go ahead," "yes," and "commit that" all still mean: hand over the command, don't run it.
- **Environment/secrets files** (`.env`, `.env.*` except `.env.example`, anything holding
  credentials): reading them to debug is fine. **Never write to them**: no `Edit`, `Write`,
  `sed -i`, or redirection. If a value must change, tell the user what to change.
  `.env.example` holds no secrets and is documentation. Keep it in sync with `src/config.ts`.

---

## 1. Contract First

**Always apply the `bff-road-routing` skill before touching any code.**

- Before implementing, modifying, or reviewing anything that touches the enrich API, the
  app-facing routing fields, OSRM calls, or the route cache, read the skill and its
  `references/contract.md`. For container/map-data/refresh work, read `references/osrm-ops.md`.
- If the contract is ambiguous or missing, stop. Flag it and ask before proceeding.
- Never assume a payload shape from context alone. The contract is the source of truth.

---

## 2. Documentation Lives in `docs/` — Mandatory, Audience-Scoped

| Folder | Audience | Contains |
|---|---|---|
| `docs/integration-docs/` | BFF (`ondc-api`) engineer calling this service | Purpose, request cURL, request/response field tables, timeout budget, the status codes the caller must react to. **No Redis keys, module names, or internals.** |
| `docs/internal/` | Engineer working on this service | Redis key patterns (with named TTL constants), module/file map, algorithm notes (re-route check, incremental match), condensed gotchas pointing to `docs/CHANGELOG.md` by date/tag. |
| `docs/deployment/` | Whoever runs OSRM and this service | Container setup, map extract build, weekly refresh runbook, sizing, alerts. |
| `docs/ARCHITECTURE_REVIEW.md` | Lead/CTO | Every open bug, issue, open design question, and planned integration (Rule 6). |
| `docs/CHANGELOG.md` | Anyone referencing past work | What already shipped (Rule 8). |

- After any change (bug fix, feature, refactor, config), update the relevant file(s) in
  `docs/integration-docs/` (if the BFF-visible contract changed) **and/or** `docs/internal/`
  (if implementation changed).
- **App-facing field changes also touch two other repos:** `../ondc-api/docs/integration-docs/track.md`
  and the users app's `documentations/track.md`. This repo can't edit those as part of a change
  here. List the exact edits needed in the response's "Remaining" section.
- If a doc file doesn't exist yet, create it under the right subfolder, never at the repo root.
- Docs are part of task completion, not optional.
- Include a date and a brief what/why in each doc update. For `docs/internal/*` gotchas, prefer a
  one-line pointer to the `docs/CHANGELOG.md` entry over retelling the story.
- **Before creating a doc, search the whole repo for an existing one on the same subject**
  (`find . -maxdepth 3 -name "*.md" -not -path "./node_modules/*"`), not just `docs/`.

---

## 3. Skill Usage

- Before writing code for a recognizable pattern or domain, check whether a skill exists and apply it.
- `bff-road-routing` is mandatory for all routing work (Rule 1). Skills live in
  `.claude/skills/<name>/SKILL.md`. Packaged `.skill` archives are extracted there and the archive
  removed, so there is one copy.
- If several skills are relevant, apply all of them.
- If no skill exists but one clearly should, flag it so a skill can be created.
- When the design in the skill changes (an open question gets decided, a threshold is fixed),
  update the skill too. It must not drift from the code.

---

## 4. Scope of Documentation Updates

| Change Type | What to Update |
|---|---|
| New/changed internal endpoint | `docs/integration-docs/<name>.md` (request/response/status codes only) + `postman/` file (Rule 10) |
| Changed enrich request/response shape | `docs/integration-docs/track-enrich.md`, old vs. new shape. A breaking change is a `[CONFIRMED]`-worthy `ARCHITECTURE_REVIEW.md` item first |
| Changed app-facing `on_track` fields | Skill `references/contract.md` + "Remaining" list for `ondc-api` and the users app docs (Rule 2) |
| Timeout / threshold / config change | `.env.example`, `docs/internal/routing.md` (tunables table), and `docs/integration-docs/track-enrich.md` if the caller's timeout budget changes |
| New Redis key or TTL | `docs/internal/routing.md` only, never `integration-docs/` |
| OSRM image, profile, extract, refresh, topology | `docs/deployment/osrm.md` + skill `references/osrm-ops.md` |
| Deprecated/removed feature | Mark deprecated with a date in `docs/integration-docs/`; don't silently delete |
| Bug fix | Relevant doc(s). If tracked in `ARCHITECTURE_REVIEW.md`, delete it there and add one line to `docs/CHANGELOG.md` (Rules 6, 8) |

---

## 5. Definition of Done (Local Override)

A task is complete only when:

1. The code change is implemented and follows `CLAUDE.md`.
2. The `bff-road-routing` skill was applied.
3. `npm run typecheck` and `npm test` were run and pass (report actual output).
4. Relevant docs are updated (Rule 4), including a `postman/` file for new routes (Rule 10).
5. The user has confirmed the change works as expected.

---

## 6. Architecture Review Mode

**`docs/ARCHITECTURE_REVIEW.md` is the single source of truth for every planned bug, issue, open
design question, and future integration.** Nothing unresolved lives only in chat, a code comment,
or a stray markdown file.

In review/discussion mode (no code changes):
- All findings go into `docs/ARCHITECTURE_REVIEW.md`, not inline comments or ad-hoc notes.
- Every item has a status tag: `[OPEN]`, `[CONFIRMED]`, `[DEFERRED]`, or `[WONTFIX]`.
- Do NOT implement a fix until the user confirms the item and says "proceed". Move it to
  `[CONFIRMED]` before writing code.
- The app-facing routing fields are additive-only and frozen in shape (`CLAUDE.md` §4). Never
  propose renaming or retyping them.
- Proposals touching Redis key structure, the OSRM profile/extract, or the timeout budget need
  explicit confirmation plus a passing test/smoke run before they count as done.

**HARD RULE — resolving an item:** when an item is fixed, **delete it from
`ARCHITECTURE_REVIEW.md`** (never annotate it in place, because the file only describes what's
still open) and add **exactly one dated one-line entry** to `docs/CHANGELOG.md`'s index: date, tag,
one sentence. A fuller narrative may go below the index or in the relevant `docs/internal/*.md`.

---

## 7. Working Patterns

- Source of truth: **contract -> BFF (order, stage, GPS, path) -> this service -> Redis cache.**
  The cache is derived and disposable.
- Every Redis key needs: (1) a named TTL constant, (2) a documented key pattern in
  `docs/internal/routing.md`, (3) an identified deletion site (explicit delete or TTL-only, stated).
- Every tunable (timeouts, thresholds, sizes) is a named value in `src/config.ts` with a default,
  mirrored in `.env.example` and the tunables table. No magic numbers in routing code.
- Performance changes state the before/after metric (OSRM calls per update, p95 latency, Redis
  ops per update). Never optimize by feel.
- Redundant data or dead code gets flagged in `ARCHITECTURE_REVIEW.md` before removal is proposed.

---

## 8. Changelog Location

The changelog is **`docs/CHANGELOG.md`**: a one-line-per-entry index table at the top (date, tag,
one sentence) for fast scanning, with optional fuller entries below. There is no root
`LEARNINGS.md` in this repo. If a global instruction says to update `LEARNINGS.md`, write to
`docs/CHANGELOG.md` instead.

---

## 9. Suggested Commit Message After Every Meaningful Change

After each meaningful change (a complete, working unit), end the response with a ready-to-run
commit command. Rule 0 still applies: write it, never run it.

- One line, Conventional Commits: `<type>(<scope>): <imperative summary>`, ≤ 72 chars, no trailing
  period, no body, no `Co-Authored-By`. Scopes: `routing`, `osrm`, `cache`, `api`, `ops`, `docs`.
- List files explicitly (never `git add -A`/`.`):

  ```
  git add src/routing/road-path.ts docs/internal/routing.md
  git commit -m "fix(routing): drop points with decreasing timestamps before /match"
  ```

---

## 10. Postman Request File for Every New Route

Every new HTTP route gets a JSON request file in `postman/`, in the same change.

- **Name:** `<METHOD> <path>.json`, path without host but with mount prefix; drop the leading `/`,
  replace `/` with `_`, write params as `{param}`, omit query strings.
  Example: `POST /internal/v1/track/enrich` -> `postman/POST internal_v1_track_enrich.json`.
- **Content:** `method`, `url` (`{{baseUrl}}/...`), `headers`, `query`, `body` (a realistic,
  contract-valid example; `null` for bodiless GET/DELETE).
- **Never put real tokens or `.env` values in these files.** Use `{{placeholders}}`.
- When an existing route's request shape changes, update its file too.
