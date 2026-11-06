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
            line("V1", "Price", {links: ["a::V1:Price currency"]}), line("V1", "Price currency", {kind: "change", current: "EUR", proposed: "USD", links: ["a::V1:Price"]}),
            line("V1", "Capacity [ref]", {kind: "ref", flags: ["ref_only"]}),
            line("V1", "Status", {flags: ["ref_only"]})];
  return {
    built: "2026-10-29T09:00:00-04:00", backend_pulled: "2026-10-29T08:00:00-04:00", dirs: ["a"], header: ["Name", "Other names", "Price", "Shipowner"],
    batches: [{dir: "a", mode: "fix", label: "fix a", apply_order: 1, applied: false, counts: {}, n: 6}],
    vessels: [
      {pid: "V1", dir: "a", name: "Arctic Spirit", live_row: 12, new: false, in_backend: true, row_id: "V1", imo: "9876543", status: "active", shipbuilder: "Hanwha", shipowner: "Teekay", hull: "3301", delivery_year: "2027", lines: v1, items: []},
      {pid: "c:a:7", dir: "a", name: "Hull 5 (Jiangnan)", live_row: null, new: true, in_backend: false, cluster_id: "7", lines: [line("c:a:7", null, {kind: "new_row", id: "cluster:7", column: null, row_id: null, cluster_id: "7", refs: [{url: "https://example.org/n", verdict: "verified"}], row_data: {Status: "under construction", Name: "Hull 5 (Jiangnan)", "Name [ref]": "https://example.org/n", Price: "", "Price [ref]": "", Shipowner: "Teekay", "Shipowner [ref]": "https://example.org/o1, https://example.org/o2"}})], items: []},
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

test("a new row lists its filled columns in sheet order, then every ref in one sources table below them, with copy buttons and verdicts", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, hit = -1;
    A.cards().forEach(function (p, i) { if (p.pid === "c:a:7") hit = i; });
    A.S.pipe = hit; A.renderCard();
    var h = P.$("card").innerHTML;
    assert.match(h, /<table class="rowdata">/);
    // sheet order (Name before Price; Status, not in the sheet, goes last); a blank Price is left out; the refs follow every value, in the same order
    var order = ["<td>Name</td>", "<td>Shipowner</td>", "<td>Status</td>", ">sources<", "<td>Name [ref]</td>", "<td>Shipowner [ref]</td>"];
    var at = order.map(function (s) { return h.indexOf(s); });
    at.forEach(function (i, n) { assert.ok(i >= 0, order[n] + " present"); if (n) assert.ok(i > at[n - 1], order[n] + " after " + order[n - 1]); });
    assert.equal(h.indexOf("<td>Price</td>"), -1);
    assert.ok(h.indexOf('data-clip="Teekay"') > 0, "copy button on the value");
    assert.ok(h.indexOf('data-clip="https://example.org/o2"') > 0, "copy button on each link");
    assert.match(h, /href="https:\/\/example.org\/o1"/);
    assert.match(h, /verified/);
  });
});
test("a line from an applied batch is an accept, not undecided, and nothing is saved for it", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, l = lineAt(A, "V1", "Price");
    l.flags = ["applied"]; l.reviewed = false; l.decision = null;
    A.reload({vessels: A.cards(), dirs: ["a"], batches: [], built: "", backend_pulled: "", header: []});
    l = lineAt(A, "V1", "Price");
    assert.equal(A.cur(l), "accept");
    assert.equal(A.isOpen(l), false);
    assert.match(A.decisionText(l), /already applied/);
    assert.equal(l.decided_by, null, "no reviewer is invented for an applied line");
    assert.equal(A.noteBox(l), false);
    assert.equal(P.saved.length, 0);
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

test("a link's verdict gets the same marks as the other trackers: a cell gate pass is a check, a URL log entry is only page read", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, hit = -1;
    A.cards().forEach(function (p, i) { if (p.pid === "c:a:7") hit = i; });
    function show(v) {
      A.cards()[hit].lines[0].refs = [{url: "https://example.org/n", verdict: v}];
      A.S.pipe = hit; A.renderCard();
      return P.$("card").innerHTML;
    }
    assert.match(show("PASS (live row 6: value '126750': OK (shipvault_api))"), /class="chip ok"[^>]*>✓</);
    var h = show("PASS (URL log)");
    assert.match(h, />page read</);
    assert.doesNotMatch(h, /PASS \(URL log\)<\/span>/);
    assert.doesNotMatch(h, /class="chip ok"/);
    assert.match(show("FAIL (URL log)"), />✗ value</);
    assert.match(show("DROPPED — unreachable (dead: 404)"), />✗ load</);
    assert.match(show(""), />unchecked</);
  });
});

test("the how-to and keyboard text are the LNG page's own: the sheet, the push, the chips; no items key, the notes key says notes and record", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api;
    P.$("info-btn").onclick();
    var h = P.$("dialog").innerHTML;
    assert.match(h, /<h3>how this works<\/h3>/);
    assert.match(h, /push changes/);
    assert.match(h, /in the backend/);
    assert.match(h, /Name<\/b> and <b>Other names<\/b> are decided together/);
    assert.doesNotMatch(h, /actions workbook|Major \/ minor/);
    P.$("dialog").open = false;
    P.$("help-btn").onclick();
    h = P.$("dialog").innerHTML;
    assert.doesNotMatch(h, /<kbd>i<\/kbd>/);
    assert.match(h, /notes and record/);
    assert.match(h, /Cmd\/Ctrl\+Enter saves/);
    assert.ok(A, "api");
  });
});

test("the line kinds read as what the line does to the cell, and the kind filter lists them", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api;
    assert.equal(A.kindLabel({kind: "fill"}), "fill a blank");
    assert.equal(A.kindLabel({kind: "change"}), "change a value");
    assert.equal(A.kindLabel({kind: "delete"}), "clear a value");
    assert.equal(A.kindLabel({kind: "ref"}), "source link only");
    assert.equal(A.kindLabel({kind: "conflict"}), "conflict");
    var opts = P.$("f-kind").innerHTML;
    assert.match(opts, /value="fill"[^>]*>fill a blank \(/);
    assert.match(opts, /value="change"[^>]*>change a value \(/);
    assert.match(opts, /value="ref"[^>]*>source link only \(/);
    assert.doesNotMatch(opts, /value="delete"/, "a kind the dataset does not have is left out");
    var lng = P.ctx.ReviewApp.tracker || {};
    var can = A.lineActions ? function (l) { return A.lineActions(l).suggest; } : null;
    if (can) {
      assert.equal(can(line("V1", "Price", {kind: "change", current: "unknown"})), true);
      assert.equal(can(line("V1", "Price", {kind: "delete", proposed: ""})), true);
    }
    assert.ok(lng, "tracker");
  });
});

test("the queue badge counts what is left to decide, with the row, yard and owner; the card has no pre-filled chip and keeps the note once under notes & record", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, q = P.$("pipes").innerHTML;
    assert.match(q, /\d+ to decide/);
    assert.doesNotMatch(q, /major|minor/);
    assert.match(q, /row 12 · Hanwha · Teekay/);
    var hit = -1;
    A.cards().forEach(function (p, i) { if (p.pid === "V1"); if (p.pid === "V1") hit = i; });
    var l = A.cards()[hit].lines[2];
    l.why = "the yard release prints the price"; l.detail = ["the sister ship carries the same figure"]; l.confidence_why = "a live page states the value";
    A.S.pipe = hit; A.renderCard();
    var h = P.$("card").innerHTML;
    assert.doesNotMatch(h, /pre-filled|lng-why|How sure|Sources to open/);
    assert.match(h, /<summary>notes &amp; record<\/summary>/);
    assert.equal((h.match(/the yard release prints the price/g) || []).length, 1);
    assert.match(h, /the yard release prints the price\nthe sister ship carries the same figure/);
    assert.match(h, /<span class="k">grade<\/span>a live page states the value/);
    assert.match(h, /<span class="k">record<\/span>batch fix a · default accept · record V1\|Price/);
    assert.match(h, /class="pid"[^>]*>12</, "the card id is the sheet row");
  });
});

test("a settled line that repeats an earlier one on the card (same cell, same value, another batch) is hidden", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, cards = A.cards(), v1 = cards[0];
    var a = v1.lines.filter(function (l) { return l.column === "Price"; })[0];
    var b = line("V1", "Price", {key: "b::V1:Price", dir: "b", id: "V1|Price"});
    a.reviewed = b.reviewed = true; a.decision = b.decision = "accept"; a.decided_by = b.decided_by = "BL";
    v1.lines.push(b);
    A.reload({vessels: cards, dirs: ["a", "b"], batches: [{dir: "a", label: "fix a"}, {dir: "b", label: "fix b"}], built: "", backend_pulled: "", header: []});
    A.S.pipe = 0; A.renderCard();
    var h = P.$("card").innerHTML;
    assert.equal((h.match(/class="line [^"]*lng-dup/g) || []).length, 1);
    var open = line("V1", "Price", {key: "c::V1:Price", dir: "c"});
    A.cards()[0].lines.push(open);
    A.reload({vessels: A.cards(), dirs: ["a", "b", "c"], batches: [], built: "", backend_pulled: "", header: []});
    A.S.pipe = 0; A.renderCard();
    assert.equal((P.$("card").innerHTML.match(/lng-dup/g) || []).length, 1, "an open line is never hidden");
  });
});

test("a machine's record is the status line, not a note box", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, l = lineAt(A, "V1", "Price");
    l.reviewed = true; l.decision = "accept"; l.decided_by = "backend sync"; l.decided_at = "2026-10-29T10:00:00-04:00"; l.decision_note = "the sheet holds the value";
    assert.equal(A.noteBox(l), false);
    assert.match(A.decisionText(l), /^accepted by backend sync .*the sheet holds the value$/);
    l.decided_by = "BL"; l.decision_note = "";
    assert.equal(A.noteBox(l), true);
    assert.match(A.decisionText(l), /^accepted by BL/);
  });
});
