// How a route or value was made (review_core/web/geo.js imageSrc, imageBlock, controlPointTable; trackers/pipelines/web/ext.js detailsHtml): the picture rows, the lightbox, the control-point table and the details block.
// geo.js is loaded whole in its own VM context; the pipelines hook is read out of ext.js by wrapping ReviewApp.define in a stub page.
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var stub = require("./stub_page.js");

var GEO_JS = fs.readFileSync(path.join(stub.ROOT, "review_core", "web", "geo.js"), "utf8");
var PIPELINES_EXT = fs.readFileSync(path.join(stub.ROOT, "trackers", "pipelines", "web", "ext.js"), "utf8");
var noop = stub.noop;
var SHA = new Array(65).join("a");

// a fresh context holding geo.js; listeners records every listener by type and capture flag, appended the elements added to the body
function load(opts) {
  opts = opts || {};
  var listeners = {}, appended = [];
  var body = stub.element("body");
  body.appendChild = function (c) { appended.push(c); return c; };
  var ctx = {
    document: {
      body: body, documentElement: stub.element("html"), head: stub.element("head"), createElement: stub.element,
      addEventListener: function (t, fn, cap) { (listeners[t] = listeners[t] || []).push({fn: fn, cap: !!cap}); },
      querySelectorAll: function () { return []; }
    },
    setTimeout: setTimeout, Promise: Promise, console: {error: noop, warn: noop, log: noop, info: noop},
    localStorage: stub.memoryStorage()
  };
  ctx.window = ctx;
  if (opts.static) ctx.REVIEW_STATIC = {};
  vm.createContext(ctx);
  vm.runInContext(GEO_JS, ctx, {filename: "geo.js"});
  return {ctx: ctx, geo: ctx.ReviewGeo, listeners: listeners, appended: appended};
}
// an event that records what was done to it; target answers closest() with the element it stands for
function ev(extra) {
  var e = {stopped: false, prevented: false, stopPropagation: function () { e.stopped = true; }, preventDefault: function () { e.prevented = true; }};
  Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
  return e;
}
function fire(P, type, e, cap) {
  (P.listeners[type] || []).filter(function (l) { return cap == null || l.cap === cap; }).forEach(function (l) { l.fn(e); });
  return e;
}
function pic(src, alt) {
  var el = stub.element("img");
  el.setAttribute("src", src);
  el.setAttribute("alt", alt);
  el.closest = function (sel) { return /rzoom/.test(sel) ? el : null; };
  return el;
}

test("imageSrc: the loopback page serves /asset/, the artifact page uses the uploaded url", function () {
  var img = {asset: SHA + ".jpg", url: "https://files.example/x.jpg"};
  assert.equal(load().geo.imageSrc(img), "/asset/" + SHA + ".jpg");
  assert.equal(load().geo.imageSrc({caption: "no asset"}), "");
  assert.equal(load({static: true}).geo.imageSrc(img), "https://files.example/x.jpg");
  assert.equal(load({static: true}).geo.imageSrc({asset: SHA + ".jpg"}), "");
});

test("imageBlock: maps before overlays, sizes, lazy loading and a source link", function () {
  var g = load().geo;
  var h = g.imageBlock([
    {role: "overlay", caption: "trace", asset: SHA + ".png", width: 800, height: 600},
    {role: "map", caption: "the map", asset: SHA + ".jpg", width: 1600, height: 900, source_url: "https://example.org/m?a=1&b=2"}]);
  assert.ok(h.indexOf("the map") < h.indexOf("trace"));
  assert.match(h, /<img loading="lazy" src="\/asset\/a{64}\.jpg" alt="the map" width="1600" height="900"/);
  assert.match(h, /<a href="https:\/\/example\.org\/m\?a=1&amp;b=2" target="_blank" rel="noopener">source<\/a>/);
  assert.equal((h.match(/<figure class="rimg">/g) || []).length, 2);
  assert.equal(g.imageBlock([]), "");
});

test("imageBlock: an image with no src shows its caption and says it is not uploaded", function () {
  var h = load({static: true}).geo.imageBlock([{role: "map", caption: "the map", asset: SHA + ".jpg"}]);
  assert.ok(h.indexOf("<img") < 0);
  assert.match(h, /image not uploaded/);
  assert.match(h, /<figcaption>the map<\/figcaption>/);
});

test("imageBlock and controlPointTable escape every text and refuse a script url", function () {
  var g = load().geo;
  var h = g.imageBlock([{role: "map", caption: '<b onclick="x">"hi"</b>', asset: SHA + ".png", source_url: "javascript:alert(1)"}]);
  assert.ok(h.indexOf("<b") < 0 && h.indexOf("javascript:") < 0);
  assert.match(h, /&lt;b onclick=&quot;x&quot;&gt;/);
  var t = g.controlPointTable([{name: "<i>A</i>", px: [1, 2], lon: 1, lat: 2, ref: "javascript:alert(1)"}, {name: "B", ref: "<script>"}]);
  assert.ok(t.indexOf("<i>") < 0 && t.indexOf("<script>") < 0 && t.indexOf("href") < 0);
  assert.match(t, /&lt;i&gt;A&lt;\/i&gt;/);
});

test("controlPointTable: pixels as integers, five and two decimals, a link or the text", function () {
  var t = load().geo.controlPointTable([
    {name: "Kirkuk", px: [120.4, 98.6], lon: 44.39219876, lat: 35.468, ref: "https://example.org/place", residual_km: 0.456},
    {name: "Zakho", px: [5, 6], lon: 42.68, lat: 37.14, ref: "map grid", residual_km: null}]);
  assert.match(t, /<table class="rcpts"><caption>Control points used to place the map<\/caption>/);
  assert.match(t, /<th>point<\/th><th>pixel<\/th><th>lon<\/th><th>lat<\/th><th>error km<\/th><th>source<\/th>/);
  assert.match(t, /<td>Kirkuk<\/td><td>120, 99<\/td><td>44\.39220<\/td><td>35\.46800<\/td><td>0\.46<\/td><td><a href="https:\/\/example\.org\/place"[^>]*>link<\/a><\/td>/);
  assert.match(t, /<td>Zakho<\/td><td>5, 6<\/td><td>42\.68000<\/td><td>37\.14000<\/td><td><\/td><td>map grid<\/td>/);
  assert.equal(load().geo.controlPointTable(null), "");
});

test("lightbox: a click on a picture opens one page-wide overlay, a click or Esc closes it", function () {
  var P = load();
  var shown = P.geo.imageBlock([{role: "map", caption: "m", asset: SHA + ".png"}]);
  assert.ok(shown.indexOf('data-rzoom="1"') > 0 && P.appended.length === 0, "nothing is built until a picture is opened");
  fire(P, "click", ev({target: pic("/asset/x.png", "m")}));
  fire(P, "click", ev({target: pic("/asset/y.png", "n")}));      // closes the first (a click while open)
  fire(P, "click", ev({target: pic("/asset/y.png", "n")}));
  assert.equal(P.appended.length, 1, "one overlay for the whole page");
  var box = P.appended[0];
  assert.equal(box.className, "rlightbox");
  assert.equal(box.hidden, false);
  var click = fire(P, "click", ev({target: stub.element("div")}));
  assert.equal(box.hidden, true);
  assert.ok(click.prevented);
  fire(P, "click", ev({target: pic("/asset/z.png", "z")}));
  assert.equal(box.hidden, false);
  var esc = fire(P, "keydown", ev({key: "Escape"}));
  assert.equal(box.hidden, true);
  assert.ok(esc.stopped && esc.prevented);
});

test("lightbox: Esc is taken in the capture phase, and only while the lightbox is open", function () {
  var P = load();
  var keys = P.listeners.keydown;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].cap, true);
  var idle = fire(P, "keydown", ev({key: "Escape"}));
  assert.ok(!idle.stopped && !idle.prevented, "closed: the page's own Esc handling runs");
  fire(P, "click", ev({target: pic("/asset/x.png", "m")}));
  var other = fire(P, "keydown", ev({key: "j"}));
  assert.ok(!other.stopped && !other.prevented, "open: other keys are not touched");
});

// ---- the pipelines details block ----
function details() {
  var cap = "window.__T = null; (function () { var d = window.ReviewApp.define; window.ReviewApp.define = function (t) {" +
    " var f = typeof t === 'function' ? function (A) { return (window.__T = t(A)); } : (window.__T = t); return d.call(this, f); }; })();";
  var store = {caps: {decide: true}, whoami: function () { return Promise.resolve("BL"); },
               load: function () { return Promise.resolve({built: "2026-10-01T00:00:00-04:00", dirs: ["a"], cards: []}); },
               decide: function () { return Promise.resolve([]); }, item: function () { return Promise.resolve([]); }};
  var P = stub.page({globals: {StaticStore: store}, before: opts_geo(), after: [[cap, "wrap.js"], [PIPELINES_EXT, "ext.js"]]});
  return P.booted.then(function () { return P.ctx.__T.lineDetails; });
}
function opts_geo() { return [[GEO_JS, "geo.js"]]; }

var PROV = {
  text: "Traced from a <scanned> map.",
  facts: [["map", "Wall map 1998"], ["scale", "1:500 000", "https://example.org/scale"]],
  images: [{role: "map", caption: "the map", asset: SHA + ".jpg", width: 800, height: 600}],
  control_points: [{name: "A", px: [1, 2], lon: 40, lat: 30, ref: "https://example.org/a", residual_km: 1.234}]
};

test("pipelines details: provenance leads the block, before the notes, and the label says so", function () {
  return details().then(function (fn) {
    var h = fn({notes: "a note", provenance: PROV});
    assert.match(h, /<summary>how this route was made, notes<\/summary>/);
    assert.match(h, /<p class="rprov">Traced from a &lt;scanned&gt; map\.<\/p>/);
    assert.match(h, /<table class="rfacts"><tbody><tr><th>map<\/th><td>Wall map 1998<\/td><\/tr><tr><th>scale<\/th><td><a href="https:\/\/example\.org\/scale" target="_blank" rel="noopener">1:500 000<\/a><\/td><\/tr>/);
    assert.match(h, /<figure class="rimg"><img loading="lazy" src="\/asset\//);
    assert.match(h, /<table class="rcpts">/);
    assert.ok(h.indexOf("rprov") < h.indexOf("rfacts") && h.indexOf("rfacts") < h.indexOf("rimgs") && h.indexOf("rimgs") < h.indexOf("rcpts") && h.indexOf("rcpts") < h.indexOf("researcher notes"));
  });
});

test("pipelines details: a line without provenance keeps its label and gains nothing", function () {
  return details().then(function (fn) {
    var h = fn({notes: "a note"});
    assert.match(h, /<summary>notes<\/summary>/);
    assert.ok(h.indexOf("rprov") < 0 && h.indexOf("rimgs") < 0 && h.indexOf("rcpts") < 0);
  });
});

test("pipelines details: without ReviewGeo the text and facts still render", function () {
  var cap = "window.__T = null; (function () { var d = window.ReviewApp.define; window.ReviewApp.define = function (t) {" +
    " var f = typeof t === 'function' ? function (A) { return (window.__T = t(A)); } : (window.__T = t); return d.call(this, f); }; })();";
  var store = {caps: {decide: true}, whoami: function () { return Promise.resolve("BL"); },
               load: function () { return Promise.resolve({built: "2026-10-01T00:00:00-04:00", dirs: ["a"], cards: []}); },
               decide: function () { return Promise.resolve([]); }, item: function () { return Promise.resolve([]); }};
  var P = stub.page({globals: {StaticStore: store}, after: [[cap, "wrap.js"], [PIPELINES_EXT, "ext.js"]]});
  return P.booted.then(function () {
    assert.equal(P.ctx.ReviewGeo, undefined);
    var h = P.ctx.__T.lineDetails({provenance: PROV});
    assert.match(h, /rprov/);
    assert.match(h, /rfacts/);
    assert.ok(h.indexOf("rimgs") < 0 && h.indexOf("rcpts") < 0);
  });
});
