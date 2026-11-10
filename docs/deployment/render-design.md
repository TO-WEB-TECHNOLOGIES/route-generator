# Render deployment: why it's built this way

_Created 2026-11-10. Companion to [`render.md`](render.md), which has the step-by-step guide. This
file explains **what** each piece of the Render setup is, **why** it's needed, and **which
alternatives** exist, so the choices can be revisited when the constraints change (for example,
moving to a paid plan)._

---

## 1. The constraints everything follows from

| # | Constraint | Source |
|---|---|---|
| C1 | **OSRM has no authentication.** Anyone who can reach it can use it, so it must never be publicly reachable | `CLAUDE.md` §7 |
| C2 | **osrm-bff needs a running OSRM next to it.** It doesn't read map files; it asks OSRM over HTTP (`/route`, `/match`) | `src/osrm/client.ts` |
| C3 | **Building the map graph needs several GB of RAM** (`osrm-extract`, `osrm-partition`, `osrm-customize`). Locally it failed with exit code 137 until WSL had 6 GB | `docs/deployment/osrm.md` |
| C4 | **Render's free tier** offers only *web services*: public, 512 MB RAM, 0.1 CPU, no persistent disk, asleep after ~15 min without traffic. *Private services* (not public) exist only on paid plans | Render docs, read 2026-11-10 |
| C5 | **Render runs containers but can't run Docker inside them** (no `docker compose` on Render) | Render docs |
| C6 | **An image-based Render service doesn't redeploy by itself.** A new image means a manual deploy, or a deploy hook | Render docs |
| C7 | **Live tracking keeps open streams in memory**, so only **one** osrm-bff instance may run | `docs/ARCHITECTURE_REVIEW.md` SCALE-02 |

---

## 2. The decisions

### D1. OSRM and osrm-bff in **one container**

- **What:** `ops/render/start.sh` starts `osrm-routed` on `127.0.0.1:5000`, then osrm-bff on Render's
  port. Both run in the same container.
- **Why:** on the free tier everything has to be a public web service (C4), but OSRM must not be
  public (C1). Inside one container, OSRM can listen on `127.0.0.1`, which nothing outside the
  container can reach. osrm-bff still reaches it (C2).
- **Necessary?** Yes, on the free tier.
- **Alternatives:**

  | Alternative | Why not (now) |
  |---|---|
  | OSRM as a separate **private service**, osrm-bff as a web service | The cleanest split, but private services are paid (C4). **The recommended production setup** |
  | OSRM as its own public web service, protected some other way (a proxy with a token) | More moving parts, two free services sharing the free hours, and OSRM's port is still public unless the proxy is perfect |
  | OSRM on another host (EC2, a VM) | Possible, but then OSRM is reachable over the internet and needs a firewall that only lets Render in |

### D2. The map graph **baked into the image**, built on your machine

- **What:** you build the graph locally with `docker compose` (the step that needs several GB).
  `ops/render/build-image.sh` then copies the finished `ncr.osrm.*` files into the image.
- **Why:** the build needs more RAM than the free tier has (C3, C4). Render doesn't document how much
  memory its image builds get. There's no disk to keep a graph between restarts (C4). And a 198 MB
  graph file can't go into git (GitHub's limit is 100 MB per file).
- **Necessary?** Some way of getting a ready-made graph to Render is. Baking it into an image is the
  simplest one that works on the free tier.
- **Alternatives:**

  | Alternative | Trade-off |
  |---|---|
  | **Render builds from a Dockerfile in the repo** and builds the map during the build | Code changes would deploy on every `git push`. But it downloads ~280 MB of maps and needs several GB of RAM on **every** build, with undocumented build limits. Risky |
  | **Render builds from the repo; the Dockerfile downloads a prebuilt graph** (e.g. a GitHub Release asset uploaded weekly) | Code deploys on every push, and the map refreshes by uploading a new file. A private repo needs a download token at build time. **The best upgrade if code changes often** |
  | A Render **disk** with the graph, built at startup | Disks are paid. A service with a disk can't do zero-downtime deploys. Startup would need the build RAM (C3) |
  | Commit the graph to git (Git LFS) | LFS storage and bandwidth quotas; the graph is ~600 MB per refresh |

### D3. A **registry** (GitHub Container Registry) to hand the image to Render

- **What:** `docker push` to `ghcr.io/<you>/osrm-bff-render:<date>`. Render pulls it on each deploy.
- **Why:** Render can't take an image from your laptop. It downloads it from a registry. GHCR is
  free with the GitHub account you already have.
- **The GitHub token:** pushing needs a token with `write:packages`. If the package is **private**,
  Render needs a separate one with `read:packages`, added as a registry credential.
- **Private or public?** The image contains the compiled code and the map (public OpenStreetMap
  data), but no secrets: `.dockerignore` keeps `.env` out, and tokens come from Render at run time.
  Private protects the code; public avoids the credential and GitHub's quota.
- **Watch the quota:** GitHub's free allowance for *private* packages is small (about 500 MB storage
  and 1 GB downloads a month; check your plan). Every Render deploy downloads the whole image
  (~370 MB). Delete old versions after a refresh, or make the package public.
- **Alternatives:** Docker Hub (one free private repository), GitLab, Google Artifact Registry, AWS
  ECR (its passwords expire after 12 hours, which is awkward for Render).

### D4. **`--mmap=1`** for OSRM

- **What:** OSRM reads the map from disk as needed instead of loading all of it into memory.
- **Why:** measured at 512 MB / 0.1 CPU: **490 MB (96%) without it**, which is one traffic spike
  away from being killed for memory, and **45–57 MB with it**. Startup also went from ~131 s to ~16 s.
- **Necessary?** On 512 MB, yes.
- **Trade-off:** the **first** request after a start is slow (one took 3.1 s), because the map data
  is read from disk the first time. A warm-up request at startup is proposed to absorb it.
- **Alternatives:** a paid instance with 2 GB (no `--mmap` needed), or a smaller map.

### D5. **Longer OSRM timeouts** in this image (2.5 s / 3 s instead of 1 s / 1.2 s)

- **What:** the image sets `OSRM_TIMEOUT_MS=2500` and `ENRICH_DEADLINE_MS=3000`. The repo defaults
  are unchanged.
- **Why:** at 0.1 CPU a cross-NCR route took ~1.2 s and failed against the 1 s timeout. With 2.5 s,
  every test route answered.
- **Trade-off:** a live `track_update` can arrive up to ~3 s after the `/on_track`. That's fine for a
  ~15 s cadence. A caller of `/internal/v1/track/enrich` with a 1.5 s timeout may get cut off.
- **Alternatives:** keep 1 s and accept that long routes are left out more often; a paid instance.

### D6. **Keep-alive** self-ping

- **What:** osrm-bff GETs its own **public** `/health` every 10 min (`src/keepalive.ts`). On Render
  it switches on by itself, using `RENDER_EXTERNAL_URL`.
- **Why:** free services sleep after ~15 min without inbound traffic (C4). Asleep, the logistics
  webhook fails (2 s timeout) and live streams drop.
- **Why the public URL:** a request to `localhost` never passes Render's proxy, so it doesn't count
  as traffic.
- **Limits:** it keeps a running instance awake but can't wake a sleeping one. Running 24/7 uses
  nearly all of the free monthly hours. Render may change its free-tier rules.
- **Alternatives:** an external uptime monitor (e.g. a free uptime service hitting `/health`); a
  paid instance, which never sleeps.

### D7. **`start.sh`** instead of a process manager

- **What:** a small bash script starts OSRM, restarts it if it dies, starts Node, and forwards
  Render's stop signal so Node can close streams cleanly before OSRM stops.
- **Why:** Render runs one start command per container (C5). The OSRM base image is Debian 11,
  whose package repositories are gone, so tools like `supervisord` can't be installed.
- **Behavior on failure:** if OSRM dies, osrm-bff keeps answering without routing fields. That's the
  project's main rule: routing is decoration, the GPS update is the product.

### D8. **`ENV=PREPROD`** and the token

- **What:** the image defaults to `ENV=PREPROD`. Every `/v1/*` and `/internal/*` call needs
  `X-Internal-Token`, and the service refuses to start without `INTERNAL_TOKEN`.
- **Why:** the URL is public (C4). Without the token, anyone could use the routing and post fake
  tracking updates.
- **Open routes:** `/`, `/health` (Render's health check and the keep-alive need it) and `/metrics`
  (counters only, no personal data).
- **Limit:** a shared token is fine for the logistics API and QA builds. **It must never ship in a
  release app.** Real app login is still open (`docs/ARCHITECTURE_REVIEW.md` INT-04).

### D9. **Blueprint** (`render.yaml`): optional

- **What:** one file that creates the web service and the Key Value, already wired together.
- **Why:** repeatable and reviewable in git. It also generates the token and fills in `REDIS_URL`.
- **Necessary?** No. The dashboard gets the same result (`render.md`, section 5).

### D10. **NCR only** in the Render image

- **What:** the image's `COVERAGE_BBOX` is the NCR box, and it should be built from an NCR-only map.
- **Why:** a smaller image (~370 MB instead of an estimated 550–650 MB for two cities). That means
  faster deploys and less of GitHub's quota.
- **Alternative:** a two-city image with Bengaluru coverage switched on. RAM should still fit with
  `--mmap`, but that hasn't been measured. Building both cities while coverage stays NCR-only wastes
  space for nothing.

### D11. **Redis**: Render Key Value or Upstash (open)

- **Render Key Value (free):** created by the Blueprint, internal URL. Unconfirmed whether a free web
  service can reach it over Render's private network.
- **Upstash (what the local `.env` points to):** reachable from anywhere. It **requires TLS**: the URL
  must start with `rediss://`, not `redis://` (`redis://` fails; tested 2026-11-10). Measured 32–72 ms
  per command from the dev machine, within the 200 ms Redis timeout. Check its free command limit:
  each GPS update uses about 4–6 commands.
- **Either way:** Redis down just means cache misses. Only "latest update on reconnect" stops working.

---

## 3. All deployment options at a glance

| Option | Cost on Render | Code deploys | Map refresh | Good for |
|---|---|---|---|---|
| **A. One free web service from a prebuilt image** (current) | Free | Manual: build, push, deploy | Same | Demo / QA |
| B. Render builds from a Dockerfile, map built during the build | Free / paid | On every `git push` | On every build | Risky (C3) |
| **C. Render builds from a Dockerfile, prebuilt graph downloaded at build time** | Free / paid | On every `git push` | Upload a new graph file | QA with frequent code changes |
| **D. osrm-bff web service + OSRM private service** | Paid (two instances) | On every `git push` (osrm-bff) | New OSRM image | **Production** |
| E. Native Node runtime (no Docker) for osrm-bff, OSRM elsewhere | Free / paid | On every `git push` | Elsewhere | Only if OSRM already has a home |
| Outside Render: one EC2 `t3.small` (2 GB) with `docker compose` | ~USD 15–20/month (approximate) | Your own pipeline | `docker compose` on the box | Production on AWS |

---

## 4. Moving to production later

- **Hosting:** option D on Render (OSRM private service on a 2 GB plan, osrm-bff on Starter), or
  one EC2 `t3.small`. Neither needs `--mmap` or the long timeouts, and neither sleeps, so the
  keep-alive can be turned off (`KEEPALIVE_URL=none`).
- **App login** instead of the shared token (INT-04).
- **More than one osrm-bff instance** needs streams shared through Redis first (SCALE-02).
- **Who refreshes the map weekly** is still undecided (ROUTE-02).

## 5. Proposed, not built yet

- An OSRM **warm-up** request in `start.sh`, so the first real request after a start isn't the slow one.
- **Quieter Redis logs:** one line when the connection drops and one when it's back, instead of one
  per retry.
- **`prep.sh`:** copy map files into the volume before clipping (fixes "Cannot allocate memory" on WSL).
