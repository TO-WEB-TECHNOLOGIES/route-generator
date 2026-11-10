# Calling the API: base URL, token, endpoints

_Created 2026-11-10. A practical guide for anyone calling osrm-bff by hand or from code: QA, the
frontend team, the logistics team. Field-by-field contracts are in the per-endpoint docs linked
below._

---

## 1. Base URL

| Where it runs | Base URL |
|---|---|
| Your machine (`npm run dev`) | `http://127.0.0.1:4100`. Use `127.0.0.1`, not `localhost` (on Windows, `localhost` can resolve to IPv6 and fail) |
| Render | `https://<service-name>.onrender.com`, shown at the top of the service page in Render |

Every path below is appended to the base URL, e.g. `https://<service-name>.onrender.com/v1/route`.

**Not port 5000.** That's the internal routing engine (OSRM), not this API. It answers every one
of our paths with `{"code":"InvalidUrl"}`, and on Render it isn't reachable at all.

## 2. The token

| Server setting | Token needed? |
|---|---|
| `ENV=TEST` (local development) | **No.** Every route works without it |
| `ENV=PREPROD` (Render, shared environments) | **Yes**, on every `/v1/*` and `/internal/*` route |

- **Send it as a header:** `X-Internal-Token: <token>`. A query parameter or cookie doesn't work.
- **Where to get it:** from whoever runs the service. On Render: service → **Environment** →
  `INTERNAL_TOKEN`. Locally: `INTERNAL_TOKEN` in the service's `.env`.
- **Missing or wrong token:** `401 {"error":"unauthorized"}`.
- **Keep it secret.** Don't put it in URLs, screenshots, tickets or a release build of the app.
  It's meant for the logistics API and QA builds only.

## 3. Endpoints

| Method + path | Token (PREPROD) | What it's for | Contract |
|---|---|---|---|
| `GET /` or `GET /health` | no | Is the service up? `{"status":"ok"}` | — |
| `GET /metrics` | no | Counters: routing calls, errors, latency, open streams | — |
| **`GET /v1/route?from=…&to=…`** | yes | **Road route between two points** (section 4) | [route.md](route.md) |
| `POST /v1/track` | yes | Ask for a fresh rider position (forwarded to the logistics API) | [track.md](track.md) |
| `GET /v1/orders/{orderId}/track` | yes | The latest tracking update for an order | [track.md](track.md) |
| `GET /v1/orders/{orderId}/track/events` | yes | Live stream of tracking updates (SSE) | [track.md](track.md) |
| `POST /internal/v1/track/enrich` | yes | Routing fields for one GPS update (server-to-server) | [track-enrich.md](track-enrich.md) |
| `POST /internal/v1/logistics/on_track` | yes | Where the logistics API forwards each `/on_track` | `LOGISTICS_API_CHANGES.md` |
| `GET /dev/route-viewer` | no | Map page for trying things out. **Only with `ENV=TEST`** (off on Render) | — |

---

## 4. Getting a route between two points

```
GET {base}/v1/route?from=<lat>,<lng>&to=<lat>,<lng>
X-Internal-Token: <token>          (only with ENV=PREPROD)
```

| Query param | Format | Example |
|---|---|---|
| `from` | `latitude,longitude`, **latitude first**, decimal degrees | `28.4950,77.0886` |
| `to` | same | `28.4595,77.0266` |

**Covered area:** Delhi NCR (Delhi, Gurugram, Noida, Ghaziabad). A local setup with the Bengaluru
map also covers Bengaluru. The Render deployment is NCR only. Points outside get `422
OUT_OF_COVERAGE`.

**Getting coordinates:** in Google Maps, right-click a place. The first line of the menu is
`latitude, longitude`; click it to copy, then remove the space after the comma.

### 4.1 Examples

**curl (bash / WSL / macOS / Linux):**
```bash
BASE=https://<service-name>.onrender.com
TOKEN=<token>

curl -H "X-Internal-Token: $TOKEN" "$BASE/v1/route?from=28.4950,77.0886&to=28.4595,77.0266"
```
Keep the quotes around the URL: without them the shell treats `&` as "run in background".

**PowerShell (Windows):**
```powershell
$base = "https://<service-name>.onrender.com"
$headers = @{ "X-Internal-Token" = "<token>" }

Invoke-RestMethod -Uri "$base/v1/route?from=28.4950,77.0886&to=28.4595,77.0266" -Headers $headers
```
In Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe` if you want
the real curl with the bash syntax above.

**Browser address bar:** works only **without** a token (local `ENV=TEST`), because a browser can't
add the header by itself:
```
http://127.0.0.1:4100/v1/route?from=28.4950,77.0886&to=28.4595,77.0266
```

**Postman:**
1. Select an environment that has `baseUrl` (and `internalToken` for PREPROD). The repo has
   `postman/environments/osrm-bff-local.environment.yaml` (local) and
   `osrm-bff-render.environment.yaml` (Render: fill in your service URL and the token).
2. The collection's **`02 route`** folder has ready-made requests for each city. For your own pair:
   `GET {{baseUrl}}/v1/route?from=…&to=…` with the header `X-Internal-Token: {{internalToken}}`.

**JavaScript / TypeScript (server side, or a QA build):**
```ts
const res = await fetch(`${BASE}/v1/route?from=28.4950,77.0886&to=28.4595,77.0266`, {
  headers: { "X-Internal-Token": TOKEN },
});
if (!res.ok) {
  const { error } = await res.json();          // { code, message }, see 4.3
  // every error → draw a straight dashed line instead
} else {
  const route = await res.json();              // see 4.2
}
```

### 4.2 The answer

```json
{
  "from": "28.495,77.0886",
  "to": "28.4595,77.0266",
  "polyline": "{n|lDkgouMn@f@BN?LGNYPSHe@d@M?kAeASQk@o@…",
  "distance_m": 9507,
  "duration_s": 713
}
```

| Field | Meaning |
|---|---|
| `from`, `to` | The points used, normalized (`28.4950` → `28.495`) |
| `polyline` | The road line, **Google encoded polyline, precision 5**. Decode it to draw it (4.4) |
| `distance_m` | Road distance in metres |
| `duration_s` | Driving-time estimate in seconds (car profile). Display-only, not an official ETA |

The line starts and ends on the nearest road to each point. That can be a few tens of metres away
when a point is inside a building or campus.

### 4.3 Errors

The body is `{ "error": { "code": "…", "message": "…" } }`. For every error, an app should simply
draw a straight line.

| Status | `error.code` | Meaning | What to check |
|---|---|---|---|
| 400 | `INVALID_POINT` | `from` or `to` missing or not `lat,lng` | Both params present, comma-separated, no spaces |
| 401 | — (`{"error":"unauthorized"}`) | Token missing or wrong | The `X-Internal-Token` header |
| 422 | `OUT_OF_COVERAGE` | A point is outside the covered area | **Swapped latitude and longitude** (the most common cause), or a city that isn't covered |
| 404 | `NO_ROUTE` | No road route between the points, a point more than 200 m from any road, or one point in NCR and the other in Bengaluru | Points on or near a road, both in the same city |
| 503 | `ROUTING_UNAVAILABLE` | The routing engine is down, starting, or slow | Retry after a few seconds. On Render, the first request after a restart can be slow |

### 4.4 Showing the route

- **Quick look:** paste the `polyline` value into Google's *Interactive Polyline Encoder Utility*
  (search for that name) to see it drawn on a map.
- **Locally:** `http://127.0.0.1:4100/dev/route-viewer` (`ENV=TEST` only) draws routes for two points
  you click.
- **In code:** decode with **precision 5**. You get `[latitude, longitude]` pairs:
  ```ts
  import polyline from "@mapbox/polyline";
  const points = polyline.decode(route.polyline, 5);   // [[28.495, 77.0886], …]
  ```
  Leaflet and Google Maps take `latitude, longitude` as is. **MapLibre, Mapbox GL and GeoJSON want
  `[longitude, latitude]`**, so flip each pair for them. A line that lands in the ocean means a
  flipped pair or a precision-6 decode.

### 4.5 Ready-to-use pairs

All tested against the NCR map.

| Route | `from` | `to` | Road distance |
|---|---|---|---|
| Gurugram: Cyber Hub → Sector 29 | `28.4950,77.0886` | `28.4595,77.0266` | ~7–13 km |
| Delhi: India Gate → Connaught Place | `28.6129,77.2295` | `28.6315,77.2167` | ~2–6 km |
| Noida: Sector 18 → Sector 62 | `28.5700,77.3260` | `28.5355,77.3910` | ~7–15 km |
| Ghaziabad: Raj Nagar → Vaishali | `28.6692,77.4538` | `28.6448,77.3390` | ~10–22 km |
| Cross-state: Gurugram → Noida | `28.4595,77.0266` | `28.5355,77.3910` | ~35–60 km |
| Bengaluru: MG Road → Koramangala (not on the Render image) | `12.9740,77.6134` | `12.9352,77.6245` | ~3–12 km |
| **Error example:** swapped lat/lng → 422 | `77.0886,28.4950` | `28.4595,77.0266` | — |

---

## 5. Other quick calls

```bash
# Is it up? (no token)
curl $BASE/health

# Counters (no token)
curl $BASE/metrics

# Latest tracking update for an order
curl -H "X-Internal-Token: $TOKEN" $BASE/v1/orders/<orderId>/track

# Live stream for an order (-N: print events as they arrive; Ctrl+C to stop)
curl -N -H "X-Internal-Token: $TOKEN" $BASE/v1/orders/<orderId>/track/events

# Ask for a fresh position (forwarded to the logistics API)
curl -X POST -H "X-Internal-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"orderId":"<orderId>"}' $BASE/v1/track
```

Request bodies and responses for these are in [track.md](track.md) and
[track-enrich.md](track-enrich.md).

---

## 6. Common problems

| Symptom | Likely cause |
|---|---|
| `{"code":"InvalidUrl"}` | You called the routing engine's port 5000 instead of the API |
| `401` everywhere | Token missing, wrong, or sent as a query parameter instead of the header |
| `422 OUT_OF_COVERAGE` on a point you're sure is in Delhi | Latitude and longitude swapped |
| First request on Render takes ~1 min | The free service was asleep and is waking up |
| `503` right after a Render deploy | The routing engine is still starting; retry in a few seconds |
| Connection refused on `localhost:4100` (Windows) | Use `127.0.0.1` |
| A route looks fine in JSON but draws in the wrong place | Decoded with the wrong precision, or the pairs not flipped for a `[lng, lat]` map library |
