# Deploying on Render (free tier, NCR only)

_Created 2026-11-10; step-by-step guide rewritten 2026-11-10. For a demo / QA deployment, not for
production tracking (see [Limits](#7-limits-of-the-free-tier))._

Names in Render's and GitHub's web UI change from time to time. If a menu item below is worded
slightly differently, look for the closest match.

---

## 1. What gets deployed

```
┌── Render free Web Service (512 MB RAM, 0.1 CPU) ── public https://<name>.onrender.com ──┐
│  start.sh                                                                               │
│   ├─ osrm-routed  --ip 127.0.0.1 --mmap=1   (NCR road graph baked into the image)       │
│   └─ node dist/index.js  on $PORT (10000)   (osrm-bff: /health, /v1/*, /internal/*)     │
└──────────────┬──────────────────────────────────────────────────────────────────────────┘
               └──► Render Key Value, free (Redis-compatible route cache)
```

- **One container, two programs.** Render can't run Docker inside a service, so `docker compose`
  isn't used there. `ops/render/start.sh` starts OSRM, waits for it, then starts osrm-bff. If OSRM
  dies it's restarted after 10 s, and osrm-bff keeps answering without the routing fields.
- **OSRM stays private.** It has no authentication, so it listens on `127.0.0.1` inside the
  container and nothing outside can reach it. The `X-Internal-Token` header protects **osrm-bff's**
  routes (`ENV=PREPROD`). `/health` is open, which Render's health check and the keep-alive need.
- **No map build on Render.** You build the map once on your machine (`docker compose`). Then
  `ops/render/build-image.sh` copies the finished graph into an image, which you upload to GitHub
  Container Registry. Render only downloads and runs that image.

| File | Role |
|---|---|
| `ops/render/Dockerfile` | The image: OSRM program + Node 22 + osrm-bff + the NCR graph |
| `ops/render/start.sh` | Starts both programs inside the container |
| `ops/render/build-image.sh` | Copies the graph from your local volume, builds the image, optionally pushes it |
| `render.yaml` | Render Blueprint: creates the web service and the Key Value |
| `src/keepalive.ts` | Self-ping of the public `/health` so the free service doesn't fall asleep |

### Measured (2026-11-10, local Docker with `--memory=512m --memory-swap=512m --cpus=0.1`)

| | `OSRM_MMAP=1` (image default) | `OSRM_MMAP=0` |
|---|---|---|
| Container RAM | **45–57 MB** | 490 MB (96%): too close to the limit |
| Start → first route | **~16 s** (OSRM up in 2 s) | ~131 s |
| Route time once warm | 0.2–0.7 s; first cold request ~2 s | similar |

Image size: 368 MB.

---

## 2. Before you start

| You need | Notes |
|---|---|
| A **GitHub account** | It hosts the image (GitHub Container Registry) and the repo Render reads `render.yaml` from |
| This **repo pushed to GitHub** | Render's Blueprint reads `render.yaml` from the repo |
| A **Render account** | <https://render.com>. Connect it to GitHub when Render asks |
| **Docker in WSL** | Where you already run `docker compose`. All commands below run in a **WSL terminal** |
| The **NCR map built locally** | Step 1 checks this |

Open a WSL terminal in the repo folder:

```bash
cd /mnt/c/Users/<windows-user>/Desktop/projects/internship/osrm-bff
```

---

## 3. Step by step

### Step 1: Make sure the local map is NCR only

`build-image.sh` copies the graph from your Docker volume `osrm-bff_osrm-data`, **not** from
`ops/maps/`. The image holds whatever that volume holds. Check what it was built from:

```bash
docker run --rm -v osrm-bff_osrm-data:/data alpine sh -c 'cat /data/.ncr.built; head -1 /data/.ncr.prepped'
```

- The first line is the build time. If it says "No such file", the map isn't built yet: run
  `docker compose -f ops/docker-compose.yml up -d`, wait until
  `docker compose -f ops/docker-compose.yml ps` shows `osrm` as **healthy**, and check again.
- The second line lists the input files after `local:`. **For an NCR-only image it must list only
  the NCR file** (e.g. `planet_76.75,28.2_77.8,28.95.osm.pbf`).

If a Bengaluru file is listed, or you're about to run `docker compose up` while a Bengaluru `.pbf`
is in `ops/maps/`, the volume holds Bengaluru too. That makes the image bigger, and the extra city
goes unused (this image only routes NCR). To get an NCR-only volume:

1. Move the Bengaluru `.pbf` out of `ops/maps/` (anywhere outside the repo).
2. `docker compose -f ops/docker-compose.yml up -d`. The changed inputs trigger a rebuild, which
   takes a few minutes. Wait for `osrm` to be **healthy**.
3. Build the image (steps 3–4). After that you can put the Bengaluru file back for local work.

### Step 2: Create a GitHub token

The token is the password Docker uses to **upload** the image to GitHub Container Registry
(`ghcr.io`). Render may also need one to **download** it (step 6).

1. GitHub → your avatar → **Settings** → **Developer settings** → **Personal access tokens** →
   **Tokens (classic)** → **Generate new token (classic)**. Use a classic token: GitHub Container
   Registry works with classic tokens.
2. Note: `osrm-bff ghcr push`. Expiration: your choice (you'll need a new one when it expires).
3. Scopes: tick **`write:packages`** (this also ticks `read:packages`).
4. **Generate token** and copy it now; GitHub shows it only once.

Treat it like a password: don't commit it, don't paste it into chats or tickets.

### Step 3: Log in to GitHub Container Registry

```bash
export GHCR_USER=<your-github-username-in-lowercase>
read -s GHCR_TOKEN        # paste the token, press Enter (nothing is shown)
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
```

Expected: `Login Succeeded`. **Image names must be lowercase.** If your GitHub username has capital
letters, write it in lowercase here and in the image name.

### Step 4: Build and push the image

Use the date as the tag, so every map refresh gets a new, traceable version:

```bash
export IMAGE=ghcr.io/$GHCR_USER/osrm-bff-render:$(date -u +%Y-%m-%d)
PUSH=1 bash ops/render/build-image.sh "$IMAGE"
echo "$IMAGE"             # keep this: it goes into render.yaml
```

What it does and prints:
1. `copying the built ncr graph from volume osrm-bff_osrm-data` and `map built <time>`. If it says
   `no built map in the volume`, go back to step 1.
2. `graph: ~600M`: the graph files it copied.
3. The Docker build (a few minutes the first time), ending with `built <image> (368 MB)`.
4. The push to `ghcr.io` (uploads a few hundred MB).

The image now appears on GitHub under your profile → **Packages** → `osrm-bff-render`.

### Step 5: Test the image with the free tier's limits (recommended)

This runs the image exactly as Render will, with the same memory and CPU limits:

```bash
docker run --rm --name render-test -p 127.0.0.1:4300:10000 \
  --memory=512m --memory-swap=512m --cpus=0.1 \
  -e INTERNAL_TOKEN=local-test-token "$IMAGE"
```

In a **second** WSL terminal:

```bash
curl http://127.0.0.1:4300/health
# {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:4300/v1/route?from=28.4950,77.0886&to=28.4595,77.0266"
# 401  (no token: correct)
curl -H 'X-Internal-Token: local-test-token' "http://127.0.0.1:4300/v1/route?from=28.4950,77.0886&to=28.4595,77.0266"
# {"from":"28.495,77.0886","to":"28.4595,77.0266","polyline":"…","distance_m":…,"duration_s":…}
docker stats --no-stream render-test
# MEM USAGE well under 512 MiB
```

The first route can take ~2 s while OSRM reads the map from disk; later ones are faster. In the
first terminal, the log shows `[start] osrm-routed is up`, then `listening` with `"env":"PREPROD"`.
Redis errors in this test are expected: there's no Redis here, and it's treated as a cache miss.
Stop the test with **Ctrl+C**.

### Step 6: Decide who can download the image

New packages on GitHub Container Registry are **private**.

| Choice | How | Trade-off |
|---|---|---|
| **Keep it private** (recommended for company code) | Add a registry credential in Render (below) | One extra setup step |
| Make it public | GitHub → Packages → `osrm-bff-render` → **Package settings** → **Change visibility** → Public | Anyone can download the image and read the compiled code. No secrets are inside (`.dockerignore` keeps `.env` out; the token comes from Render at run time) |

**For a private package, add a registry credential in Render:**
1. Create another classic GitHub token with only **`read:packages`** (so Render can't upload or
   delete anything).
2. Render dashboard → **Settings** (workspace settings) → **Registry Credentials** → **Add
   Registry Credential**.
3. Registry: **GitHub**. Name: `ghcr`. Username: your GitHub username. Token: the `read:packages`
   token. Save.

### Step 7: Edit `render.yaml`

Open `render.yaml` in the repo root and:

1. Set `image.url` to the `$IMAGE` value from step 4, e.g.
   `ghcr.io/<you>/osrm-bff-render:2026-11-10`.
2. **Private package:** uncomment the `creds` block. Its `name` must match the credential name from
   step 6 (`ghcr`):
   ```yaml
       image:
         url: ghcr.io/<you>/osrm-bff-render:2026-11-10
         creds:
           fromRegistryCreds:
             name: ghcr
   ```
3. Region: `singapore` is the closest to India. **A region can't be changed after creation**, and
   the web service and Key Value must be in the same region (they are, in the file).

### Step 8: Push `render.yaml` to GitHub

Render reads the Blueprint from the repo, so commit and push it (run these yourself):

```bash
git add render.yaml
git commit -m "chore(ops): point render.yaml at the osrm-bff-render image"
git push
```

### Step 9: Create the services from the Blueprint

1. Render dashboard → **New** → **Blueprint**.
2. Connect GitHub if asked, pick this repository and the branch you pushed to.
3. Render reads `render.yaml` and lists what it will create:
   - **`osrm-bff`**: web service, free, from your image;
   - **`osrm-bff-cache`**: Key Value, free.

   If it reports a problem in the file, fix that field and push again. The `creds`,
   `maxmemoryPolicy` and `ipAllowList` fields were written from Render's spec but not yet
   validated by a real Render deploy. If you'd rather skip the Blueprint, use the
   [manual alternative](#5-manual-alternative-without-the-blueprint).
4. It asks for **`LOGISTICS_BASE_URL`** (the ondc-logistics-api base URL, e.g.
   `https://<logistics-host>`). If there's no reachable logistics API yet, enter a placeholder and
   change it later. Until then `POST /v1/track` answers 503 (`LOGISTICS_UNAVAILABLE`); everything
   else works.
5. **Apply.** Render creates the Key Value, then pulls the image (~368 MB) and starts it. The first
   deploy takes a few minutes; startup itself is ~20 s.
6. Wait until the service shows **Live**. Render's health check calls `/health`.

### Step 10: Get the URL and the token

- **URL:** at the top of the `osrm-bff` service page, `https://<name>.onrender.com`.
- **Token:** service → **Environment** → `INTERNAL_TOKEN` (Render generated it) → reveal and copy.

Give the token only to the logistics API (step 12) and QA builds. **Never to a release build of the
app**: anything inside an app can be extracted.

### Step 11: Verify the deployment

```bash
export URL=https://<name>.onrender.com
export T=<INTERNAL_TOKEN>

curl $URL/health
# {"status":"ok"}                                      (no token needed)

curl -s -o /dev/null -w '%{http_code}\n' "$URL/v1/route?from=28.4950,77.0886&to=28.4595,77.0266"
# 401                                                  (token enforced)

curl -H "X-Internal-Token: $T" "$URL/v1/route?from=28.4950,77.0886&to=28.4595,77.0266"
# 200 with a polyline: OSRM works inside the container

curl $URL/metrics
# osrm.route.outcomes.ok > 0
```

**Live tracking end to end, simulating the logistics API.** In one terminal, open the frontend's
stream:

```bash
curl -N -H "X-Internal-Token: $T" $URL/v1/orders/render-test-1/track/events
# retry: 3000
# : connected
```

In another terminal, send an `/on_track` the way logistics will:

```bash
curl -X POST $URL/internal/v1/logistics/on_track \
  -H 'Content-Type: application/json' -H "X-Internal-Token: $T" \
  -d '{"orderId":"render-test-1","gps":"28.497671,77.088763","status":"active",
       "path":[{"lat_lng":"28.495340,77.088059","sequence":"1"},{"lat_lng":"28.497671,77.088763","sequence":"2"}],
       "fulfillmentState":"Order-picked-up","startGps":"28.495340,77.088059","endGps":"28.459469,77.026635"}'
# {"accepted":true}
```

Within ~3 s the first terminal prints `event: track_update` with `route_ahead`, `road_path` and
`drop_gps`. Then `curl -H "X-Internal-Token: $T" $URL/v1/orders/render-test-1/track` returns the
same update (that needs Redis, so it also proves the Key Value connection).

**Logs** (service → **Logs**) should show, in this order:
```
[start] starting osrm-routed (--mmap=1) on 127.0.0.1:5000
[start] osrm-routed is up after … s
[start] starting osrm-bff on port 10000
… "msg":"listening","env":"PREPROD","token_required":true …
… "scope":"keepalive","msg":"started","url":"https://<name>.onrender.com/health" …
… "scope":"redis","msg":"ready"
```

### Step 12: Connect the logistics API and the frontend

- **ondc-logistics-api** (when its change from `LOGISTICS_API_CHANGES.md` is in):
  `OSRM_BFF_URL=https://<name>.onrender.com`, `OSRM_BFF_TOKEN=<INTERNAL_TOKEN>`.
- **Frontend (QA builds only):** base URL `https://<name>.onrender.com`, header
  `X-Internal-Token: <INTERNAL_TOKEN>`. Contract: `docs/integration-docs/track.md`. The browser's
  built-in `EventSource` can't send headers. Use `react-native-sse` (React Native) or a fetch-based
  SSE client.

---

## 4. Updating

Image-backed services **don't redeploy on their own**. Every update is: build a new image, push it
with a new tag, point Render at the new tag.

**New code, or a refreshed map (weekly):**
1. For a map refresh: put fresh NCR files in `ops/maps/` (or remove them to download), then
   `docker compose -f ops/docker-compose.yml up -d` and wait for **healthy** (step 1 again).
2. Build and push with a new tag:
   ```bash
   export IMAGE=ghcr.io/$GHCR_USER/osrm-bff-render:$(date -u +%Y-%m-%d)
   PUSH=1 bash ops/render/build-image.sh "$IMAGE"
   ```
   Same day twice? Add a suffix, e.g. `…:2026-11-10b`.
3. Render → `osrm-bff` → **Settings** → **Image** → set the new URL → save → **Manual Deploy** →
   **Deploy latest reference** (or the deploy that the save offers).
4. Update `image.url` in `render.yaml` too, and push it, so the file matches what's running.

Each deploy restarts the container. Open streams close, clients reconnect after 3 s and get the
latest update first. Expect ~20 s without routing while OSRM starts.

**Optional automation:** service → **Settings** → **Deploy Hook** gives a secret URL that starts a
deploy when called. Render's docs describe passing the image URL to it for image-backed services;
check them before scripting it.

**Rollback:** set the image URL back to the previous tag and deploy. Old tags stay in GitHub
Packages until you delete them.

---

## 5. Manual alternative (without the Blueprint)

1. **New** → **Key Value** → name `osrm-bff-cache`, plan **Free**, region **Singapore**, eviction
   policy `allkeys-lru` → create → copy its **Internal URL** (`redis://…`).
2. **New** → **Web Service** → **Existing image** → image URL from step 4 (+ the `ghcr`
   credential if private) → name `osrm-bff`, region **Singapore**, instance type **Free**.
3. **Environment variables:**

   | Key | Value |
   |---|---|
   | `ENV` | `PREPROD` |
   | `INTERNAL_TOKEN` | a random value, e.g. from `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `REDIS_URL` | the Key Value's Internal URL |
   | `LOGISTICS_BASE_URL` | the logistics API base URL |

4. **Health Check Path:** `/health`. Create, then continue with step 10.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Deploy fails pulling the image: `unauthorized` / `denied` / `not found` | Private package without a credential, wrong credential, or a typo in the URL | Step 6 credential with `read:packages`; check the URL matches what you pushed (lowercase) |
| `repository name must be lowercase` when building/pushing | Capital letters in the image name | Use your GitHub username in lowercase |
| Logs: `ENV=PREPROD requires INTERNAL_TOKEN`, deploy fails | `INTERNAL_TOKEN` not set | Set it under Environment (the Blueprint generates it) |
| Every `/v1/*` call returns 401 | Missing or wrong `X-Internal-Token` | Copy the token again from Environment |
| `/v1/route` returns 503 `ROUTING_UNAVAILABLE` right after a deploy | OSRM still starting (~20 s), or the first cold request | Retry after a minute; check the `[start] osrm-routed is up` log line |
| Logs repeat `osrm-routed exited … restarting in 10 s` | OSRM can't start (e.g. graph missing or corrupt) | Rebuild the image (steps 1–4); make sure the build printed `graph: ~600M` |
| Container restarts; Render shows out-of-memory | `OSRM_MMAP` was turned off | Remove any `OSRM_MMAP=0` override; the image default is `1` |
| Logs repeat `scope":"redis","msg":"error"` | The free web service can't reach Key Value's internal URL | Use the Key Value's **External** URL in `REDIS_URL` and allow the service's outbound IPs in its access control. Without Redis everything still works except "latest update on reconnect" |
| `POST /v1/track` returns 503 `LOGISTICS_UNAVAILABLE` | `LOGISTICS_BASE_URL` wrong, or the logistics API down | Fix the variable; check the logistics API from your machine |
| Service sleeps anyway | Keep-alive not running or failing | Logs should show `keepalive started` with your public URL; `ping failed` lines show why. `RENDER_EXTERNAL_URL` is set by Render; `KEEPALIVE_URL` overrides it |
| Bengaluru routes return 422 `OUT_OF_COVERAGE` | Expected: this image is NCR only | — |

---

## 7. Limits of the free tier

| Limit | Effect | Mitigation |
|---|---|---|
| Sleeps after ~15 min without inbound traffic; ~1 min to wake | Streams drop; the logistics webhook (2 s timeout) fails while asleep | **Built-in keep-alive:** pings the public `/health` every 10 min. It keeps a running instance awake but can't wake a sleeping one |
| Free instance hours per month | Running 24/7 uses nearly all of them, so nothing else free can run all month | Watch usage in the dashboard |
| 0.1 CPU | Slower routes (a cross-NCR route ~1.2 s) | The image's 2.5 s OSRM timeout |
| Deploys / restarts | Open streams close | Clients reconnect after 3 s and get the latest update first |
| One instance | Required anyway: streams live in memory (`ARCHITECTURE_REVIEW.md` SCALE-02) | Don't scale out |
| Free Key Value: 25 MB, no persistence | Cache lost on restart | Fine: the cache is disposable |

**Caller budget on this deployment:** a `track_update` can arrive up to ~3 s after the `/on_track`,
still well inside the ~15 s tracking cadence. A BFF calling `/internal/v1/track/enrich` with a
1.5 s timeout may get cut off on long routes. Raise its timeout to ~3 s, or accept omitted fields.

Render may change its free-tier rules; check them before relying on this.

---

## 8. Settings specific to this image

Set in `ops/render/Dockerfile`; Render's environment variables override them.

| Variable | Image default | Why |
|---|---|---|
| `ENV` | `PREPROD` | Token required |
| `PORT` | `10000` | Render's default |
| `OSRM_BASE_URL` | `http://127.0.0.1:5000` | OSRM in the same container |
| `OSRM_MAP` | `/data/ncr.osrm` | The baked graph |
| `OSRM_MMAP` | `1` | Fits in 512 MB (see the measurements) |
| `OSRM_TIMEOUT_MS` / `ENRICH_DEADLINE_MS` | `2500` / `3000` | 0.1 CPU (repo defaults stay 1000 / 1200) |
| `COVERAGE_BBOX` | `76.75,28.20,77.80,28.95` | NCR only, matching the baked map |
| `DEV_VIEWER_ENABLED` | `false` | No dev page on a public URL |
| `REDIS_KEY_PREFIX` | `osrm-bff:render:` | |
| `OSRM_START_TIMEOUT_S` | `120` (in `start.sh`) | How long to wait for OSRM before starting osrm-bff anyway |
| `KEEPALIVE_URL` | unset → `RENDER_EXTERNAL_URL` + `/health` | Self-ping target; `none` turns it off |
| `KEEPALIVE_INTERVAL_MS` | `600000` (10 min) | Under Render's ~15 min idle limit |
