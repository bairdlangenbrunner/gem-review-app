// Parity between the page's store (review_core/web/static_store.js) and the Python store (review_core/store.py).
// parity_world.py builds a real page for the made-up tracker in tests/conftest.py and says what the Python store makes of each fixture. This file loads static_store.js the way the page does, in a fresh VM context with a stub browser, and checks the page's store says the same.
// Run with: node --test tests/js
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var cp = require("node:child_process");
var zlib = require("node:zlib");

var HERE = __dirname;
var STORE_JS = fs.readFileSync(path.join(HERE, "..", "..", "review_core", "web", "static_store.js"), "utf8");
var FIXTURES = path.join(HERE, "fixtures");
var PYTHON = process.env.PYTHON || "python3";

function world(mode, file) {
  var out = cp.execFileSync(PYTHON, [path.join(HERE, "parity_world.py"), mode, path.join(FIXTURES, file)], {maxBuffer: 256 * 1024 * 1024});
  return JSON.parse(out.toString("utf8"));
}

// a localStorage that lives in memory
function memoryStorage(seed) {
  var m = {};
  Object.keys(seed || {}).forEach(function (k) { m[k] = String(seed[k]); });
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    key: function (i) { return Object.keys(m)[i] || null; },
    get length() { return Object.keys(m).length; }
  };
}

// static_store.js in its own context: window is the context itself, the blob sits in #review-blob, and the browser log is in localStorage
function loadStore(w, browser) {
  var seed = {};
  if (browser) seed[w.log_key] = JSON.stringify(browser);
  var ctx = {
    REVIEW_STATIC: w.static,
    localStorage: memoryStorage(seed),
    document: {getElementById: function (id) { return id === "review-blob" ? {textContent: w.blob} : null; }},
    DecompressionStream: DecompressionStream, Response: Response, Blob: Blob, atob: atob, crypto: globalThis.crypto,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, console: console
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(STORE_JS, ctx, {filename: "static_store.js"});
  assert.ok(ctx.StaticStore, "static_store.js did not set window.StaticStore");
  return ctx.StaticStore;
}

// objects made in the VM context have that context's prototypes; a JSON round trip makes them plain objects of this one
function plain(v) { return JSON.parse(JSON.stringify(v)); }

// the line or item each card holds, by key, so a failure names the key that differs
function byKey(data) {
  var out = {};
  (data.widgets || []).forEach(function (p) {
    var card = {};
    Object.keys(p).forEach(function (k) { if (k !== "lines" && k !== "items") card[k] = p[k]; });
    out["card " + p.dir + "::" + p.pid] = card;
    ["lines", "items"].forEach(function (g) { (p[g] || []).forEach(function (o) { out[o.key] = o; }); });
  });
  return out;
}

var OVERLAYS = {
  "calls.jsonl": "accept, hold, suggest and item calls",
  "undo.jsonl": "undo on a line and an item, and a call after an undo",
  "legacy.jsonl": "records under older keys",
  "machine.jsonl": "machine reviewers before and after a person",
  "order.jsonl": "records out of time order in the file, and mixed time zones",
  "markers.jsonl": "stars on lines, items and cards",
  "split.jsonl": "a page built with part of the log, the rest in the browser"
};

Object.keys(OVERLAYS).forEach(function (file) {
  test("overlay parity: " + OVERLAYS[file] + " (" + file + ")", function () {
    var w = world("overlay", file);
    var store = loadStore(w, w.browser);
    return store.load().then(function (data) {
      var got = byKey(plain(data)), want = byKey(w.expected);
      assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
      Object.keys(want).forEach(function (k) { assert.deepEqual(got[k], want[k], "the page and the store differ on " + k); });
      assert.deepEqual(plain(data), w.expected);
    });
  });
});

test("an empty browser log leaves the built page as it is", function () {
  var w = world("overlay", "split.jsonl");
  var store = loadStore(w, null);
  return store.load().then(function (data) {
    var shown = JSON.parse(zlib.gunzipSync(Buffer.from(w.blob, "base64")).toString("utf8"));
    assert.deepEqual(plain(data), shown.data);
    assert.notDeepEqual(shown.data, w.expected);      // the fixture's browser records do change the page
  });
});

// the store's message without the hint the page has no use for (the loopback route to send it to instead)
function message(s) { return String(s).replace(/ \(use \/api\/\w+\)$/, ""); }
function stripStamp(recs) { return recs.map(function (r) { var c = {}; Object.keys(r).forEach(function (k) { if (k !== "ts" && k !== "id") c[k] = r[k]; }); return c; }); }

test("validation parity: the page refuses and keeps exactly what the store does", function () {
  var w = world("requests", "requests.json");
  var store = loadStore(w, null);
  var p = Promise.resolve();
  w.cases.forEach(function (c) {
    p = p.then(function () {
      assert.equal(typeof store[c.via], "function", "the page store has no " + c.via);
      return store[c.via](c.records).then(function (saved) {
        assert.ok(!c.error, c.what + ": the page took a request the store refuses (" + c.error + ")");
        assert.deepEqual(stripStamp(plain(saved)), stripStamp(c.ok), c.what);
      }, function (e) {
        assert.ok(c.error, c.what + ": the page refused a request the store takes (" + e.message + ")");
        assert.equal(e.message, message(c.error), c.what);
      });
    });
  });
  return p;
});

test("the page reads its limits and patterns from the page block", function () {
  var w = world("requests", "requests.json");
  w.static.tracker.rules = Object.assign({}, w.static.tracker.rules, {max_text: 5, max_records: 2, url: "^https://\\S+$"});
  var store = loadStore(w, null);
  return Promise.all([
    store.decide([{key: "a::W1:size", decision: "accept", note: "123456"}]).then(function () { assert.fail("took a long note"); },
      function (e) { assert.equal(e.message, "record 0: the note is longer than 5 characters"); }),
    store.decide([1, 2, 3]).then(function () { assert.fail("took three records"); },
      function (e) { assert.equal(e.message, "too many records in one request (3)"); }),
    store.decide([{key: "a::W1:size", decision: "accept", reference: "http://example.com"}]).then(function () { assert.fail("took http"); },
      function (e) { assert.match(e.message, /is not a web address/); })
  ]);
});

test("an empty line_kinds list refuses every line, as the store does", function () {
  var w = world("requests", "requests.json");
  w.static.tracker.line_kinds = [];
  var store = loadStore(w, null);
  return store.decide([{key: "a::W1:size", decision: "accept"}]).then(function () { assert.fail("took a line of an unlisted kind"); },
    function (e) { assert.equal(e.message, "record 0: 'a::W1:size' is an item, not a line"); });
});
