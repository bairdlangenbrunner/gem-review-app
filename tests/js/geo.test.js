// Route maps (review_core/web/geo.js, window.ReviewGeo): the tile math, the page-wide basemap choice kept in localStorage, the slot a line body returns, and what a drawn slot hands to Leaflet.
// geo.js is loaded whole in its own VM context built from the stub page's elements, with a Leaflet stub that records its calls.
// There is no IntersectionObserver in the context, so scan() draws a slot at once.
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var stub = require("./stub_page.js");

var GEO_JS = fs.readFileSync(path.join(stub.ROOT, "review_core", "web", "geo.js"), "utf8");
var STORE_JS = fs.readFileSync(path.join(stub.ROOT, "review_core", "web", "static_store.js"), "utf8");
var noop = stub.noop;

// a map element and a [data-basemap] button, both with attributes that can be read back
function slotEl(id) {
  var el = stub.element("rmap");
  el.setAttribute("data-rmap", id);
  return el;
}
function button(name) {
  var b = stub.element("button");
  b.setAttribute("data-basemap", name);
  b.setAttribute("aria-pressed", "false");
  return b;
}

// a Leaflet that records the calls geo.js makes; every object it returns takes the chained calls geo.js makes and ignores them.
// calls.early counts vector layers added before the map had a view (real Leaflet throws there: "reading 'min'")
function leaflet(calls) {
  var view = false;
  function rec(name) { return function () { calls[name] = (calls[name] || []).concat([Array.prototype.slice.call(arguments)]); if (name === "fitBounds" || name === "setView") view = true; }; }
  function layer(vector) {
    var o = {addTo: function () { if (vector && !view) calls.early = (calls.early || 0) + 1; return o; },
             bindTooltip: function () { return o; }, getBounds: function () { return "bounds"; }};
    return o;
  }
  return {
    map: function (el, opts) {
      rec("map")(el, opts);
      return {attributionControl: {setPrefix: noop}, scrollWheelZoom: {enable: noop, disable: noop}, removeLayer: rec("removeLayer"),
              fitBounds: rec("fitBounds"), setView: rec("setView"), on: noop, remove: noop, getCenter: noop, getZoom: noop};
    },
    tileLayer: function (url, o) { rec("tileLayer")(url, o); return layer(); },
    geoJSON: function (fc, o) { rec("geoJSON")(fc, o); return layer(true); },
    circleMarker: function (ll, o) { rec("circleMarker")(ll, o); return layer(true); }
  };
}

// a fresh context holding geo.js; opts.storage replaces the in-memory localStorage, opts.L is the Leaflet stub, opts.els the slots scan() finds
function load(opts) {
  opts = opts || {};
  var buttons = [button("map"), button("satellite")];
  var ctx = {
    document: {
      body: null, documentElement: stub.element("html"), head: stub.element("head"),
      addEventListener: noop, createElement: stub.element,
      querySelectorAll: function (sel) { return /data-basemap/.test(sel) ? buttons : /rmap/.test(sel) ? (opts.els || []).filter(function (e) { return !e.hasAttribute("data-drawn"); }) : []; }
    },
    setTimeout: setTimeout, Promise: Promise, console: {error: noop, warn: noop, log: noop, info: noop},
    localStorage: opts.storage || stub.memoryStorage()
  };
  ctx.window = ctx;
  if (opts.L) ctx.L = opts.L;
  vm.createContext(ctx);
  vm.runInContext(GEO_JS, ctx, {filename: "geo.js"});
  return {ctx: ctx, geo: ctx.ReviewGeo, buttons: buttons};
}
function pressed(P) { return P.buttons.map(function (b) { return b.getAttribute("aria-pressed"); }); }
function later() { return new Promise(function (ok) { setTimeout(ok, 20); }); }

// Web Mercator tile coordinates worked out from the formulas on the OSM wiki, in the other direction round: x from lon, y from the inverse gudermannian
function mercator(lat, lon, z) {
  var n = Math.pow(2, z), phi = lat * Math.PI / 180;
  return {x: (lon + 180) / 360 * n, y: (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n};
}

test("tileXY: the origin is the middle of the world at zoom 0", function () {
  var t = load().geo.tileXY(0, 0, 0);
  assert.deepEqual({x: t.x, y: t.y}, {x: 0.5, y: 0.5});
});

test("tileXY: the corners and the poles clamp to the world", function () {
  var g = load().geo;
  var w = g.tileXY(0, -180, 1), e = g.tileXY(0, 180, 1), pole = g.tileXY(90, 0, 3);
  assert.equal(w.x, 0);
  assert.equal(e.x, 2);
  assert.ok(Math.abs(pole.y) < 1e-6, "north pole clamps to the top edge, got " + pole.y);
  assert.ok(Math.abs(g.tileXY(-90, 0, 3).y - 8) < 1e-6);
});

test("tileXY matches an independent Web Mercator calculation", function () {
  var g = load().geo;
  [[51.5074, -0.1278, 10], [-33.8688, 151.2093, 14], [29.3759, 47.9774, 18], [60, 30, 5]].forEach(function (p) {
    var got = g.tileXY(p[0], p[1], p[2]), want = mercator(p[0], p[1], p[2]);
    assert.ok(Math.abs(got.x - want.x) < 1e-6 && Math.abs(got.y - want.y) < 1e-6, JSON.stringify(p) + " " + JSON.stringify(got));
  });
  // London at zoom 10 is in OSM tile 511/340
  var l = g.tileXY(51.5074, -0.1278, 10);
  assert.equal(Math.floor(l.x), 511);
  assert.equal(Math.floor(l.y), 340);
});

test("basemap defaults to map and ignores a stored name it does not know", function () {
  var P = load();
  assert.equal(P.geo.basemap(), "map");
  P.ctx.localStorage.setItem("review-basemap", "hybrid");
  assert.equal(P.geo.basemap(), "map");
});

test("setBasemap keeps the choice in localStorage and flips aria-pressed", function () {
  var P = load();
  assert.deepEqual(pressed(P), ["false", "false"]);
  P.geo.setBasemap("satellite");
  assert.equal(P.ctx.localStorage.getItem("review-basemap"), "satellite");
  assert.equal(P.geo.basemap(), "satellite");
  assert.deepEqual(pressed(P), ["false", "true"]);
  P.geo.setBasemap("map");
  assert.deepEqual(pressed(P), ["true", "false"]);
});

test("setBasemap ignores a name that is not a basemap", function () {
  var P = load();
  P.geo.setBasemap("satellite");
  P.geo.setBasemap("hybrid");
  assert.equal(P.geo.basemap(), "satellite");
  assert.equal(P.ctx.localStorage.getItem("review-basemap"), "satellite");
  assert.deepEqual(pressed(P), ["false", "true"]);
});

test("a localStorage that throws does not break basemap or setBasemap", function () {
  function boom() { throw new Error("storage is blocked"); }
  var P = load({storage: {getItem: boom, setItem: boom}});
  assert.equal(P.geo.basemap(), "map");
  assert.doesNotThrow(function () { P.geo.setBasemap("satellite"); });
  assert.deepEqual(pressed(P), ["false", "true"], "the buttons still follow the choice");
});

test("mapSlot returns a slot with the id, the label and a button per basemap", function () {
  var P = load();
  var html = P.geo.mapSlot("W1:route", {candidate: null}, {label: "new <route>"});
  assert.match(html, /<div class="rmap" data-rmap="W1:route">/);
  assert.match(html, /<span class="rmap-label">new &lt;route&gt;<\/span>/);
  assert.match(html, /data-basemap="map" aria-pressed="true"/);
  assert.match(html, /data-basemap="satellite" aria-pressed="false"/);
  assert.doesNotMatch(load().geo.mapSlot("x", {}), /rmap-label/);
  P.geo.setBasemap("satellite");
  assert.match(P.geo.mapSlot("W1:route", {}), /data-basemap="satellite" aria-pressed="true"/);
});

test("mapSlot registers the geometry and keeps the view for the same geometry only", function () {
  var P = load(), geo = {candidate: null};
  P.geo.mapSlot("a", geo);
  P.geo._reg.a.view = {center: [1, 2], zoom: 7};
  P.geo.mapSlot("a", geo);
  assert.deepEqual(P.geo._reg.a.view, {center: [1, 2], zoom: 7});
  P.geo.mapSlot("a", {candidate: null});
  assert.equal(P.geo._reg.a.view, null);
});

test("lines flattens LineString and MultiLineString features and skips the rest", function () {
  var g = load().geo;
  assert.deepEqual(stub.plain(g.lines(null)), []);
  var out = g.lines({features: [
    {geometry: {type: "LineString", coordinates: [[0, 0], [1, 1]]}},
    {geometry: {type: "MultiLineString", coordinates: [[[2, 2], [3, 3]], [[4, 4], [5, 5]]]}},
    {geometry: {type: "Point", coordinates: [9, 9]}}, {geometry: null}, null]});
  assert.equal(out.length, 3);
});

test("a drawn slot draws the candidate route, two end markers and fits the bbox", function () {
  var calls = {}, el = slotEl("W1:route");
  var P = load({L: leaflet(calls), els: [el]});
  var geo = {
    candidate: {features: [{geometry: {type: "LineString", coordinates: [[10, 20], [11, 21], [12, 22]]}}]},
    start_name: "Alpha", end_name: "Omega", bbox: [10, 20, 12, 22]
  };
  P.geo.mapSlot("W1:route", geo, {show: "candidate"});
  P.geo.scan();
  assert.equal(el.getAttribute("data-drawn"), "pending");
  return later().then(function () {
    assert.equal(el.getAttribute("data-drawn"), "yes");
    assert.equal(calls.map.length, 1);
    assert.equal(calls.map[0][0], el);
    assert.equal(calls.tileLayer.length, 1);
    assert.match(calls.tileLayer[0][0], /World_Street_Map/);
    assert.equal(calls.geoJSON.length, 2, "a white halo and the route itself");
    assert.equal(calls.geoJSON[1][1].style.color, "#2458c6");
    assert.equal(calls.circleMarker.length, 2);
    assert.deepEqual(stub.plain(calls.circleMarker.map(function (c) { return c[0]; })), [[20, 10], [22, 12]], "start then end, as [lat, lon]");
    assert.deepEqual(calls.fitBounds.length, 1);
    assert.equal(calls.early, undefined);             // the view is set before any route or marker goes on
    assert.deepEqual(JSON.parse(JSON.stringify(calls.fitBounds[0][0])), [[20, 10], [22, 12]]);
  });
});

test("a drawn slot with both routes draws the current one dashed and a point bbox zooms in", function () {
  var calls = {}, el = slotEl("b");
  var P = load({L: leaflet(calls), els: [el]});
  var line = {features: [{geometry: {type: "LineString", coordinates: [[5, 6], [5, 6]]}}]};
  P.geo.mapSlot("b", {current: line, candidate: line, bbox: [5, 6, 5, 6]});
  P.geo.scan();
  return later().then(function () {
    assert.equal(calls.geoJSON.length, 4);
    assert.equal(calls.geoJSON[1][1].style.dashArray, "6 5");
    assert.deepEqual(stub.plain(calls.setView[0].slice(0, 2)), [[6, 5], 12]);
  });
});

test("a slot with no registered geometry says so, and a failed Leaflet load marks it failed", function () {
  var el = slotEl("nope"), P = load({els: [el]});
  P.geo.scan();
  return later().then(function () {
    assert.match(el.innerHTML, /no geometry for this map/);
    var el2 = slotEl("w"), Q = load({els: [el2]});
    Q.geo.mapSlot("w", {});
    Q.ctx.document.head.appendChild = function (s) { s.onerror(); };
    Q.geo.scan();
    return later().then(function () {
      assert.equal(el2.getAttribute("data-drawn"), "failed");
      assert.match(el2.innerHTML, /map did not load/);
    });
  });
});

test("StaticStore.saveFile hands the artifact's downloads {filename, data} and resolves to the name", function () {
  var saved = [];
  var ctx = {
    document: {body: stub.element("body"), createElement: stub.element, addEventListener: noop, getElementById: function () { return stub.element("x"); }},
    setTimeout: setTimeout, Promise: Promise, console: {error: noop, warn: noop, log: noop, info: noop}, localStorage: stub.memoryStorage(),
    REVIEW_STATIC: {reviewer: "BL", data: {dirs: [], built: "x"}, tracker: {}}
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(STORE_JS, ctx, {filename: "static_store.js"});
  ctx.StaticStore.state.dl = {save: function (a) { saved.push(a); return Promise.resolve(); }};
  return ctx.StaticStore.saveFile("P1.geojson", "{}", "application/geo+json").then(function (name) {
    assert.equal(name, "P1.geojson");
    assert.deepEqual(stub.plain(saved), [{filename: "P1.geojson", data: "{}"}]);
    ctx.StaticStore.state.dl = {save: function () { return Promise.reject({code: "declined"}); }};
    return ctx.StaticStore.saveFile("P1.geojson", "{}").then(function () { assert.fail("should reject"); }, function (e) {
      assert.equal(e.message, "download cancelled");
    });
  });
});

test("StaticStore.saveFile without the artifact runtime clicks a download link and resolves to the name", function () {
  var clicked = [], ctx = {
    document: {body: stub.element("body"), addEventListener: noop, getElementById: function () { return stub.element("x"); },
               createElement: function (t) { var e = stub.element(t); e.click = function () { clicked.push(e.download); }; return e; }},
    setTimeout: noop, Promise: Promise, console: {error: noop, warn: noop, log: noop, info: noop}, localStorage: stub.memoryStorage(), Blob: Blob,
    URL: {createObjectURL: function () { return "blob:x"; }, revokeObjectURL: noop},
    REVIEW_STATIC: {reviewer: "BL", data: {dirs: [], built: "x"}, tracker: {}}
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(STORE_JS, ctx, {filename: "static_store.js"});
  assert.equal(ctx.StaticStore.state.dl, null);
  return ctx.StaticStore.saveFile("P2.geojson", "{}").then(function (name) {
    assert.equal(name, "P2.geojson");
    assert.deepEqual(clicked, ["P2.geojson"]);
  });
});
