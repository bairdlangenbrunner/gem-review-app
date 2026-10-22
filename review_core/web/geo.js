/* Maps for the review page (docs/plan.md, "Geo"). Sets window.ReviewGeo: the basemaps, tile math, the page-wide basemap choice, a lazy Leaflet loader and route maps drawn into slots the tracker's line bodies return as HTML strings.
   Cards render as strings, so a map is a slot (mapSlot) plus a registry entry under the slot's id; an observer draws it the first time it scrolls into view, and a re-render of the same id keeps the last view. Leaflet comes from cdnjs on first use; its stylesheet is inlined in the page (leaflet.css), since the artifact page loads stylesheets only from Google Fonts. */
(function () {
  "use strict";
  var LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
  var LEAFLET_SRI = "sha512-BwHfrr4c9kmRkLw6iXFdzcdWV/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz/EWjgk5TYQqX/kvn9pG1NpYfqg==";
  var LOAD_MS = 15000;
  var PREF_KEY = "review-basemap";
  // both from Esri, keyless; OpenStreetMap's own tiles are not used (their usage policy excludes this kind of app) and CARTO's now want an API key (2026-10-21)
  var BASEMAPS = {
    map: {label: "map", url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", subdomains: "", maxZoom: 19,
          attribution: "Map: Esri, HERE, Garmin, USGS, Intermap, NGA, EPA, USDA, NPS, OpenStreetMap contributors"},
    satellite: {label: "satellite", url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", subdomains: "", maxZoom: 19,
                attribution: "Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community"}
  };
  var REG = {};          // id -> {geo, opts, map, base, el, view}
  var PAIRS = {};        // id -> the id its view follows (syncMaps)
  var LOADING = null, IO = null, MO = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  // Web Mercator tile coordinates of a point, the same math as scripts/geo.py tile_xy
  function tileXY(lat, lon, z) {
    var n = Math.pow(2, z), r = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
    return {x: (lon + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n};
  }

  // ---- the page-wide basemap ----
  function basemap() {
    var v = null;
    try { v = window.localStorage.getItem(PREF_KEY); } catch (e) { v = null; }
    return BASEMAPS[v] ? v : "map";
  }
  function tileLayer(name) {
    var b = BASEMAPS[name], o = {maxZoom: b.maxZoom, attribution: b.attribution};
    if (b.subdomains) o.subdomains = b.subdomains;
    return window.L.tileLayer(b.url, o);
  }
  function setBasemap(name) {
    if (!BASEMAPS[name]) return;
    try { window.localStorage.setItem(PREF_KEY, name); } catch (e) { /* the choice lasts for this page only */ }
    Object.keys(REG).forEach(function (id) {
      var r = REG[id];
      if (!r.map || r.baseName === name) return;
      r.map.removeLayer(r.base);
      r.base = tileLayer(name).addTo(r.map);
      r.baseName = name;
    });
    var bs = document.querySelectorAll("[data-basemap]");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-pressed", bs[i].getAttribute("data-basemap") === name ? "true" : "false");
  }

  // ---- Leaflet, once per page ----
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (LOADING) return LOADING;
    LOADING = new Promise(function (ok, fail) {
      var s = document.createElement("script"), done = false;
      function end(err) {
        if (done) return;
        done = true;
        if (err || !(window.L && window.L.map)) { LOADING = null; fail(err || new Error("leaflet did not load")); }
        else ok(window.L);
      }
      s.src = LEAFLET_JS;
      s.integrity = LEAFLET_SRI;
      s.crossOrigin = "anonymous";
      s.referrerPolicy = "no-referrer";
      s.onload = function () { end(null); };
      s.onerror = function () { end(new Error("leaflet did not load")); };
      setTimeout(function () { end(new Error("leaflet took too long to load")); }, LOAD_MS);
      document.head.appendChild(s);
    });
    return LOADING;
  }

  // ---- geometry ----
  function lines(fc) {
    var out = [];
    ((fc && fc.features) || []).forEach(function (f) {
      var g = f && f.geometry;
      if (!g) return;
      if (g.type === "LineString") out.push(g.coordinates);
      else if (g.type === "MultiLineString") g.coordinates.forEach(function (c) { out.push(c); });
    });
    return out;
  }
  function ends(geo) {
    var ls = lines(geo && geo.candidate);
    if (!ls.length) return null;
    var last = ls[ls.length - 1];
    return {start: ls[0][0], end: last[last.length - 1]};
  }
  function accent() {
    var v = "";
    try { v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(); } catch (e) { v = ""; }
    return v || "#2458c6";
  }

  // ---- slots ----
  function mapSlot(id, geo, opts) {
    var r = REG[id];
    if (!r || r.geo !== geo) REG[id] = r = {geo: geo, opts: opts || {}, view: r && r.geo === geo ? r.view : null};
    else r.opts = opts || {};
    var cur = basemap();
    var btns = Object.keys(BASEMAPS).map(function (k) {
      return '<button type="button" class="ghost" data-basemap="' + k + '" aria-pressed="' + (k === cur ? "true" : "false") + '">' + esc(BASEMAPS[k].label) + "</button>";
    }).join("");
    var lab = r.opts.label ? '<span class="rmap-label">' + esc(r.opts.label) + "</span>" : "";
    watch();
    return '<div class="rmap-wrap"><div class="rmap-bar">' + lab + '<span class="rmap-base">' + btns + "</span></div>" +
      '<div class="rmap" data-rmap="' + esc(id) + '"><div class="rmap-msg">map loads when it scrolls into view</div></div></div>';
  }
  function watch() {
    if (!IO && typeof IntersectionObserver === "function") {
      IO = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { IO.unobserve(e.target); draw(e.target); } });
      }, {rootMargin: "200px"});
    }
    if (!MO && typeof MutationObserver === "function" && document.body) {
      MO = new MutationObserver(scan);
      MO.observe(document.body, {childList: true, subtree: true});
    }
    setTimeout(scan, 0);
  }
  function scan() {
    var els = document.querySelectorAll(".rmap[data-rmap]:not([data-drawn])");
    for (var i = 0; i < els.length; i++) {
      els[i].setAttribute("data-drawn", "pending");
      if (IO) IO.observe(els[i]); else draw(els[i]);
    }
  }
  function draw(el) {
    var id = el.getAttribute("data-rmap"), r = REG[id];
    if (!r) { el.innerHTML = '<div class="rmap-msg">no geometry for this map</div>'; return; }
    loadLeaflet().then(function (L) {
      if (!el.isConnected) return;
      if (r.map) { try { r.map.remove(); } catch (e) { /* its container is gone */ } r.map = null; }
      el.innerHTML = "";
      el.setAttribute("data-drawn", "yes");
      var map = L.map(el, {keyboard: false, scrollWheelZoom: false, worldCopyJump: true, attributionControl: true});
      map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
      r.map = map; r.el = el; r.baseName = basemap();
      r.base = tileLayer(r.baseName).addTo(map);
      // the view is set before any vector layer goes on: Leaflet clips a path against the view and fails without one
      var g = r.geo || {}, show = r.opts.show || "both", col = accent(), drawn = [], layers = [];
      function route(fc, style, halo) {
        if (!fc || !lines(fc).length) return;
        if (halo) layers.push(L.geoJSON(fc, {style: {color: "#ffffff", weight: style.weight + 4, opacity: 0.75}, interactive: false}));
        var gl = L.geoJSON(fc, {style: style, interactive: false});
        layers.push(gl); drawn.push(gl);
      }
      if (show !== "candidate") route(g.current, {color: "#7a7a74", weight: 3, opacity: 0.95, dashArray: show === "both" ? "6 5" : null}, true);
      if (show !== "current") route(g.candidate, {color: col, weight: 3, opacity: 1}, true);
      var e = show === "current" ? null : ends(g);
      if (e) {
        [[e.start, g.start_name, "start"], [e.end, g.end_name, "end"]].forEach(function (p) {
          layers.push(L.circleMarker([p[0][1], p[0][0]], {radius: 5, color: "#ffffff", weight: 2, fillColor: col, fillOpacity: 1})
            .bindTooltip(esc(p[1] ? p[2] + ": " + p[1] : p[2]), {direction: "top"}));
        });
      }
      if (r.view) map.setView(r.view.center, r.view.zoom, {animate: false});
      else fit(map, g, drawn);
      layers.forEach(function (x) { x.addTo(map); });
      map.on("click", function () { map.scrollWheelZoom.enable(); });
      map.on("mouseout", function () { map.scrollWheelZoom.disable(); });
      map.on("moveend", function () {
        r.view = {center: map.getCenter(), zoom: map.getZoom()};
        follow(id);
      });
    }).catch(function (err) {
      if (window.console) console.warn("route map " + id + ": " + ((err && err.message) || err));
      el.setAttribute("data-drawn", "failed");
      el.innerHTML = '<div class="rmap-msg">map did not load</div>';
    });
  }
  function fit(map, g, drawn) {
    var b = g.bbox;
    if (Array.isArray(b) && b.length === 4 && b.every(function (x) { return typeof x === "number"; })) {
      if (b[0] === b[2] && b[1] === b[3]) map.setView([b[1], b[0]], 12);
      else map.fitBounds([[b[1], b[0]], [b[3], b[2]]], {padding: [18, 18]});
      return;
    }
    if (drawn.length) { map.fitBounds(drawn[0].getBounds(), {padding: [18, 18]}); return; }
    map.setView([20, 0], 2);
  }

  // ---- two maps that move together (a route and its replacement side by side) ----
  var SYNCING = false;
  function syncMaps(a, b) { PAIRS[a] = b; PAIRS[b] = a; }
  function follow(id) {
    var other = PAIRS[id], r = REG[id], o = other && REG[other];
    if (SYNCING || !o || !o.map || !r.map) return;
    SYNCING = true;
    try { o.map.setView(r.map.getCenter(), r.map.getZoom(), {animate: false}); } finally { SYNCING = false; }
  }

  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-basemap]") : null;
    if (b) { e.preventDefault(); setBasemap(b.getAttribute("data-basemap")); }
  });

  window.ReviewGeo = {BASEMAPS: BASEMAPS, LEAFLET_JS: LEAFLET_JS, tileXY: tileXY, basemap: basemap, setBasemap: setBasemap,
                      loadLeaflet: loadLeaflet, mapSlot: mapSlot, syncMaps: syncMaps, lines: lines, scan: scan, _reg: REG};
})();
