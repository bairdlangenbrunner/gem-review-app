// A proposed number that differs from the sheet only in formatting is the same value: the backend snapshot shows a cell the way its
// format says (1,443.00; 246,000.00) while a staged record says 1443 or 246000. The pair table reads such a row as "same", never
// "change" (pipelines EACOP P0541, 2026-11-07). A.sameVal is the one compare; the pipelines and LNG extensions use it too.
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var stub = require("./stub_page.js");

function page() {
  var store = {caps: {decide: true}, whoami: function () { return Promise.resolve("BL"); },
               load: function () { return Promise.resolve({built: "2026-11-07T21:00:00-05:00", dirs: ["a"], cards: []}); },
               decide: function () { return Promise.resolve([]); }, item: function () { return Promise.resolve([]); }};
  return stub.page({globals: {StaticStore: store}});
}

test("sameVal ignores thousands separators and trailing decimals, and only those", function () {
  return page().booted.then(function (P) {
    var A = P.app.api;
    assert.ok(A.sameVal("1,443.00", 1443));
    assert.ok(A.sameVal("246,000.00", "246000"));
    assert.ok(A.sameVal("5000000000.00", 5000000000));
    assert.ok(A.sameVal("2022", 2022) && A.sameVal("construction", "construction"));
    assert.ok(!A.sameVal("1,443.00", 1444) && !A.sameVal("", 0) && !A.sameVal("construction", "Construction"));
  }.bind(null, page()));
});

test("a value row whose proposal is the sheet's own number reads same, not change", function () {
  var P = page();
  return P.booted.then(function () {
    var A = P.app.api, l = {tier: "high"};
    var same = A.valueRow("LengthKnown", "1,443.00", 1443, false, l);
    assert.match(same, /<tr class="same">/);
    assert.ok(!/newv/.test(same), "no tinted proposed value: " + same);
    var change = A.valueRow("LengthKnown", "1,443.00", 1450, false, l);
    assert.ok(!/<tr class="same">/.test(change) && /newv/.test(change), "a different number is still a change");
  });
});

test("both extensions compare through A.sameVal, not raw strings", function () {
  ["pipelines", "lng"].forEach(function (t) {
    var src = fs.readFileSync(path.join(stub.ROOT, "trackers", t, "web", "ext.js"), "utf8");
    assert.doesNotMatch(src, /String\(was\)\.trim\(\) === String\(now\)\.trim\(\)/, t + " ext.js still compares the value row as raw strings");
    assert.match(src, /sameVal = A\.sameVal/, t + " ext.js does not take A.sameVal");
  });
});
