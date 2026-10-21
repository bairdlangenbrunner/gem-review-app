// One rule for what is left to decide: app.js counts a line only when the tracker's T.counted says so, and every place that counts open lines has to agree.
// The places: the filter (match) and its "undecided" chip count (facetCounts), the queue badge (_todo), the card's tab counts, "card done" (hide done), "next undecided", the bulk buttons and bulk accept (bulkTargets).
// The tracker rule is the pipelines one, taken from trackers/pipelines/web/ext.js: counted(l) is !landed(l), and a line has landed when the backend already holds it (in_backend) or a push applied it.
// app.js is loaded whole, in a fresh VM context with a small stub of the page (stub_page.js), and booted the way the page boots it.
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var stub = require("./stub_page.js");

var PIPELINES_EXT = fs.readFileSync(path.join(stub.ROOT, "trackers", "pipelines", "web", "ext.js"), "utf8");
var noop = stub.noop, plain = stub.plain;

// the pipelines rule, as its ext.js writes it
function pipelinesRule() {
  var landed = /function landed\(l\) \{[^\n]*\}/.exec(PIPELINES_EXT);
  assert.ok(landed, "trackers/pipelines/web/ext.js no longer has function landed(l) on one line: update this test");
  assert.match(PIPELINES_EXT, /counted: function \(l\) \{ return !landed\(l\); \}/, "the pipelines counted rule changed: update this test");
  return landed[0];
}

// the page with a store that keeps what it is asked to save, and the pipelines counted rule as the tracker
function page(data) {
  var saved = [];
  var store = {
    caps: {decide: true},
    whoami: function () { return Promise.resolve("BL"); },
    load: function () { return Promise.resolve(data); },
    decide: function (records) { saved.push(records); return Promise.resolve([]); },
    item: function () { return Promise.resolve([]); }
  };
  var P = stub.page({globals: {StaticStore: store},
    after: [[pipelinesRule() + "\nwindow.ReviewApp.define({counted: function (l) { return !landed(l); }});", "tracker.js"]]});
  P.saved = saved;
  return P;
}

// ---- the dataset: three cards ----
// W1: one open major line, one major line the backend holds, one decided minor line, one minor line a push applied, and an item.
// W2: a major line the backend holds and a held minor line: nothing left to decide, so the card is done.
// W3: two open major lines.
function line(pid, n, sev, extra) {
  var l = {key: "a::" + pid + ":" + n, pid: pid, dir: "a", kind: "change", column: "c" + n, severity: sev, tier: "high",
           decision: null, reviewed: false, decided_by: null, decided_at: null};
  Object.keys(extra || {}).forEach(function (k) { l[k] = extra[k]; });
  return l;
}
function dataset() {
  var done = {decision: "accept", reviewed: true, decided_by: "AL", decided_at: "2026-10-09T10:00:00-04:00"};
  return {
    built: "2026-10-09T09:00:00-04:00", dirs: ["a"],
    cards: [
      {pid: "W1", name: "widget one", dir: "a", lines: [
        line("W1", 0, "major"),
        line("W1", 1, "major", {in_backend: true}),
        line("W1", 2, "minor", done),
        line("W1", 3, "minor", {applied: {by: "push", at: "2026-10-09T10:00:00-04:00"}})],
       items: [{key: "a::W1:qa-1", pid: "W1", dir: "a", kind: "concern", call: null}]},
      {pid: "W2", name: "widget two", dir: "a", lines: [
        line("W2", 0, "major", {in_backend: true}),
        line("W2", 1, "minor", {decision: "hold", reviewed: true, decided_by: "AL", decided_at: "2026-10-09T10:00:00-04:00"})], items: []},
      {pid: "W3", name: "widget three", dir: "a", lines: [line("W3", 0, "major"), line("W3", 1, "major")], items: []}
    ]
  };
}
function find(A, pid) { var hit = -1; A.cards().forEach(function (p, i) { if (p.pid === pid) hit = i; }); return hit; }
function show(P, filters) {
  var A = P.app.api, fs0 = A.defaults();
  Object.keys(filters || {}).forEach(function (k) { fs0[k] = filters[k]; });
  A.FS = fs0;
  A.refilter(true);
}

test("app.js loads and boots in a stub page", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    assert.equal(P.app.api.cards().length, 3);
    assert.equal(P.app.api.LINES.length, 8);
  });
});

test("counted and isOpen follow the tracker rule", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api, L = A.LINE_BY_KEY;
    assert.equal(A.counted(L["a::W1:0"]), true);
    assert.equal(A.counted(L["a::W1:1"]), false);      // the backend holds it
    assert.equal(A.counted(L["a::W1:3"]), false);      // a push applied it
    assert.equal(A.isOpen(L["a::W1:0"]), true);
    assert.equal(A.isOpen(L["a::W1:1"]), false);
    assert.equal(A.isOpen(L["a::W1:2"]), false);       // decided
    assert.equal(A.counted(A.ITEM_BY_KEY["a::W1:qa-1"]), true);   // items always count
  });
});

test("the undecided view, its chip count and the queue badge count the same lines", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api;
    show(P, {decision: "undecided"});
    var listed = A.LINES.filter(function (l) { return A.match(l, A.cards()[l._p], A.FS, null, ""); }).map(function (l) { return l.key; });
    assert.deepEqual(plain(listed).sort(), ["a::W1:0", "a::W3:0", "a::W3:1"]);
    var chip = A.facetCounts("decision", ["undecided", "accept", "hold", "reject", "suggest"]);
    assert.equal(chip.undecided, listed.length);
    assert.equal(chip.accept, 1);
    assert.equal(chip.hold, 1);
    var todo = 0;
    A.cards().forEach(function (p) { todo += p._todo; });
    assert.equal(todo, listed.length);
    assert.deepEqual(plain(A.cards().map(function (p) { return p._todo; })), [1, 0, 2]);
    assert.deepEqual(plain(A.cards()[find(A, "W1")]._tsev), {major: 1, minor: 0});
    assert.deepEqual(plain(A.S.visible), [find(A, "W1"), find(A, "W3")]);       // W2 has nothing left to decide
  });
});

test("the badge and hide done agree with the count", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api;
    show(P, {decision: ""});
    A.S.pipe = find(A, "W1");
    A.S.hideDone = false;
    A.renderQueue();
    var html = P.$("pipes").innerHTML;
    assert.match(html, /data-i="0"[\s\S]*1 major to decide/);
    assert.match(html, /data-i="1"[\s\S]*2 &middot; done/);
    assert.match(html, /data-i="2"[\s\S]*2 major to decide/);
    A.S.hideDone = true;
    A.renderQueue();
    html = P.$("pipes").innerHTML;
    assert.doesNotMatch(html, /data-i="1"/, "W2 is done and hide done drops it");
    assert.match(html, /data-i="0"/);
    assert.match(html, /data-i="2"/);
  });
});

test("the tab counts leave out the lines the tracker does not count", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api;
    show(P, {decision: ""});
    A.S.pipe = find(A, "W1");
    A.renderCard();
    var html = P.$("card").innerHTML;
    assert.match(html, /major changes \(1 to decide\)/);
    assert.match(html, /minor changes \(1, all decided\)/);
    A.S.pipe = find(A, "W2");
    A.renderCard();
    html = P.$("card").innerHTML;
    assert.match(html, /major changes \(0\)/);
    assert.match(html, /minor changes \(1, all decided\)/);
  });
});

test("next undecided skips the lines the tracker does not count", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api, L = A.LINE_BY_KEY;
    show(P, {decision: ""});
    A.S.pipe = find(A, "W1");
    A.S.shown = [L["a::W1:1"]._i, L["a::W1:3"]._i, L["a::W1:0"]._i];
    A.S.line = A.S.shown[0];
    A.nextUndecided();
    assert.equal(A.S.line, L["a::W1:0"]._i);
    A.S.shown = [L["a::W1:0"]._i, L["a::W1:1"]._i, L["a::W1:2"]._i, L["a::W1:3"]._i];
    A.S.line = A.S.shown[0];
    A.nextUndecided();      // nothing open after it on this card: on to the next card
    assert.notEqual(A.S.pipe, find(A, "W1"));
  });
});

function bulk(P, mode) {
  var btn = {getAttribute: function (k) { return k === "data-bulk" ? mode : null; }};
  var ev = {target: {closest: function (sel) { return sel === "button[data-bulk]" ? btn : null; }}, preventDefault: noop, stopPropagation: noop};
  (P.$("card")._listeners.click || []).forEach(function (fn) { fn(ev); });
  return P.$("dialog").innerHTML;
}

test("bulk accept takes the counted lines and names the rest", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api;
    show(P, {decision: ""});
    A.S.pipe = find(A, "W1");
    var html = bulk(P, "bulk-all");
    assert.match(html, /<b>1 change<\/b> will be accepted/);
    assert.match(html, /2 not waiting on a call/);
    assert.match(html, /1 already decided/);
  });
});

test("a card with only uncounted lines left has nothing to bulk accept", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api;
    show(P, {decision: ""});
    A.S.pipe = find(A, "W2");
    P.$("dialog").innerHTML = "";
    bulk(P, "bulk-all");
    assert.equal(P.$("dialog").innerHTML, "", "no dialog: the toast says there is nothing to accept");
  });
});

// The bulk buttons follow isOpen as bulk accept does: on W1 the only undecided minor line has landed, so "accept all minor changes" is drawn off.
test("the bulk buttons are enabled only when a counted line is left", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api, L = A.LINE_BY_KEY;
    show(P, {decision: ""});
    A.S.pipe = find(A, "W1");
    A.renderCard();
    var html = P.$("card").innerHTML;
    assert.match(html, /class="bulk b-accept off" data-bulk="bulk-minor"/, "accept all minor changes is drawn enabled");
    assert.match(html, /no minor change on this card is waiting on a call/);
    L["a::W1:3"].applied = null;          // the push never happened: the minor line is open again
    A.renderCard();
    assert.match(P.$("card").innerHTML, /class="bulk b-accept" data-bulk="bulk-minor"/, "accept all minor changes is drawn off");
  });
});
