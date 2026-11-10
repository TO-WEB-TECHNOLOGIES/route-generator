/**
 * GET /dev/route-viewer — a local DEV tool that draws /v1/route and /internal/v1/track/enrich
 * responses on a map, the way the app should (understanding/06): orange route with a navy border,
 * navy trail, markers, dashed straight-line fallback on errors.
 *
 * Off when NODE_ENV=production unless DEV_VIEWER_ENABLED says otherwise (src/config.ts). The page
 * itself holds no data; its API calls go through the normal token guard with a token typed in the
 * page. Base map: Leaflet + OpenStreetMap tiles, for light local use only. The app uses its own map
 * provider, and nothing here calls OSRM directly.
 *
 * The page script avoids backticks and "${" because this whole page is a template literal.
 */
import { Router } from "express";

const SAMPLE_ENRICH = JSON.stringify(
  {
    order_id: "dev-viewer-1",
    stage: "Out-for-delivery",
    gps: "28.497671,77.088763",
    store_gps: "28.495340,77.088059",
    drop_gps: "28.459469,77.026635",
    path: [
      { lat_lng: "28.495340,77.088059", sequence: "1" },
      { lat_lng: "28.495470,77.087364", sequence: "2" },
      { lat_lng: "28.496203,77.087864", sequence: "3" },
      { lat_lng: "28.496921,77.088545", sequence: "4" },
      { lat_lng: "28.497671,77.088763", sequence: "5" },
    ],
  },
  null,
  2,
);

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Route viewer (dev)</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
  :root { --bg:#f6f7f9; --panel:#fff; --text:#1b2a49; --muted:#5b6475; --line:#d9dde5; --orange:#ff7a00; --navy:#1b2a49; --err:#b42318; --ok:#067647; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color:var(--text); background:var(--bg); }
  .wrap { display:grid; grid-template-columns: 380px 1fr; height:100vh; }
  aside { background:var(--panel); border-right:1px solid var(--line); padding:16px; overflow:auto; }
  #map { height:100vh; }
  h1 { font-size:16px; margin:0 0 4px; }
  p.hint { color:var(--muted); margin:0 0 12px; font-size:12px; }
  .tabs { display:flex; gap:4px; margin-bottom:12px; }
  .tabs button { flex:1; padding:8px; border:1px solid var(--line); background:var(--bg); border-radius:6px; cursor:pointer; color:var(--text); }
  .tabs button.on { background:var(--navy); color:#fff; border-color:var(--navy); }
  label { display:block; font-size:12px; color:var(--muted); margin:8px 0 2px; }
  input, textarea { width:100%; padding:7px 8px; border:1px solid var(--line); border-radius:6px; font:13px ui-monospace, Consolas, monospace; color:var(--text); background:#fff; }
  textarea { height:240px; resize:vertical; }
  .go { margin-top:10px; width:100%; padding:9px; border:0; border-radius:6px; background:var(--orange); color:#fff; font-weight:600; cursor:pointer; }
  .status { margin:12px 0 4px; font-weight:600; }
  .status.ok { color:var(--ok); } .status.err { color:var(--err); }
  .summary { color:var(--muted); margin-bottom:6px; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px; font-size:12px; max-height:280px; overflow:auto; white-space:pre-wrap; word-break:break-all; margin:0; }
  .legend { display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--muted); margin:10px 0; }
  .sw { display:inline-block; width:18px; height:4px; vertical-align:middle; margin-right:4px; border-radius:2px; }
  .hidden { display:none; }
  @media (max-width: 800px) { .wrap { grid-template-columns:1fr; height:auto; } #map { height:60vh; } aside { border-right:0; border-bottom:1px solid var(--line); } }
</style>
</head>
<body>
<div class="wrap">
<aside>
  <h1>Route viewer (dev)</h1>
  <p class="hint">Draws osrm-bff responses the way the app should. Dev only. Coordinates are "lat,lng".</p>

  <label for="token">X-Internal-Token (only if INTERNAL_TOKEN is set)</label>
  <input id="token" type="password" autocomplete="off" placeholder="empty = no token">

  <div class="tabs" style="margin-top:12px">
    <button id="tab-route" class="on" type="button">Route (2 points)</button>
    <button id="tab-enrich" type="button">Enrich (GPS update)</button>
  </div>

  <div id="pane-route">
    <p class="hint">Click the map to set "from", click again for "to".</p>
    <label for="from">from</label><input id="from" value="28.4950,77.0886">
    <label for="to">to</label><input id="to" value="28.4595,77.0266">
    <button class="go" id="go-route" type="button">Draw route</button>
  </div>

  <div id="pane-enrich" class="hidden">
    <p class="hint">POST /internal/v1/track/enrich. Paste a request body. The sample is shaped like logistics data (string sequences, no timestamps). Each send updates the route cache for that order_id.</p>
    <label for="body">request body</label>
    <textarea id="body" spellcheck="false"></textarea>
    <button class="go" id="go-enrich" type="button">Send and draw</button>
  </div>

  <div class="legend">
    <span><span class="sw" style="background:var(--orange);outline:2px solid var(--navy)"></span>route ahead</span>
    <span><span class="sw" style="background:var(--navy)"></span>trail (road_path)</span>
    <span><span class="sw" style="background:repeating-linear-gradient(90deg,var(--orange) 0 5px,transparent 5px 9px)"></span>fallback (straight)</span>
    <span><span class="sw" style="background:#98a2b3;height:8px;width:8px;border-radius:50%"></span>raw GPS points</span>
  </div>

  <div id="status" class="status"></div>
  <div id="summary" class="summary"></div>
  <pre id="out">No request yet.</pre>
</aside>
<div id="map"></div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
(function () {
  var SAMPLE = ${JSON.stringify(SAMPLE_ENRICH)};
  var $ = function (id) { return document.getElementById(id); };
  $("body").value = SAMPLE;

  try { $("token").value = sessionStorage.getItem("osrmBffToken") || ""; } catch (e) {}
  $("token").addEventListener("change", function () {
    try { sessionStorage.setItem("osrmBffToken", $("token").value); } catch (e) {}
  });

  var map = L.map("map").setView([28.48, 77.06], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  var layer = L.layerGroup().addTo(map);

  // Google encoded polyline, precision 5 -> [[lat, lng], ...]. Leaflet takes lat,lng as-is.
  function decode(str) {
    var pts = [], i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      var r = 0, s = 0, b;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
      lat += (r & 1) ? ~(r >> 1) : (r >> 1);
      r = 0; s = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
      lng += (r & 1) ? ~(r >> 1) : (r >> 1);
      pts.push([lat / 1e5, lng / 1e5]);
    }
    return pts;
  }
  function pt(s) {
    if (typeof s !== "string") return null;
    var p = s.split(",").map(Number);
    return p.length === 2 && isFinite(p[0]) && isFinite(p[1]) ? [p[0], p[1]] : null; // "lat,lng"
  }
  function dot(color) {
    return L.divIcon({ className: "", iconSize: [16, 16], iconAnchor: [8, 8],
      html: "<div style='width:16px;height:16px;border-radius:50%;background:" + color + ";border:3px solid #fff;box-shadow:0 0 0 1px #1b2a49'></div>" });
  }
  function marker(p, color, title) { if (p) L.marker(p, { icon: dot(color), title: title }).bindTooltip(title).addTo(layer); }
  function routeLine(pts) {
    L.polyline(pts, { color: "#1b2a49", weight: 8 }).addTo(layer);  // border
    L.polyline(pts, { color: "#ff7a00", weight: 5 }).addTo(layer);  // fill
  }
  function fallback(a, b) { if (a && b) L.polyline([a, b], { color: "#ff7a00", weight: 3, dashArray: "6 6" }).addTo(layer); }
  function fit(points) { var ok = points.filter(Boolean); if (ok.length) map.fitBounds(ok, { padding: [40, 40], maxZoom: 17 }); }
  function km(m) { return (m / 1000).toFixed(1) + " km"; }
  function min(s) { return Math.max(1, Math.round(s / 60)) + " min"; }
  function headers(json) {
    var h = {}; if (json) h["Content-Type"] = "application/json";
    var t = $("token").value; if (t) h["X-Internal-Token"] = t;
    return h;
  }
  function show(res, body, ms) {
    var st = $("status");
    st.className = "status " + (res.ok ? "ok" : "err");
    st.textContent = res.status + " " + (res.ok ? "OK" : "error") + " (" + ms + " ms)";
    $("out").textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  }
  async function call(url, opts) {
    var t0 = performance.now();
    var res = await fetch(url, opts);
    var text = await res.text(), body;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    show(res, body, Math.round(performance.now() - t0));
    return { res: res, body: body };
  }
  function fail(err) {
    $("status").className = "status err";
    $("status").textContent = "request failed (is the service running?)";
    $("out").textContent = String(err);
  }

  async function drawRoute() {
    layer.clearLayers(); $("summary").textContent = "";
    var from = pt($("from").value.trim()), to = pt($("to").value.trim());
    var q = "from=" + encodeURIComponent($("from").value.trim()) + "&to=" + encodeURIComponent($("to").value.trim());
    try {
      var r = await call("/v1/route?" + q, { headers: headers(false) });
      marker(from, "#1b2a49", "from"); marker(to, "#ff7a00", "to");
      if (r.res.ok && r.body.polyline) {
        var pts = decode(r.body.polyline);
        routeLine(pts);
        $("summary").textContent = km(r.body.distance_m) + " \\u00b7 " + min(r.body.duration_s) + " (display only) \\u00b7 " + pts.length + " points";
        fit(pts.concat([from, to]));
      } else {
        fallback(from, to);
        $("summary").textContent = "No route: the app would draw the dashed straight line.";
        fit([from, to]);
      }
    } catch (e) { fail(e); }
  }

  async function drawEnrich() {
    layer.clearLayers(); $("summary").textContent = "";
    var req;
    try { req = JSON.parse($("body").value); } catch (e) { fail("Request body is not valid JSON: " + e.message); return; }
    try {
      var r = await call("/internal/v1/track/enrich", { method: "POST", headers: headers(true), body: JSON.stringify(req) });
      var rider = pt(req.gps), store = pt(req.store_gps);
      var b = r.res.ok && typeof r.body === "object" ? r.body : {};
      var home = pt(b.drop_gps) || pt(req.drop_gps);
      var all = [rider, store, home], parts = [];

      (req.path || []).forEach(function (p) {
        var q = pt(p && p.lat_lng);
        if (q) L.circleMarker(q, { radius: 3, color: "#98a2b3", fillOpacity: 1 }).bindTooltip("seq " + p.sequence).addTo(layer);
      });
      if (b.road_path) {
        var trail = decode(b.road_path);
        L.polyline(trail, { color: "#1b2a49", weight: 5 }).addTo(layer);
        all = all.concat(trail); parts.push("trail " + trail.length + " pts");
      } else parts.push("no road_path");
      if (b.route_ahead) {
        var ahead = decode(b.route_ahead.polyline);
        routeLine(ahead); all = all.concat(ahead);
        parts.push("to " + b.route_ahead.to + ": " + km(b.route_ahead.distance_m) + " \\u00b7 " + min(b.route_ahead.duration_s));
      } else {
        fallback(rider, home);
        parts.push("no route_ahead (straight-line fallback)");
      }
      marker(store, "#067647", "store"); marker(home, "#ff7a00", "home (drop_gps)"); marker(rider, "#1b2a49", "rider");
      $("summary").textContent = parts.join(" \\u00b7 ");
      fit(all);
    } catch (e) { fail(e); }
  }

  var next = "from";
  map.on("click", function (e) {
    if ($("pane-route").classList.contains("hidden")) return;
    $(next).value = e.latlng.lat.toFixed(6) + "," + e.latlng.lng.toFixed(6);  // lat first
    if (next === "to") drawRoute();
    next = next === "from" ? "to" : "from";
  });
  function tab(which) {
    $("tab-route").classList.toggle("on", which === "route");
    $("tab-enrich").classList.toggle("on", which === "enrich");
    $("pane-route").classList.toggle("hidden", which !== "route");
    $("pane-enrich").classList.toggle("hidden", which !== "enrich");
  }
  $("tab-route").onclick = function () { tab("route"); };
  $("tab-enrich").onclick = function () { tab("enrich"); };
  $("go-route").onclick = drawRoute;
  $("go-enrich").onclick = drawEnrich;
})();
</script>
</body>
</html>`;

export function devViewerRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.type("html").send(PAGE);
  });
  return router;
}
