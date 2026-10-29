// The LNG tracker extension (trackers/lng/web/ext.js) in the stub page: linked pairs, the suggest form, the vocabularies, the header buttons and the rules it adds to the single-file store.
// Nothing here calls a push endpoint: the store stub has no network and the push button is never clicked.
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var stub = require("./stub_page.js");
var plain = stub.plain;

var EXT = fs.readFileSync(path.join(stub.ROOT, "trackers", "lng", "web", "ext.js"), "utf8");

function line(pid, column, extra) {
  var l = {key: "a::" + pid + ":" + column, pid: pid, dir: "a", kind: "fill", id: pid + "|" + column, row_id: pid, column: column, live_row: 12,
           current: "", proposed: "100", refs: [{url: "https://example.org/x", verdict: "verified"}], current_refs: [], flags: [], links: [],
           confidence: "G", tier: "high", severity: "major", default: "accept", prefill: "accept",
           decision: null, reviewed: false, decided_by: null, decided_at: null};
  Object.keys(extra || {}).forEach(function (k) { l[k] = extra[k]; });
  return l;
}
function dataset() {
  var v1 = [line("V1", "Name", {proposed: "Arctic Spirit", links: ["a::V1:Other names"]}), line("V1", "Other names", {links: ["a::V1:Name"]}),
            line("V1", "Price", {links: ["a::V1:Price currency"]}), line("V1", "Price currency", {proposed: "USD", links: ["a::V1:Price"]}),
            line("V1", "Capacity [ref]", {kind: "ref", flags: ["ref_only"]}),
            line("V1", "Status", {flags: ["ref_only"]})];
  return {
    built: "2026-10-29T09:00:00-04:00", backend_pulled: "2026-10-29T08:00:00-04:00", dirs: ["a"], header: ["Name", "Other names", "Price"],
    batches: [{dir: "a", mode: "fix", label: "fix a", apply_order: 1, applied: false, counts: {}, n: 6}],
    vessels: [
      {pid: "V1", dir: "a", name: "Arctic Spirit", live_row: 12, new: false, in_backend: true, row_id: "V1", imo: "9876543", status: "active", shipbuilder: "Hanwha", shipowner: "Teekay", hull: "3301", delivery_year: "2027", lines: v1, items: []},
      {pid: "c:a:7", dir: "a", name: "Hull 5 (Jiangnan)", live_row: null, new: true, in_backend: false, cluster_id: "7", lines: [line("c:a:7", null, {kind: "new_row", id: "cluster:7", column: null, row_id: null, cluster_id: "7", row_data: {Name: "Hull 5 (Jiangnan)", "Name [ref]": "https://example.org/n", Status: "under construction"}})], items: []},
      {pid: "items", dir: "a", name: "items", live_row: null, new: false, lines: [], items: [
        {key: "a::conflict:0", dir: "a", pid: "items", kind: "conflict", title: "Price differs", detail: "research says 1", urls: ["https://example.org/c"], live_rows: [12], row_ids: ["V1"], conflict_index: 0, conflict_match: ["V1", "Price"], conflict_decision: "hold", backend_resolved: "", call: null, reviewed: false, logged_call: "accept"},
        {key: "a::manual:0", dir: "a", pid: "items", kind: "manual", title: "check the yard", detail: "d", urls: [], live_rows: [], row_ids: [], backend_resolved: "", call: null, reviewed: false}]}
    ]
  };
}
var TS = 0;
function page(caps) {
  var saved = [], hooks = null;
  var store = {
    caps: caps || {decide: true, refresh: false, push: false},
    whoami: function () { return Promise.resolve("BL"); },
    load: function () { return Promise.resolve(dataset()); },
    extend: function (h) { hooks = h; },
    decide: function (records) {
      saved.push(plain(records));
      return Promise.resolve(records.map(function (r) {
        var out = {key: r.key, decision: r.decision || "hold", undecided: !!r.undo, reviewer: "BL", ts: "2026-10-29T10:00:" + String(TS++ % 60).padStart(2, "0") + "-04:00",
                   suggested_value: r.suggested_value || "", reference: "", note: r.note || "", suggest_kind: r.suggest_kind || "", suggested_refs: r.suggested_refs || []};
        if (r.via) out.via = r.via;
        return out;
      }));
    },
    item: function () { return Promise.resolve([]); }
  };
  var P = stub.page({globals: {StaticStore: store}, after: [[EXT, "ext.js"]]});
  P.saved = saved;
  P.hooks = function () { return hooks; };
  return P;
}
function tick() { return new Promise(function (ok) { setTimeout(ok, 5); }); }
function lineAt(A, pid, column) { return A.LINE_BY_KEY["a::" + pid + ":" + column]; }
var API = {refuse: function (m) { return new Error(m); }, str: function (v) { return v == null ? "" : String(v); }};

test("the extension registers and the page boots on vessels", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api;
    assert.equal(A.cards().length, 3);
    assert.equal(A.LINES.length, 7);
    assert.ok(P.hooks() && P.hooks().lineRequest && P.hooks().lineRecord && P.hooks().overlay, "the store is extended");
  });
});

test("Name and Other names are decided together; Price and Price currency are asked about", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, name = lineAt(A, "V1", "Name");
    A.save(name, {key: name.key, decision: "accept"});
    assert.ok(P.$("dialog").open);
    assert.match(P.$("dialog").innerHTML, /decided together/);
    assert.doesNotMatch(P.$("dialog").innerHTML, /dlg-one/);
    P.$("dlg-both").onclick();
    return tick().then(function () {
      assert.deepEqual(P.saved[0].map(function (r) { return [r.key, r.via || ""]; }), [["a::V1:Name", ""], ["a::V1:Other names", "linked"]]);
      P.$("dialog").open = false;
      var price = lineAt(A, "V1", "Price");
      A.save(price, {key: price.key, decision: "reject"});
      assert.match(P.$("dialog").innerHTML, /dlg-one/);
    });
  });
});

test("a value line takes a suggest; a new row, a ref line and a ref-only line do not", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, T = P.ctx.ReviewApp.tracker || null;
    function can(l) { return A.lineActions ? A.lineActions(l).suggest : null; }
    var fill = lineAt(A, "V1", "Price");
    assert.ok(fill && lineAt(A, "V1", "Status") && lineAt(A, "V1", "Capacity [ref]"));
    if (A.lineActions) {
      assert.equal(can(fill), true);
      assert.equal(can(lineAt(A, "V1", "Status")), false);
      assert.equal(can(lineAt(A, "V1", "Capacity [ref]")), false);
      assert.equal(can(A.LINES.filter(function (l) { return l.kind === "new_row"; })[0]), false);
    }
  });
});

test("the suggest form needs a value and a note, refuses the proposed value, then saves the kind and refs", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, price = lineAt(A, "V1", "Price"), form = null, parts = {};
    var doc = P.ctx.document, make = doc.createElement;
    doc.createElement = function (tag) {
      var e = make(tag);
      e.querySelector = function (sel) { return parts[sel] || (parts[sel] = stub.element(sel)); };
      if (tag === "form") form = e;
      return e;
    };
    P.$("line-" + price._i).querySelector = function () { return stub.element("controls"); };
    A.openSuggest(price);
    assert.ok(form);
    assert.match(form.innerHTML, /lng-sv/);
    var err = function () { return form.querySelector(".sv-err").textContent; };
    function go() { form.onsubmit({preventDefault: function () {}}); }
    function set(v, n, r, k) {
      form.querySelector(".lng-sv").value = v; form.querySelector(".lng-sn").value = n; form.querySelector(".lng-sr").value = r;
      form.querySelector("input[name=lng-kind]:checked").value = k;
    }
    set("", "n", "", "value"); go();
    assert.equal(err(), "a suggestion needs a value");
    set("120", "", "", "value"); go();
    assert.equal(err(), "a suggestion needs a note");
    set("100", "n", "", "value"); go();
    assert.match(err(), /proposed value/);
    set("120", "n", "https://example.org/a\nnot-a-url", "value"); go();
    assert.equal(err(), "not a URL: not-a-url");
    assert.equal(P.saved.length, 0);
    set("120", "yard says so", "https://example.org/a, https://example.org/b", "cosmetic"); go();
    return tick().then(function () {
      assert.equal(P.saved.length, 1);
      var r = P.saved[0][0];
      assert.equal(r.decision, "suggest");
      assert.equal(r.suggested_value, "120");
      assert.equal(r.suggest_kind, "cosmetic");
      assert.deepEqual(r.suggested_refs, ["https://example.org/a", "https://example.org/b"]);
      assert.equal(price.suggest_kind, "cosmetic");
      assert.deepEqual(plain(price.suggested_refs), ["https://example.org/a", "https://example.org/b"]);
    });
  });
});

test("items: a conflict offers accept, hold and reject; the rest resolved and needs_research", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, c = A.ITEM_BY_KEY["a::conflict:0"], m = A.ITEM_BY_KEY["a::manual:0"];
    assert.ok(c && m);
    var html = P.$("card").innerHTML + P.$("cards").innerHTML + P.$("list").innerHTML;
    assert.equal(typeof html, "string");
  });
});

test("the sync and push buttons follow the store's caps", function () {
  var P1 = page();
  return P1.booted.then(function () {
    assert.equal(P1.$("sync").hidden, true);
    assert.equal(P1.$("push").hidden, true);
    var P2 = page({decide: true, refresh: true, push: true});
    return P2.booted.then(function () {
      assert.equal(P2.$("sync").hidden, false);
      assert.equal(P2.$("push").hidden, false);
      assert.equal(typeof P2.$("push").onclick, "function");
    });
  });
});

test("the store rules: a suggest needs a value and a note, a valid kind and http(s) refs", function () {
  var P = page();
  return P.booted.then(function () {
    var h = P.hooks(), fill = {obj: {kind: "fill", flags: []}};
    function req(r, e) { return h.lineRequest(0, r, e || fill, API); }
    assert.throws(function () { req({decision: "suggest", note: "n"}); }, /needs a value/);
    assert.throws(function () { req({decision: "suggest", suggested_value: "1"}); }, /needs a note/);
    assert.throws(function () { req({decision: "suggest", suggested_value: "1", note: "n", suggest_kind: "weird"}); }, /not one of value, cosmetic/);
    assert.throws(function () { req({decision: "suggest", suggested_value: "1", note: "n", suggested_refs: ["ftp://x"]}); }, /not an http\(s\) URL/);
    assert.throws(function () { req({decision: "suggest", suggested_value: "1", note: "n"}, {obj: {kind: "new_row", flags: []}}); }, /nothing to suggest on a new_row line/);
    assert.throws(function () { req({decision: "suggest", suggested_value: "1", note: "n"}, {obj: {kind: "fill", flags: ["ref_only"]}}); }, /nothing to suggest/);
    var ok = req({decision: "suggest", suggested_value: "1", note: "n", suggested_refs: "https://a.org/x  https://a.org/x, https://b.org"});
    assert.equal(ok.suggest_kind, "value");
    assert.deepEqual(plain(ok.suggested_refs), ["https://a.org/x", "https://b.org"]);
    assert.equal(req({decision: "accept"}).decision, "accept");
    assert.equal(req({undo: true, decision: "suggest"}).undo, true);
  });
});

test("the store records the kind and refs on a suggest, empty on anything else, and the overlay restores them", function () {
  var P = page();
  return P.booted.then(function () {
    var h = P.hooks();
    var s = h.lineRecord(0, {decision: "suggest", suggest_kind: "cosmetic", suggested_refs: ["https://a.org"]}, {}, {decision: "suggest"})[0];
    assert.equal(s.suggest_kind, "cosmetic");
    assert.deepEqual(plain(s.suggested_refs), ["https://a.org"]);
    var a = h.lineRecord(0, {decision: "accept"}, {}, {decision: "accept"})[0];
    assert.equal(a.suggest_kind, "");
    assert.deepEqual(plain(a.suggested_refs), []);
    var u = h.lineRecord(0, {undo: true}, {}, {decision: "suggest", undecided: true})[0];
    assert.equal(u.suggest_kind, "");
    var l1 = {key: "k1", reviewed: true, decision: "suggest"}, l2 = {key: "k2", reviewed: true, decision: "accept", suggest_kind: "value", suggested_refs: ["x"]};
    h.overlay({vessels: [{lines: [l1, l2]}]}, {k1: {suggest_kind: "cosmetic", suggested_refs: ["https://a.org"]}, k2: {}}, API);
    assert.equal(l1.suggest_kind, "cosmetic");
    assert.deepEqual(plain(l1.suggested_refs), ["https://a.org"]);
    assert.equal(l2.suggest_kind, "");
    assert.deepEqual(plain(l2.suggested_refs), []);
  });
});
