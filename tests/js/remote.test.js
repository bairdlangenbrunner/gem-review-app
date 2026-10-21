// Records that reach the page after it loaded (another viewer, another browser of the same person) land through app.js applyRemote.
// With the single-file page's store (static_store.js) they land by the store's speaker rules, the same rules the page's load and the Python store (store.speaker) use:
// a person's live call keeps speaking over a later machine record, a person's undo over an earlier call, a record under an older key speaks for a line with no person record of its own,
// and a record older than the call the page was built with does not speak over it. A store without those rules (gas.js) lays the records on one at a time.
// static_store.js and app.js are loaded whole in one stub page (stub_page.js); the records are put in the store's log, then handed to applyRemote, as deliver() does.
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var stub = require("./stub_page.js");

var STORE_JS = fs.readFileSync(path.join(stub.ROOT, "review_core", "web", "static_store.js"), "utf8");
var PIPELINES_EXT = fs.readFileSync(path.join(stub.ROOT, "trackers", "pipelines", "web", "ext.js"), "utf8");
var plain = stub.plain;

var T0 = "2026-10-09T09:00:00-04:00";
function at(min) { return "2026-10-09T10:" + (min < 10 ? "0" : "") + min + ":00-04:00"; }
function line(n, extra) {
  var l = {key: "a::W1:" + n, pid: "W1", dir: "a", kind: "change", column: "c" + n, severity: "major", tier: "high",
           decision: null, reviewed: false, decided_by: null, decided_at: null, suggested_value: "", decision_note: ""};
  Object.keys(extra || {}).forEach(function (k) { l[k] = extra[k]; });
  return l;
}
// W1: four open lines and one a person decided at 10:30 when the page was built, plus an open item
function dataset() {
  return {
    built: T0, dirs: ["a"],
    cards: [{pid: "W1", name: "widget one", dir: "a",
             lines: [line(0), line(1), line(2), line(3), line(4, {decision: "accept", reviewed: true, decided_by: "XY", decided_at: at(30)})],
             items: [{key: "a::W1:qa-1", pid: "W1", dir: "a", kind: "concern", call: null, reviewed: false, decided_by: null, decided_at: null}]}]
  };
}
function rec(key, who, min, extra) {
  var r = {id: key + "~" + who + "~" + min, key: key, dir: "a", pid: "W1", kind: "change", decision: "accept", suggested_value: "", note: "",
           reviewer: who, ts: at(min), undecided: false};
  Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
  return r;
}

// the page with static_store.js as its store; tracker: [source, filename] pairs loaded after app.js
// log: records already in this browser's log when the page loads
function page(tracker, log) {
  var ls = stub.memoryStorage();
  if (log) ls.setItem("review-log:" + T0 + ":a", JSON.stringify(log));
  var P = stub.page({
    globals: {REVIEW_STATIC: {reviewer: "BL", data: dataset(), legacy: {"a::W1:2": ["a::W1:2-old"]}, tracker: {}}, localStorage: ls},
    before: [[STORE_JS, "static_store.js"]], after: tracker || []
  });
  return P;
}
// the records arrive: into the store's log first (the shared log a viewer sees), then onto the page
function arrive(P, recs) {
  var G = P.ctx.StaticStore.state;
  G.own = G.own.concat(recs);
  return P.app.applyRemote(recs);
}
function shown(P, key) {
  var o = P.app.api.LINE_BY_KEY[key] || P.app.api.ITEM_BY_KEY[key];
  return plain({decision: o._item ? o.call : o.decision, reviewed: o.reviewed, by: o.decided_by, at: o.decided_at});
}

test("a person's call keeps speaking over a later machine record", function () {
  var P = page();
  return P.booted.then(function () {
    var n = arrive(P, [rec("a::W1:0", "AL", 1), rec("a::W1:0", "push", 2)]);
    assert.equal(n, 1);
    assert.deepEqual(shown(P, "a::W1:0"), {decision: "accept", reviewed: true, by: "AL", at: at(1)});
  });
});

test("a machine record alone speaks but is not a person's call", function () {
  var P = page();
  return P.booted.then(function () {
    arrive(P, [rec("a::W1:0", "push", 2)]);
    assert.deepEqual(shown(P, "a::W1:0"), {decision: "accept", reviewed: false, by: "push", at: at(2)});
    assert.equal(P.app.api.isOpen(P.app.api.LINE_BY_KEY["a::W1:0"]), true);
  });
});

test("a person's undo after a machine record leaves the line undecided", function () {
  var P = page();
  return P.booted.then(function () {
    arrive(P, [rec("a::W1:1", "AL", 1), rec("a::W1:1", "push", 2), rec("a::W1:1", "AL", 3, {undecided: true})]);
    assert.deepEqual(shown(P, "a::W1:1"), {decision: null, reviewed: false, by: null, at: null});
  });
});

test("a record under an older key speaks for a line with no person record of its own", function () {
  var P = page();
  return P.booted.then(function () {
    var n = arrive(P, [rec("a::W1:2-old", "AL", 1, {decision: "hold"})]);
    assert.equal(n, 1);
    assert.deepEqual(shown(P, "a::W1:2"), {decision: "hold", reviewed: true, by: "AL", at: at(1)});
    arrive(P, [rec("a::W1:2", "BL", 2, {decision: "reject"})]);           // the line's own call speaks first
    assert.deepEqual(shown(P, "a::W1:2"), {decision: "reject", reviewed: true, by: "BL", at: at(2)});
  });
});

test("a record older than the call the page was built with does not speak over it", function () {
  var P = page();
  return P.booted.then(function () {
    var n = arrive(P, [rec("a::W1:4", "AL", 10, {decision: "hold"})]);
    assert.equal(n, 0);
    assert.deepEqual(shown(P, "a::W1:4"), {decision: "accept", reviewed: true, by: "XY", at: at(30)});
    arrive(P, [rec("a::W1:4", "AL", 40, {decision: "hold"})]);            // a newer one does
    assert.deepEqual(shown(P, "a::W1:4"), {decision: "hold", reviewed: true, by: "AL", at: at(40)});
  });
});

test("item calls land by the same rules", function () {
  var P = page();
  return P.booted.then(function () {
    var c = {kind: "concern", call: "dismissed"};
    delete c.decision;
    var r = rec("a::W1:qa-1", "AL", 1, c);
    delete r.decision; delete r.suggested_value;
    arrive(P, [r]);
    assert.deepEqual(shown(P, "a::W1:qa-1"), {decision: "dismissed", reviewed: true, by: "AL", at: at(1)});
  });
});

test("a store without the speaker rules lays the records on one at a time", function () {
  var data = dataset(), P = stub.page({globals: {StaticStore: {
    caps: {decide: true}, whoami: function () { return Promise.resolve("BL"); }, load: function () { return Promise.resolve(data); },
    decide: function () { return Promise.resolve([]); }, item: function () { return Promise.resolve([]); }}}});
  return P.booted.then(function () {
    var n = P.app.applyRemote([rec("a::W1:0", "AL", 1, {decision: "hold"}), rec("a::W1:2-old", "AL", 1)]);
    assert.equal(n, 1);                                                    // the older key is not on the page
    assert.deepEqual(shown(P, "a::W1:0"), {decision: "hold", reviewed: true, by: "AL", at: at(1)});
    assert.deepEqual(shown(P, "a::W1:2"), {decision: null, reviewed: false, by: null, at: null});
  });
});

test("pipelines: a push after a person's call marks the line applied and the call keeps speaking", function () {
  var P = page([[PIPELINES_EXT, "ext.js"]]);
  return P.booted.then(function () {
    var A = P.app.api, l = A.LINE_BY_KEY["a::W1:0"];
    arrive(P, [rec("a::W1:0", "AL", 1), rec("a::W1:0", "push", 2)]);
    assert.deepEqual(shown(P, "a::W1:0"), {decision: "accept", reviewed: true, by: "AL", at: at(1)});
    assert.deepEqual(plain(l.applied), {by: "push", at: at(2)});
    assert.equal(A.counted(l), false);                                     // a pushed line is not waiting on a call
  });
});

test("pipelines: a push in the browser's log shows as applied when the page loads", function () {
  var P = page([[PIPELINES_EXT, "ext.js"]], [rec("a::W1:0", "AL", 1), rec("a::W1:0", "push", 2)]);
  return P.booted.then(function () {
    var l = P.app.api.LINE_BY_KEY["a::W1:0"];
    assert.deepEqual(shown(P, "a::W1:0"), {decision: "accept", reviewed: true, by: "AL", at: at(1)});
    assert.deepEqual(plain(l.applied), {by: "push", at: at(2)});
  });
});
