/**
 * GET /dev/live-map — a local DEV page for testing live tracking by hand (2026-11-13).
 *
 * Pick two points (store -> drop): the page draws the road route between them (GET /v1/route).
 * Then it opens the order's SSE stream (GET /v1/orders/:orderId/track/events) and, for every
 * track_update, glides the driver marker to the new gps and redraws route_ahead / road_path.
 * The on_track updates come from outside, e.g. the Postman folder "06 live map demo", which POSTs
 * to /internal/v1/logistics/on_track. The page never calls POST /v1/track (no LSP needed).
 *
 * Same switch as the route viewer (DEV_VIEWER_ENABLED, src/config.ts). The page holds no data;
 * its API calls go through the normal token guard. The stream needs ENV=TEST: the browser's
 * EventSource can't send the token header (TRACK-01). Leaflet + OpenStreetMap tiles, light local
 * use only; nothing here calls OSRM directly.
 *
 * Query params (all optional): orderId, from, to ("lat,lng"), autostart=1.
 * The page script avoids backticks and "${" because this whole page is a template literal.
 */
import { Router } from "express";

/** Gurugram sample, the same store/drop as the route viewer and the Postman webhook requests. */
const DEFAULTS = { orderId: "live-demo-1", from: "28.495340,77.088059", to: "28.459469,77.026635" };

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live map (dev)</title>
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
  label { display:block; font-size:12px; color:var(--muted); margin:8px 0 2px; }
  input, textarea { width:100%; padding:7px 8px; border:1px solid var(--line); border-radius:6px; font:13px ui-monospace, Consolas, monospace; color:var(--text); background:#fff; }
  textarea { height:150px; resize:vertical; font-size:11px; }
  .row { display:flex; gap:6px; margin-top:10px; }
  .row button { flex:1; padding:9px; border:0; border-radius:6px; color:#fff; font-weight:600; cursor:pointer; }
  .go { background:var(--orange); } .stop { background:var(--navy); } .copy { background:var(--ok); }
  .check { display:flex; gap:6px; align-items:center; margin-top:8px; font-size:12px; color:var(--muted); }
  .check input { width:auto; }
  .status { margin:12px 0 4px; font-weight:600; }
  .status.ok { color:var(--ok); } .status.err { color:var(--err); }
  .stats { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:8px 0; }
  .stat { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
  .stat b { display:block; font-size:11px; color:var(--muted); font-weight:500; }
  .stat span { font-size:14px; font-weight:600; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px; font-size:12px; max-height:240px; overflow:auto; white-space:pre-wrap; word-break:break-all; margin:0; }
  .legend { display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--muted); margin:10px 0; }
  .sw { display:inline-block; width:18px; height:4px; vertical-align:middle; margin-right:4px; border-radius:2px; }
  #link a { color:var(--orange); }
  @media (max-width: 800px) { .wrap { grid-template-columns:1fr; height:auto; } #map { height:60vh; } aside { border-right:0; border-bottom:1px solid var(--line); } }
</style>
</head>
<body>
<div class="wrap">
<aside>
  <h1>Live map (dev)</h1>
  <p class="hint">Draws the road route between two points, then moves the driver for every
    <code>on_track</code> forwarded to <code>POST /internal/v1/logistics/on_track</code> for this orderId
    (e.g. Postman folder "06 live map demo"). Click the map to set "from", then "to". Coordinates are "lat,lng".
    The stream needs <code>ENV=TEST</code>.</p>

  <label for="token">X-Internal-Token (only if INTERNAL_TOKEN is set)</label>
  <input id="token" type="password" autocomplete="off" placeholder="empty = no token">
  <label for="order">orderId</label><input id="order">
  <label for="from">from (store)</label><input id="from">
  <label for="to">to (drop)</label><input id="to">
  <label class="check"><input type="checkbox" id="follow" checked> follow the driver</label>
  <div class="row">
    <button class="go" id="start" type="button">Start</button>
    <button class="stop" id="stop" type="button">Stop</button>
  </div>

  <div id="status" class="status"></div>
  <div class="stats">
    <div class="stat"><b>stage</b><span id="s-stage">-</span></div>
    <div class="stat"><b>updates</b><span id="s-count">0</span></div>
    <div class="stat"><b>left (display only)</b><span id="s-left">-</span></div>
    <div class="stat"><b>last update</b><span id="s-time">-</span></div>
  </div>
  <div id="link" class="hint"></div>

  <div class="legend">
    <span><span class="sw" style="background:#98a2b3"></span>planned (from &rarr; to)</span>
    <span><span class="sw" style="background:var(--orange);outline:2px solid var(--navy)"></span>route ahead</span>
    <span><span class="sw" style="background:var(--navy)"></span>trail (road_path)</span>
    <span><span class="sw" style="background:repeating-linear-gradient(90deg,var(--orange) 0 5px,transparent 5px 9px)"></span>fallback (straight)</span>
  </div>

  <label for="sample">on_track body for this order (POST /internal/v1/logistics/on_track)</label>
  <textarea id="sample" spellcheck="false" readonly></textarea>
  <div class="row"><button class="copy" id="copy" type="button">Copy body</button></div>

  <label>events</label>
  <pre id="out">Not started.</pre>
</aside>
<div id="map"></div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
(function () {
  var DEFAULTS = ${JSON.stringify(DEFAULTS)};
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  $("order").value = q.get("orderId") || DEFAULTS.orderId;
  $("from").value = q.get("from") || DEFAULTS.from;
  $("to").value = q.get("to") || DEFAULTS.to;
  try { $("token").value = sessionStorage.getItem("osrmBffToken") || ""; } catch (e) {}
  $("token").addEventListener("change", function () {
    try { sessionStorage.setItem("osrmBffToken", $("token").value); } catch (e) {}
  });

  var map = L.map("map").setView([28.48, 77.06], 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  var planLayer = L.layerGroup().addTo(map);   // planned route from -> to
  var trailLayer = L.layerGroup().addTo(map);  // road_path
  var aheadLayer = L.layerGroup().addTo(map);  // route_ahead or fallback
  var pinLayer = L.layerGroup().addTo(map);    // store + home
  var rider = null, riderAt = null, anim = null;
  var es = null, count = 0, fitted = false, store = null, home = null;

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
  function fmt(p) { return p[0].toFixed(6) + "," + p[1].toFixed(6); }
  function dot(color, size) {
    var h = size / 2;
    return L.divIcon({ className: "", iconSize: [size, size], iconAnchor: [h, h],
      html: "<div style='width:" + size + "px;height:" + size + "px;border-radius:50%;background:" + color + ";border:3px solid #fff;box-shadow:0 0 0 1px #1b2a49'></div>" });
  }
  function pins() {
    pinLayer.clearLayers();
    if (store) L.marker(store, { icon: dot("#067647", 16) }).bindTooltip("store").addTo(pinLayer);
    if (home) L.marker(home, { icon: dot("#ff7a00", 16) }).bindTooltip("home (drop)").addTo(pinLayer);
  }
  function routeLine(target, pts) {
    L.polyline(pts, { color: "#1b2a49", weight: 8 }).addTo(target);  // border
    L.polyline(pts, { color: "#ff7a00", weight: 5 }).addTo(target);  // fill
  }
  function km(m) { return (m / 1000).toFixed(1) + " km"; }
  function min(s) { return Math.max(1, Math.round(s / 60)) + " min"; }
  function headers() { var h = {}, t = $("token").value; if (t) h["X-Internal-Token"] = t; return h; }
  function log(line) { $("out").textContent = (new Date().toLocaleTimeString() + " " + line + "\\n\\n" + $("out").textContent).slice(0, 20000); }
  function setStatus(text, ok) { $("status").className = "status " + (ok ? "ok" : "err"); $("status").textContent = text; }

  // Glide the driver from its last position to p over ~1 s instead of jumping.
  function moveRider(p) {
    if (!rider) {
      rider = L.marker(p, { icon: dot("#1b2a49", 20), zIndexOffset: 1000 }).bindTooltip("driver").addTo(map);
      riderAt = p; return;
    }
    if (anim) cancelAnimationFrame(anim);
    var a = rider.getLatLng(), t0 = performance.now(), ms = 1000;
    (function step(now) {
      var k = Math.min(1, (now - t0) / ms), e = k * (2 - k);
      rider.setLatLng([a.lat + (p[0] - a.lat) * e, a.lng + (p[1] - a.lng) * e]);
      if (k < 1) anim = requestAnimationFrame(step); else anim = null;
    })(t0);
    riderAt = p;
  }

  function sampleBody() {
    var gps = riderAt ? fmt(riderAt) : $("from").value.trim(), now = new Date().toISOString();
    return JSON.stringify({
      event: "order_tracking", orderId: $("order").value.trim(), status: "active",
      gps: gps, locationTimestamp: now, path: [{ lat_lng: gps, sequence: "1" }], updatedAt: now,
      config: { attr: "tracking.location.gps", type: "live_poll" },
      fulfillmentState: "Order-picked-up", startGps: $("from").value.trim(), endGps: $("to").value.trim()
    }, null, 2);
  }
  function refreshSample() { $("sample").value = sampleBody(); }

  async function drawPlan() {
    planLayer.clearLayers();
    var from = $("from").value.trim(), to = $("to").value.trim();
    store = pt(from); home = pt(to); pins();
    if (!store || !home) { setStatus("from/to must be \\"lat,lng\\"", false); return; }
    try {
      var res = await fetch("/v1/route?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to), { headers: headers() });
      var body = await res.json().catch(function () { return {}; });
      if (res.ok && body.polyline) {
        var pts = decode(body.polyline);
        L.polyline(pts, { color: "#98a2b3", weight: 6, opacity: 0.8 }).addTo(planLayer);
        routeLine(aheadLayer, pts);  // until the first update, the plan is the route ahead
        $("s-left").textContent = km(body.distance_m) + " \\u00b7 " + min(body.duration_s);
        map.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
        log("GET /v1/route -> " + res.status + ": " + km(body.distance_m) + ", " + pts.length + " points");
      } else {
        L.polyline([store, home], { color: "#ff7a00", weight: 3, dashArray: "6 6" }).addTo(planLayer);
        map.fitBounds([store, home], { padding: [40, 40] });
        log("GET /v1/route -> " + res.status + " " + JSON.stringify(body) + " (straight-line fallback)");
      }
    } catch (e) { setStatus("GET /v1/route failed (is the service running?)", false); log(String(e)); }
  }

  function onUpdate(u) {
    count++;
    $("s-count").textContent = String(count);
    $("s-stage").textContent = u.stage || "unknown";
    $("s-time").textContent = new Date(u.updated_at || Date.now()).toLocaleTimeString();
    var s = pt(u.store_gps), d = pt(u.drop_gps);
    if (s) store = s; if (d) home = d; pins();
    var p = pt(u.gps);
    if (p) moveRider(p);

    trailLayer.clearLayers();
    if (u.road_path) L.polyline(decode(u.road_path), { color: "#1b2a49", weight: 5 }).addTo(trailLayer);

    aheadLayer.clearLayers();
    if (u.route_ahead) {
      routeLine(aheadLayer, decode(u.route_ahead.polyline));
      $("s-left").textContent = km(u.route_ahead.distance_m) + " \\u00b7 " + min(u.route_ahead.duration_s) + " to " + u.route_ahead.to;
    } else if (p) {
      // No route this update (OSRM down/slow): the app draws a straight line to the stage's
      // destination (src/routing/stage.ts). No line at a stage that has no destination.
      var st = u.stage || "";
      var noDest = /At-delivery|delivered|Cancelled|RTO-Disposed/i.test(st);
      var dest = noDest ? null : (/Agent-assigned|pickup|RTO-Initiated/i.test(st) ? store : home);
      if (dest) L.polyline([p, dest], { color: "#ff7a00", weight: 3, dashArray: "6 6" }).addTo(aheadLayer);
      $("s-left").textContent = "-";
    }

    $("link").textContent = "";
    if (u.tracking_url) {
      var a = document.createElement("a");
      a.href = u.tracking_url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "tracking_url (no gps: URL-based tracking)";
      $("link").appendChild(a);
    }
    if (p && !fitted) { fitted = true; map.fitBounds([p, store, home].filter(Boolean), { padding: [40, 40], maxZoom: 17 }); }
    else if (p && $("follow").checked) map.panTo(p);
    refreshSample();
  }

  function stop() { if (es) { es.close(); es = null; } }
  async function start() {
    stop();
    [planLayer, trailLayer, aheadLayer, pinLayer].forEach(function (l) { l.clearLayers(); });
    if (rider) { map.removeLayer(rider); rider = null; riderAt = null; }
    count = 0; fitted = false; $("out").textContent = "";
    ["s-stage", "s-left", "s-time"].forEach(function (id) { $(id).textContent = "-"; });
    $("s-count").textContent = "0";
    var id = $("order").value.trim();
    if (!id) { setStatus("orderId is required", false); return; }
    history.replaceState(null, "", "?orderId=" + encodeURIComponent(id) + "&from=" + encodeURIComponent($("from").value.trim()) + "&to=" + encodeURIComponent($("to").value.trim()));
    refreshSample();
    await drawPlan();
    es = new EventSource("/v1/orders/" + encodeURIComponent(id) + "/track/events");
    es.onopen = function () { setStatus("listening for on_track on " + id, true); log("stream open"); };
    es.addEventListener("track_update", function (e) {
      var u = JSON.parse(e.data);
      onUpdate(u);
      log("track_update #" + count + " " + (u.stage || "") + " gps " + (u.gps || "none") +
        (u.route_ahead ? " \\u00b7 route_ahead" : "") + (u.road_path ? " \\u00b7 road_path" : ""));
    });
    es.addEventListener("track_closed", function (e) {
      var c = {}; try { c = JSON.parse(e.data); } catch (x) {}
      $("s-stage").textContent = c.stage || "closed";
      aheadLayer.clearLayers();
      setStatus("order closed (" + (c.stage || "final stage") + "), stream ended", true);
      log("track_closed " + e.data); stop();
    });
    es.onerror = function () { setStatus("stream error, retrying (401 = needs ENV=TEST)", false); };
  }

  var nextClick = "from";
  map.on("click", function (e) {
    var v = fmt([e.latlng.lat, e.latlng.lng]);
    $(nextClick).value = v;
    nextClick = nextClick === "from" ? "to" : "from";
    store = pt($("from").value.trim()); home = pt($("to").value.trim()); pins(); refreshSample();
  });
  $("start").onclick = start;
  $("stop").onclick = function () { stop(); setStatus("stopped", true); };
  $("copy").onclick = function () {
    refreshSample();
    try { navigator.clipboard.writeText($("sample").value); setStatus("body copied", true); }
    catch (e) { $("sample").select(); }
  };
  ["order", "from", "to"].forEach(function (id) { $(id).addEventListener("change", refreshSample); });
  refreshSample();
  if (q.get("autostart") === "1") start();
})();
</script>
</body>
</html>`;

export function devLiveMapRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.type("html").send(PAGE);
  });
  return router;
}
