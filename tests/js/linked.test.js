// The core's linked pairs, "undo last", bulk over the filtered set, click to filter and the tracker suggest form.
// app.js is loaded whole in the stub page (stub_page.js); the store keeps what it is asked to save and hands the records back the way a store does.
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var stub = require("./stub_page.js");
var plain = stub.plain;

// Name and Other names are a strict pair, Price and Price currency a loose one (LNG's rules, written small)
var TRACKER = [
  "window.ReviewApp.define(function (A) { return {",
  "  bulkFiltered: true,",
  "  snapshot: function (l) { return l.suggest_kind ? {suggest_kind: l.suggest_kind} : null; },",
  "  partners: function (l) {",
  "    var pair = {Name: ['Other names', true], 'Other names': ['Name', true], Price: ['Price currency', false], 'Price currency': ['Price', false]}[l.column];",
  "    if (!pair) return [];",
  "    var p = A.cards()[l._p].lines.filter(function (x) { return x.column === pair[0]; })[0];",
  "    return p ? [{line: p, strict: pair[1]}] : [];",
  "  },",
  "  suggestForm: function (l, prior) {",
  "    return {html: '<textarea class=\"x-v\"></textarea>', read: function (f, l) { var v = f._v; return v ? {suggested_value: v, suggest_kind: 'value', note: 'n'} : 'give a value'; }};",
  "  }",
  "}; });"
].join("\n");

function line(pid, column, extra) {
  var l = {key: "a::" + pid + ":" + column, pid: pid, dir: "a", kind: "change", column: column, severity: "major", tier: "high",
           decision: null, reviewed: false, decided_by: null, decided_at: null};
  Object.keys(extra || {}).forEach(function (k) { l[k] = extra[k]; });
  return l;
}
function dataset() {
  return {
    built: "2026-10-29T09:00:00-04:00", dirs: ["a"],
    cards: [
      {pid: "V1", name: "Arctic Spirit", dir: "a", lines: [line("V1", "Name"), line("V1", "Other names"), line("V1", "Price"), line("V1", "Price currency")], items: []},
      {pid: "V2", name: "Hull 3301 (Hanwha)", dir: "a", lines: [line("V2", "Name"), line("V2", "Other names"), line("V2", "Price")], items: []}
    ]
  };
}
var TS = 0;
function page() {
  var saved = [];
  var store = {
    caps: {decide: true},
    whoami: function () { return Promise.resolve("BL"); },
    load: function () { return Promise.resolve(dataset()); },
    decide: function (records) {
      saved.push(plain(records));
      return Promise.resolve(records.map(function (r) {
        var out = {key: r.key, decision: r.decision || "hold", undecided: !!r.undo, reviewer: "BL", ts: "2026-10-29T10:00:" + String(TS++ % 60).padStart(2, "0") + "-04:00",
                   suggested_value: r.suggested_value || "", reference: r.reference || "", note: r.note || ""};
        if (r.via) out.via = r.via;
        return out;
      }));
    },
    item: function () { return Promise.resolve([]); }
  };
  var P = stub.page({globals: {StaticStore: store}, after: [[TRACKER, "tracker.js"]]});
  P.saved = saved;
  return P;
}
function tick() { return new Promise(function (ok) { setTimeout(ok, 5); }); }
function lineAt(A, pid, column) { return A.LINE_BY_KEY["a::" + pid + ":" + column]; }

test("a call on one of a strict pair asks once and saves both, the partner marked linked", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, name = lineAt(A, "V1", "Name");
    A.save(name, {key: name.key, decision: "accept"});
    assert.ok(P.$("dialog").open, "the pair question opens");
    assert.match(P.$("dialog").innerHTML, /decided together/);
    assert.doesNotMatch(P.$("dialog").innerHTML, /dlg-one/, "a strict pair has no 'only this one'");
    assert.equal(P.saved.length, 0, "nothing saved before the answer");
    P.$("dlg-both").onclick();
    return tick().then(function () {
      assert.deepEqual(P.saved[0].map(function (r) { return [r.key, r.decision, r.via || ""]; }),
                       [["a::V1:Name", "accept", ""], ["a::V1:Other names", "accept", "linked"]]);
      assert.equal(A.cur(lineAt(A, "V1", "Other names")), "accept");
    });
  });
});

test("a loose pair offers only this one, and don't ask again holds for the session", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, price = lineAt(A, "V1", "Price");
    A.save(price, {key: price.key, decision: "reject"});
    assert.match(P.$("dialog").innerHTML, /dlg-one/);
    P.$("dlg-skip").checked = true;
    P.$("dlg-one").onclick();
    return tick().then(function () {
      assert.deepEqual(P.saved[0].map(function (r) { return r.key; }), ["a::V1:Price"]);
      P.$("dialog").open = false;
      var cur = lineAt(A, "V1", "Price currency");
      A.save(cur, {key: cur.key, decision: "accept"});
      assert.equal(P.$("dialog").open, false, "no question after don't ask again");
      return tick();
    }).then(function () {
      assert.deepEqual(P.saved[1].map(function (r) { return r.key; }), ["a::V1:Price currency"]);
    });
  });
});

test("undo last puts the lines back as they were, one save per press", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, price = lineAt(A, "V2", "Price");
    A.save(price, {key: price.key, decision: "hold"});
    return tick().then(function () {
      A.save(price, {key: price.key, decision: "reject"});
      return tick();
    }).then(function () {
      assert.equal(A.S.history.length, 2);
      A.undoLast();
      return tick();
    }).then(function () {
      assert.deepEqual(P.saved[2], [{key: price.key, decision: "hold", note: "", reference: "", via: "undo"}]);
      assert.equal(A.cur(price), "hold");
      A.undoLast();
      return tick();
    }).then(function () {
      assert.deepEqual(P.saved[3], [{key: price.key, undo: true, via: "undo"}]);
      assert.equal(A.cur(price), null);
      assert.equal(A.S.history.length, 0);
    });
  });
});

test("undo last after a pair takes back both lines", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, name = lineAt(A, "V2", "Name");
    A.save(name, {key: name.key, decision: "accept"});
    P.$("dlg-both").onclick();
    return tick().then(function () {
      A.undoLast();
      return tick();
    }).then(function () {
      assert.deepEqual(P.saved[1].map(function (r) { return [r.key, !!r.undo, r.via]; }),
                       [["a::V2:Name", true, "undo"], ["a::V2:Other names", true, "undo"]]);
    });
  });
});

test("bulk over the filtered set: every card in view, strict partners always, loose partners on request", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api;
    A.FS = Object.assign(A.defaults(), {column: "Name"});
    A.refilter(true);
    A.showBulkFiltered("accept");
    var html = P.$("dialog").innerHTML;
    assert.match(html, /<b>2 changes<\/b>|<b>2 [a-z]+s<\/b>/);
    assert.match(html, /decided together/);
    P.$("dlg-ok").onclick();
    return tick().then(function () {
      var got = P.saved[0].map(function (r) { return [r.key, r.decision, r.via]; });
      assert.deepEqual(got.map(function (g) { return g[0]; }).sort(),
                       ["a::V1:Name", "a::V1:Other names", "a::V2:Name", "a::V2:Other names"]);
      got.forEach(function (g) { assert.match(g[2], /^bulk:col=Name/); });
      assert.equal(A.S.history.length, 1);
    });
  });
});

test("bulk names loose partners and leaves them out unless asked", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api;
    A.FS = Object.assign(A.defaults(), {column: "Price"});
    A.refilter(true);
    A.showBulkFiltered("reject");
    assert.match(P.$("dialog").innerHTML, /include the partners/);
    P.$("dlg-ok").onclick();
    return tick().then(function () {
      assert.deepEqual(P.saved[0].map(function (r) { return r.key; }).sort(), ["a::V1:Price", "a::V2:Price"]);
    });
  });
});

test("click to filter puts the value in the search box, or in the named filter", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api;
    assert.match(A.only("Hanwha Ocean", null, null), /data-only="Hanwha Ocean"/);
    A.filterOnly("Hanwha Ocean");
    assert.equal(A.FS.q, "hanwha ocean");
    A.filterOnly("a", "dir");
    assert.equal(A.FS.dir, "a");
    assert.equal(A.FS.q, "");
    A.filterOnly("x", "no-such-filter");
    assert.equal(A.FS.q, "x");
  });
});

test("a tracker suggest form: its read says what is wrong, or gives the fields to save", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, price = lineAt(A, "V1", "Price"), form = null;
    var doc = P.ctx.document, make = doc.createElement;
    doc.createElement = function (tag) {
      var e = make(tag), parts = {};
      e.querySelector = function (sel) { return parts[sel] || (parts[sel] = stub.element(sel)); };
      if (tag === "form") form = e;
      return e;
    };
    P.$("line-" + price._i).querySelector = function () { return stub.element("controls"); };
    A.openSuggest(price);
    assert.ok(form, "the form is built");
    assert.match(form.innerHTML, /x-v/);
    form.onsubmit({preventDefault: function () {}});
    assert.equal(form.querySelector(".sv-err").textContent, "give a value");
    assert.equal(P.saved.length, 0);
    form._v = "180000000";
    form.onsubmit({preventDefault: function () {}});
    return tick().then(function () {
      assert.deepEqual(P.saved[0], [{key: price.key, decision: "suggest", suggested_value: "180000000", suggest_kind: "value", note: "n"}]);
      assert.equal(A.S.history.length, 1);
    });
  });
});
