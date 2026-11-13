/**
 * GET /dev/route-viewer — a local DEV tool that draws /v1/route and /internal/v1/track/enrich
 * responses, and plays the frontend's live-tracking flow (/v1/track + SSE) on a map, the way the app should (understanding/06): orange route with a navy border,
 * navy trail, markers, dashed straight-line fallback on errors.
 * The "Features" tab (2026-11-12) lists every feature of the service with a one-click test, and
 * GET /dev/route-viewer/info tells the page which mode the service runs in (no secrets).
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
  .feat-group { margin:14px 0 4px; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .feat { border:1px solid var(--line); border-radius:6px; padding:8px; margin:6px 0; display:grid; grid-template-columns:1fr auto; gap:2px 8px; align-items:center; }
  .feat b { font-size:13px; }
  .feat code { font-size:11px; color:var(--muted); grid-column:1; }
  .feat .d { font-size:12px; color:var(--muted); grid-column:1 / span 2; }
  .feat button { grid-row:1 / span 2; grid-column:2; padding:6px 12px; border:0; border-radius:6px; background:var(--orange); color:#fff; font-weight:600; cursor:pointer; }
  #info { font-size:12px; color:var(--muted); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
  #summary a { color:var(--orange); }
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
    <button id="tab-features" class="on" type="button">Features</button>
    <button id="tab-route" type="button">Route (2 points)</button>
    <button id="tab-enrich" type="button">Enrich</button>
    <button id="tab-live" type="button">Live order</button>
  </div>

  <div id="pane-features">
    <p class="hint">Every feature of osrm-bff, one click each. Webhook scenarios use a fresh orderId, open
      its SSE stream like the frontend, play the logistics side and draw every <code>track_update</code>.
      Routes need OSRM running; streams need <code>ENV=TEST</code>.</p>
    <div id="info">Loading service info...</div>
    <div id="features"></div>
  </div>

  <div id="pane-route" class="hidden">
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

  <div id="pane-live" class="hidden">
    <p class="hint">The frontend flow: opens the SSE stream <code>/v1/orders/:orderId/track/events</code>, then
      sends <code>POST /v1/track</code> every 15 s. Until logistics forwards <code>/on_track</code>, press
      "Simulate on_track" to play the logistics side (each press = the rider's next point; after the last, delivered).
      The stream needs <code>ENV=TEST</code>: the browser's EventSource can't send the token header.</p>
    <label for="order">orderId (the logistics order id)</label><input id="order" value="od-dev-1">
    <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="poll" checked style="width:auto"> POST /v1/track every 15 s</label>
    <button class="go" id="go-live" type="button">Start (stream + /v1/track)</button>
    <button class="go" id="stop-live" type="button" style="background:var(--navy)">Stop</button>
    <button class="go" id="sim" type="button" style="background:var(--ok)">Simulate on_track (next point)</button>
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

  // ---- Live order: SSE stream + POST /v1/track, like the frontend ----
  var es = null, pollTimer = null, simStep = 0;
  var SIM_PTS = ["28.495340,77.088059", "28.495470,77.087364", "28.496203,77.087864", "28.496921,77.088545", "28.497671,77.088763"];
  var SIM_HOME = "28.459469,77.026635";
  function log(line) { $("out").textContent = (line + "\\n\\n" + $("out").textContent).slice(0, 20000); }
  function drawUpdate(u) {
    layer.clearLayers();
    var rider = pt(u.gps), store = pt(u.store_gps), home = pt(u.drop_gps), all = [rider, store, home];
    var parts = ["stage " + (u.stage || "unknown")];
    if (!u.gps) parts.push("no gps (URL-based tracking)");
    if (u.road_path) {
      var trail = decode(u.road_path);
      L.polyline(trail, { color: "#1b2a49", weight: 5 }).addTo(layer);
      all = all.concat(trail); parts.push("trail " + trail.length + " pts");
    } else parts.push("no road_path");
    if (u.route_ahead) {
      var ahead = decode(u.route_ahead.polyline);
      routeLine(ahead); all = all.concat(ahead);
      parts.push("to " + u.route_ahead.to + ": " + km(u.route_ahead.distance_m) + " · " + min(u.route_ahead.duration_s));
    } else {
      fallback(rider, home);
      parts.push("no route_ahead");
    }
    marker(store, "#067647", "store"); marker(home, "#ff7a00", "home (drop_gps)"); marker(rider, "#1b2a49", "rider");
    $("summary").textContent = parts.join(" · ");
    if (u.tracking_url) {
      var a = document.createElement("a");
      a.href = u.tracking_url; a.target = "_blank"; a.rel = "noopener"; a.textContent = " · tracking_url";
      $("summary").appendChild(a);
    }
    fit(all);
  }
  async function requestTrack() {
    var id = $("order").value.trim();
    try {
      var t0 = performance.now();
      var res = await fetch("/v1/track", { method: "POST", headers: headers(true), body: JSON.stringify({ orderId: id }) });
      var text = await res.text();
      $("status").className = "status " + (res.ok ? "ok" : "err");
      $("status").textContent = "POST /v1/track: " + res.status + " (" + Math.round(performance.now() - t0) + " ms)";
      log("POST /v1/track -> " + res.status + " " + text);
    } catch (e) { fail(e); }
  }
  function stopLive() {
    if (es) { es.close(); es = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function startLive() {
    stopLive(); simStep = 0; layer.clearLayers(); $("out").textContent = "";
    var id = $("order").value.trim();
    es = new EventSource("/v1/orders/" + encodeURIComponent(id) + "/track/events");
    es.onopen = function () { log("stream open"); };
    es.addEventListener("track_update", function (e) {
      var u = JSON.parse(e.data);
      drawUpdate(u);
      log("track_update " + new Date().toLocaleTimeString() + "\\n" + JSON.stringify(u, null, 2));
    });
    es.addEventListener("track_closed", function (e) { log("track_closed " + e.data + " (stream ended)"); stopLive(); });
    es.onerror = function () { log("stream error: the browser retries in 3 s (401 = needs ENV=TEST)"); };
    requestTrack();
    if ($("poll").checked) pollTimer = setInterval(requestTrack, 15000);
  }
  async function simulate() {
    var id = $("order").value.trim();
    simStep = Math.min(simStep + 1, SIM_PTS.length + 1);
    var n = Math.min(simStep, SIM_PTS.length), now = new Date().toISOString();
    var body = {
      event: "order_tracking", orderId: id, status: "active", gps: SIM_PTS[n - 1],
      locationTimestamp: now, updatedAt: now,
      path: SIM_PTS.slice(0, n).map(function (p, i) { return { lat_lng: p, sequence: String(i + 1) }; }),
      fulfillmentState: simStep > SIM_PTS.length ? "Order-delivered" : "Order-picked-up",
      startGps: SIM_PTS[0], endGps: SIM_HOME
    };
    try {
      var res = await fetch("/internal/v1/logistics/on_track", { method: "POST", headers: headers(true), body: JSON.stringify(body) });
      log("simulated on_track #" + simStep + " (" + body.fulfillmentState + ") -> " + res.status);
    } catch (e) { fail(e); }
  }

  var next = "from";
  map.on("click", function (e) {
    if ($("pane-route").classList.contains("hidden")) return;
    $(next).value = e.latlng.lat.toFixed(6) + "," + e.latlng.lng.toFixed(6);  // lat first
    if (next === "to") drawRoute();
    next = next === "from" ? "to" : "from";
  });

  // ---- Features tab (2026-11-12): every feature, one click each ----
  // No backticks, no dollar-brace, no backslashes: this script sits inside a TS template literal.
  var SERVICE = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function freshId(prefix) { return prefix + "-" + Date.now().toString(36); }
  var BLR = { pts: ["12.973000,77.612000", "12.974000,77.613400", "12.975100,77.614300"], store: "12.971600,77.594600", home: "12.935200,77.624500" };
  var MUMBAI = { pts: ["19.076000,72.877700", "19.077000,72.878700"], store: "19.070000,72.870000", home: "19.080000,72.880000" };
  var NCR = { pts: SIM_PTS, store: SIM_PTS[0], home: SIM_HOME };

  // Workbench-shaped /on_track: one breadcrumb, always sequence "1", equal to gps. 15 s apart.
  function onTrack(id, area, i, extra) {
    var t0 = onTrack.t0 || (onTrack.t0 = Date.now());
    var gps = area.pts[Math.min(i, area.pts.length - 1)];
    var body = {
      event: "order_tracking", transactionId: "dev-viewer", orderId: id, status: "active", gps: gps,
      locationTimestamp: new Date(t0 + i * 15000).toISOString(), updatedAt: new Date(t0 + i * 15000 + 500).toISOString(),
      path: [{ lat_lng: gps, sequence: "1" }], config: { attr: "tracking.location.gps", type: "live_poll" },
      fulfillmentState: "Order-picked-up", startGps: area.store, endGps: area.home
    };
    Object.keys(extra || {}).forEach(function (k) { if (extra[k] === undefined) delete body[k]; else body[k] = extra[k]; });
    return body;
  }
  async function postWebhook(body) {
    var res = await fetch("/internal/v1/logistics/on_track", { method: "POST", headers: headers(true), body: JSON.stringify(body) });
    return res.status + " " + (await res.text());
  }
  function openStream(id) {
    stopLive();
    return new Promise(function (resolve) {
      es = new EventSource("/v1/orders/" + encodeURIComponent(id) + "/track/events");
      es.onopen = function () { log("stream open for " + id); resolve(); };
      es.addEventListener("track_update", function (e) {
        var u = JSON.parse(e.data);
        drawUpdate(u);
        log("track_update " + new Date().toLocaleTimeString() + " " + JSON.stringify(u, null, 2));
      });
      es.addEventListener("track_closed", function (e) { log("track_closed " + e.data + " (stream ended)"); stopLive(); });
      es.onerror = function () { log("stream error (401 = the stream needs ENV=TEST)"); resolve(); };
      setTimeout(resolve, 1500);
    });
  }
  async function scenario(title, prefix, bodies, after) {
    layer.clearLayers(); $("out").textContent = ""; $("summary").textContent = "";
    $("status").className = "status"; $("status").textContent = "Running: " + title;
    var id = freshId(prefix);
    onTrack.t0 = Date.now();
    try {
      await openStream(id);
      for (var i = 0; i < bodies.length; i++) {
        var b = bodies[i](id);
        log("on_track #" + (i + 1) + " -> " + (await postWebhook(b)));
        await sleep(900);
      }
      if (after) await after(id);
      $("status").className = "status ok"; $("status").textContent = "Done: " + title + " (order " + id + ")";
    } catch (e) { fail(e); }
  }
  async function metricLine(keys) {
    var r = await fetch("/metrics"); var m = await r.json(); var t = m.track || {};
    log("metrics.track: " + keys.map(function (k) { return k + "=" + t[k]; }).join(", "));
  }
  function routeTry(from, to) {
    return function () { tab("route"); $("from").value = from; $("to").value = to; drawRoute(); };
  }
  function getJson(url) { return function () { layer.clearLayers(); $("summary").textContent = ""; call(url, { headers: headers(false) }).catch(fail); }; }
  function enrichTry(stage) {
    return function () {
      tab("enrich");
      var req = JSON.parse(SAMPLE); req.order_id = freshId("enrich"); req.stage = stage;
      $("body").value = JSON.stringify(req, null, 2); drawEnrich();
    };
  }
  function step(area, i, extra) { return function (id) { return onTrack(id, area, i, extra); }; }

  var FEATURES = [
    { g: "Service", t: "Health", m: "GET /health", d: "Liveness only. Never checks OSRM, so a dead OSRM never takes the service down.", run: getJson("/health") },
    { g: "Service", t: "Metrics", m: "GET /metrics", d: "OSRM latency and outcomes, logistics calls, webhooks, pushes, breadcrumbs added/skipped, open streams.", run: getJson("/metrics") },
    { g: "Service", t: "Service mode", m: "GET /dev/route-viewer/info", d: "ENV, token, logistics, tunables. Dev page only, no secrets.", run: getJson("/dev/route-viewer/info") },

    { g: "Road route (two points)", t: "Delhi NCR", m: "GET /v1/route", d: "Store to home in Gurugram. Orange line with navy border, distance and time (display only).", run: routeTry("28.4950,77.0886", "28.4595,77.0266") },
    { g: "Road route (two points)", t: "Bengaluru", m: "GET /v1/route", d: "Second covered region (since 2026-11-10).", run: routeTry(BLR.pts[0], BLR.home) },
    { g: "Road route (two points)", t: "Outside coverage", m: "GET /v1/route -> 422", d: "Mumbai: never sent to OSRM, which would snap it to a road far away.", run: routeTry(MUMBAI.pts[0], MUMBAI.home) },
    { g: "Road route (two points)", t: "Bad input", m: "GET /v1/route -> 400", d: "Malformed coordinates.", run: routeTry("garbage", "28.4595,77.0266") },

    { g: "Enrich (BFF / ondc-api path)", t: "Out for delivery", m: "POST /internal/v1/track/enrich", d: "route_ahead to the drop + road_path from the request's path[] + drop_gps.", run: enrichTry("Out-for-delivery") },
    { g: "Enrich (BFF / ondc-api path)", t: "Before pickup", m: "POST /internal/v1/track/enrich", d: "Agent-assigned: the route goes to the store.", run: enrichTry("Agent-assigned") },
    { g: "Enrich (BFF / ondc-api path)", t: "Delivered", m: "POST /internal/v1/track/enrich", d: "Final stage: no route_ahead, cache cleared.", run: enrichTry("Order-delivered") },

    { g: "Frontend API", t: "Request tracking", m: "POST /v1/track", d: "Forwards { orderId } to ondc-logistics-api POST /logistics/track (orderId from the Live order tab). 503 if logistics isn't configured.", run: function () { tab("live"); requestTrack(); } },
    { g: "Frontend API", t: "Latest update (snapshot)", m: "GET /v1/orders/:orderId/track", d: "The last track_update for the Live order tab's orderId; 404 before the first one.", run: function () { getJson("/v1/orders/" + encodeURIComponent($("order").value.trim()) + "/track")(); } },
    { g: "Frontend API", t: "Live stream", m: "GET /v1/orders/:orderId/track/events", d: "SSE: track_update per /on_track, track_closed at a final stage. Opens the Live order tab.", run: function () { tab("live"); startLive(); } },

    { g: "Logistics webhook scenarios", t: "Trail grows (workbench)", m: "POST /internal/v1/logistics/on_track x5", d: "Workbench shape: one breadcrumb, always sequence 1. Our own breadcrumbs make the navy trail grow from update 2.",
      run: function () { scenario("trail grows", "trail", [0, 1, 2, 3, 4].map(function (i) { return step(NCR, i); }), function () { return metricLine(["crumbs_added", "crumbs_skipped_not_moved", "crumbs_skipped_older"]); }); } },
    { g: "Logistics webhook scenarios", t: "Same update twice", m: "on_track x3", d: "The repeat adds no breadcrumb and no OSRM call; the cached trail is resent.",
      run: function () { scenario("same update twice", "dup", [step(NCR, 0), step(NCR, 1), step(NCR, 1)], function () { return metricLine(["crumbs_added", "crumbs_skipped_not_moved"]); }); } },
    { g: "Logistics webhook scenarios", t: "Rider standing still", m: "on_track x3", d: "Moves of about 3 m (under CRUMB_MIN_MOVE_M) are not added to the trail.",
      run: function () { scenario("standing still", "still", [step(NCR, 0), step(NCR, 1, { gps: "28.495370,77.088059" }), step(NCR, 2, { gps: "28.495350,77.088079" })], function () { return metricLine(["crumbs_skipped_not_moved"]); }); } },
    { g: "Logistics webhook scenarios", t: "URL-based tracking", m: "on_track without gps", d: "LSP sends only a tracking URL: pushed with tracking_url and the markers, no gps, no routes.",
      run: function () { scenario("URL-based tracking", "url", [step(NCR, 0, { gps: undefined, path: undefined, locationTimestamp: undefined, url: "https://example.com/lsp-tracking/demo", config: { attr: "tracking.url", type: "deferred" } })]); } },
    { g: "Logistics webhook scenarios", t: "Bengaluru order", m: "on_track x3", d: "Route ahead and trail in the second region.",
      run: function () { scenario("Bengaluru", "blr", [0, 1, 2].map(function (i) { return step(BLR, i); })); } },
    { g: "Logistics webhook scenarios", t: "Outside coverage", m: "on_track x2", d: "Mumbai rider: GPS-only updates, OSRM never called (the app draws straight lines).",
      run: function () { scenario("outside coverage", "out", [0, 1].map(function (i) { return step(MUMBAI, i); })); } },
    { g: "Logistics webhook scenarios", t: "No stage in payload", m: "on_track without fulfillmentState", d: "Falls back to GET /logistics/orders/:id/status; without logistics, no route_ahead.",
      run: function () { scenario("no stage", "nostage", [step(NCR, 0, { fulfillmentState: undefined })]); } },
    { g: "Logistics webhook scenarios", t: "Order delivered", m: "on_track x3", d: "Two updates, then Order-delivered: track_closed, the stream ends, snapshot and caches dropped.",
      run: function () { scenario("delivered", "done", [step(NCR, 0), step(NCR, 1), step(NCR, 2, { fulfillmentState: "Order-delivered" })]); } },
    { g: "Logistics webhook scenarios", t: "Bad body", m: "on_track -> 400", d: "A gps that isn't 'lat,lng' is a sender bug: 400, nothing pushed.",
      run: async function () { layer.clearLayers(); try { await call("/internal/v1/logistics/on_track", { method: "POST", headers: headers(true), body: JSON.stringify({ orderId: "bad-1", gps: "garbage" }) }); } catch (e) { fail(e); } } }
  ];

  (function renderFeatures() {
    var box = $("features"), group = "";
    FEATURES.forEach(function (f) {
      if (f.g !== group) {
        group = f.g;
        var h = document.createElement("div"); h.className = "feat-group"; h.textContent = group; box.appendChild(h);
      }
      var row = document.createElement("div"); row.className = "feat";
      var b = document.createElement("b"); b.textContent = f.t;
      var btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Try"; btn.onclick = f.run;
      var m = document.createElement("code"); m.textContent = f.m;
      var d = document.createElement("div"); d.className = "d"; d.textContent = f.d;
      row.appendChild(b); row.appendChild(btn); row.appendChild(m); row.appendChild(d);
      box.appendChild(row);
    });
  })();

  fetch("/dev/route-viewer/info").then(function (r) { return r.json(); }).then(function (i) {
    SERVICE = i;
    var warn = i.token_required ? " Token required: streams won't open in the browser (use ENV=TEST)." : "";
    $("info").textContent = "ENV=" + i.env + " · token " + (i.token_required ? "required" : "not checked") +
      " · logistics " + (i.logistics_configured ? "configured" : "not configured (POST /v1/track answers 503)") +
      " · re-route " + i.reroute_threshold_m + " m · breadcrumb min move " + i.crumb_min_move_m + " m · deadline " + i.enrich_deadline_ms + " ms." + warn;
  }).catch(function () { $("info").textContent = "Service info unavailable."; });

  function tab(which) {
    ["features", "route", "enrich", "live"].forEach(function (t) {
      $("tab-" + t).classList.toggle("on", which === t);
      $("pane-" + t).classList.toggle("hidden", which !== t);
    });
  }
  $("tab-features").onclick = function () { tab("features"); };
  $("tab-route").onclick = function () { tab("route"); };
  $("tab-enrich").onclick = function () { tab("enrich"); };
  $("tab-live").onclick = function () { tab("live"); };
  $("go-route").onclick = drawRoute;
  $("go-enrich").onclick = drawEnrich;
  $("go-live").onclick = startLive;
  $("stop-live").onclick = stopLive;
  $("sim").onclick = simulate;
})();
</script>
</body>
</html>`;

/** What the Features tab shows about the running service. Never secrets (no token, no Redis URL). */
export interface DevViewerInfo {
  env: string;
  token_required: boolean;
  logistics_configured: boolean;
  coverage: string;
  reroute_threshold_m: number;
  crumb_min_move_m: number;
  crumbs_max_points: number;
  match_min_confidence: number;
  osrm_timeout_ms: number;
  enrich_deadline_ms: number;
}

export function devViewerRouter(info?: DevViewerInfo): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.type("html").send(PAGE);
  });
  router.get("/info", (_req, res) => {
    res.json(info ?? {});
  });
  return router;
}
