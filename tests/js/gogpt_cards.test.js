// The GOGPT page's three card kinds: a tracked plant's edits, its proposed additions (new unit rows and leads) and its watch list are separate cards of one queue, listed under section headers, and the addition and watch cards draw flat (no tabs), name the plant id, and link to the plant's other cards.
// app.js and trackers/gogpt/web/ext.js are loaded whole in a fresh VM context with a small stub of the page (stub_page.js), the way the page boots them.
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var stub = require("./stub_page.js");

var GEO_JS = fs.readFileSync(path.join(stub.ROOT, "review_core", "web", "geo.js"), "utf8");
var GOGPT_EXT = fs.readFileSync(path.join(stub.ROOT, "trackers", "gogpt", "web", "ext.js"), "utf8");
var plain = stub.plain;

function page(data) {
  var store = {
    caps: {decide: true, item: true},
    whoami: function () { return Promise.resolve("BL"); },
    load: function () { return Promise.resolve(data); },
    decide: function () { return Promise.resolve([]); },
    item: function () { return Promise.resolve([]); },
    flag: function () { return Promise.resolve([]); }
  };
  // geo.js is loaded ahead of ext.js the way the page loads it (ext.js reads the shared basemaps at define time)
  return stub.page({globals: {StaticStore: store}, before: [[GEO_JS, "geo.js"]], after: [[GOGPT_EXT, "ext.js"]]});
}

var PR = "https://www.example.com/press/2026-05-18-brandywine";
function ver(ok) { var v = {}; v[PR] = {ok: ok, contains_value: ok, name_found: ok, note: ok ? "" : "timed out"}; return v; }
function line(pid, rid, extra) {
  var l = {key: "a::" + rid, record_id: rid, pid: pid, dir: "a", kind: "fill", column: "Start year", severity: "major", tier: "high",
           gem_unit_id: "G1", unit_name: "F701", current: "", proposed: "1996", current_ref: [], proposed_refs: [PR], verifications: ver(true),
           group: 2, group_label: "cells", checks: [12], decision: null, reviewed: false, decided_by: null, decided_at: null,
           researcher_notes: "", action: "", irp: false};
  Object.keys(extra || {}).forEach(function (k) { l[k] = extra[k]; });
  return l;
}
function item(pid, rid, extra) {
  var it = {key: "a::" + rid, record_id: rid, pid: pid, dir: "a", kind: "monitor", monitor_kind: "existing_plant", lead_for: "",
            item: "", monitor_reason: "", links: [PR], researcher_notes: "", group: 8, group_label: "new plants and units",
            checks: [51], call: null, call_note: "", decided_by: null, decided_at: null, pm: false, irp: false};
  Object.keys(extra || {}).forEach(function (k) { it[k] = extra[k]; });
  return it;
}
// Brandywine (L1): one edit on its plant card, a new unit row and a new-unit lead on its addition card, a battery project on its watch card;
// plus one untracked candidate plant with a new row that is ready to add.
function dataset() {
  var name = "Brandywine power facility", units = [{gem_unit_id: "G1", unit_name: "F701", status: "operating", irp_box: "no"}];
  return {
    built: "2026-10-23T09:00:00-04:00", dirs: ["a"], us: true,
    scope: {country: "United States", states: ["Maryland"], quarter: "q4-2026"},
    groups: [{id: 2, label: "cells", rows: [{row: 12, label: "start year"}]}, {id: 8, label: "new plants and units", rows: [{row: 51, label: "leads"}]}],
    plants: [
      {pid: "L1", plant_pid: "L1", card_kind: "plant", name: name, dir: "a", country: "United States", state: "Maryland", units: units,
       lines: [line("L1", "L1:G1:start-year")], items: []},
      {pid: "L1#add", plant_pid: "L1", card_kind: "addition", name: name, dir: "a", country: "United States", state: "Maryland", units: units,
       lines: [line("L1#add", "L1:new:unit-3", {kind: "new_row", column: "", unit_name: "Unit 3", gem_unit_id: "", proposed: "proposed, 300 MW",
                                                 fields: {Status: "proposed", "Capacity (MW)": "300"}, refs: {"Status Data Source": [PR]},
                                                 verifications: ver(false), ready: false, units: [], lane: "newunits", plant_name: name})],
       items: [item("L1#add", "L1:plant:monitor-3", {lead_for: "newunits", monitor_reason: "New unit lead: a fourth unit is under study."})]},
      {pid: "new:severn-barge-station", plant_pid: "", card_kind: "addition", name: "Severn barge station", dir: "a", country: "United States", state: "Maryland", units: [],
       lines: [line("new:severn-barge-station", "us-md-eia999:plant:newplant", {kind: "new_row", column: "", unit_name: "", gem_unit_id: "", proposed: "new plant",
                                                                                 fields: {"Owner(s)": "Acme Power LLC [100%]"}, refs: {"Owners Data Source": [PR]},
                                                                                 verifications: ver(true), ready: true, units: [], lane: "newplants", plant_name: "Severn barge station"})],
       items: []},
      {pid: "L1#watch", plant_pid: "L1", card_kind: "watch", name: name, dir: "a", country: "United States", state: "Maryland", units: units,
       lines: [], items: [item("L1#watch", "L1:plant:monitor-2", {monitor_reason: "A battery project shares the site."})]}
    ]
  };
}
function find(A, pid) { var hit = -1; A.cards().forEach(function (p, i) { if (p.pid === pid) hit = i; }); return hit; }
function showCard(P, pid) {
  var A = P.app.api;
  A.S.pipe = find(A, pid);
  A.renderCard();
  return P.$("card").innerHTML;
}

test("the queue lists the three sections in order, with their card counts; a plant GEM does not track sits on the new tab", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api;
    assert.deepEqual(plain(A.cards().map(function (p) { return p.pid; })), ["L1", "L1#add", "new:severn-barge-station", "L1#watch"]);
    A.S.hideDone = false;
    A.FS.status = []; A.refilter(true);          // every status on: Brandywine is operating, so the default filter would hide it
    A.renderQueue();
    var html = P.$("pipes").innerHTML;
    var secs = [], re = /<li class="qsec">.*?>([a-z ]+)<\/span> <span class="n">(\d+)<\/span><\/li>/g, m;
    while ((m = re.exec(html))) secs.push(m[1] + " " + m[2]);
    assert.deepEqual(secs, ["plants 1", "proposed additions 1", "watch list 1"]);
    assert.doesNotMatch(html, /Severn barge station/);
    assert.match(P.$("qtabs").innerHTML, /data-qtab="new" aria-selected="false"[^>]*>new <span class="n">1<\/span>/);
    A.selectPipe(find(A, "new:severn-barge-station"));    // opening it switches the tab
    assert.match(P.$("qtabs").innerHTML, /data-qtab="new" aria-selected="true"/);
    assert.match(P.$("pipes").innerHTML, /Severn barge station[\s\S]*?new plant/);
    A.selectPipe(find(A, "L1#add"));
    html = P.$("pipes").innerHTML;
    // the queue rows say what each card is, and the addition and watch rows name the plant id, not the card id
    assert.match(html, /1 new unit, 1 lead/);
    assert.match(html, /watch/);
    assert.doesNotMatch(html, /L1#add|L1#watch/);
  });
});

test("an addition card draws flat: the unit row with its readiness chip, then the lead, and links back to the plant's other cards", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api, html = showCard(P, "L1#add");
    assert.match(html, /<span class="pid"[^>]*>L1<\/span>/);           // the plant id, not L1#add
    assert.match(html, /class="flatcard"/);
    assert.doesNotMatch(html, /data-tab="lines"/);                       // no tabs on a flat card
    assert.match(html, /new units proposed at this plant/);
    assert.match(html, /no source verified/);                            // the unit row's one source did not load
    // the new unit row: its title and the plant it goes under, and none of the chips that read the same on every new row
    assert.match(html, /<span class="col">New unit: Unit 3<\/span>/);
    assert.match(html, /<span class="where">under Brandywine power facility<\/span>/);
    var row = /<div class="line [^"]*" id="line-1"[\s\S]*?<div class="controls">/.exec(html)[0];
    assert.doesNotMatch(row, /chip grp|unrated|chip major|new unit on a tracked plant/);
    assert.match(html, /chip lead/);                                     // the lead item
    assert.match(html, /value="research_further"/);                      // the lead's extra call
    var xc = /<span class="xcards">([\s\S]*?)<\/span>/.exec(html);
    assert.ok(xc, "no links to the plant's other cards");
    assert.match(xc[1], new RegExp('data-card="' + find(A, "L1") + '"[^>]*>plant edits'));
    assert.match(xc[1], new RegExp('data-card="' + find(A, "L1#watch") + '"[^>]*>watch list'));
    // the untracked candidate's row: its one source verified, titled as a new plant with no where
    var cand = showCard(P, "new:severn-barge-station");
    assert.match(cand, /<span class="col">New plant: Severn barge station<\/span>/);
    assert.match(cand, /chip ready[^>]*>1 of 1 source verified</);
    assert.match(cand, /<span class="where"><\/span>/);
  });
});

test("no card has bulk buttons, a watch card has no readiness chips and no research-further call; the plant card keeps its tabs", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api, html = showCard(P, "L1#watch");
    assert.match(html, /watch list: nothing here changes a cell/);
    assert.doesNotMatch(html, /data-bulk=/);
    assert.doesNotMatch(html, /value="research_further"|chip lead|source verified|sources verified/);
    assert.match(html, /value="remove"/);
    assert.match(html, /<span class="pid"[^>]*>L1<\/span>/);
    var plant = showCard(P, "L1");
    assert.doesNotMatch(plant, /class="flatcard"/);
    assert.doesNotMatch(plant, /data-bulk=/);
    var xc = /<span class="xcards">([\s\S]*?)<\/span>/.exec(plant);
    assert.ok(xc && /proposed unit/.test(xc[1]) && /watch list/.test(xc[1]), "the plant card links to its addition and watch cards");
    // clicking a sibling link on the card selects that card (the card's click listener, as the page wires it)
    var target = find(A, "L1#add");
    A.S.pipe = find(A, "L1");
    var ev = {target: {closest: function (sel) { return sel === "a[data-card]" ? {getAttribute: function () { return String(target); }} : null; }}, preventDefault: function () {}};
    (P.$("card")._listeners.click || []).forEach(function (fn) { fn(ev); });
    assert.equal(A.S.pipe, target);
  });
});

test("the status filter goes on the current unit statuses, never a proposed one; in development and the other statuses are groups in the status menu, the others off by default", function () {
  var d = dataset();
  d.plants[0].units = [{gem_unit_id: "G1", unit_name: "F701", status: "pre-construction"}, {gem_unit_id: "G2", unit_name: "F702", status: "operating"}];
  d.plants[1].units = []; d.plants[3].units = [{gem_unit_id: "G1", unit_name: "F701", status: "retired"}];
  var P = page(d);
  return P.booted.then(function () {
    var A = P.app.api, fs = A.FS, box = P.$("f-status");
    assert.equal(box.hidden, false);
    var html = box.innerHTML;
    var at = function (t) { return html.indexOf(t); };
    assert.ok(at("data-group=\"dev\"") < at('value="pre-construction"') && at('value="pre-construction"') < at("data-group=\"rest\""));
    assert.ok(at("data-group=\"rest\"") < at('value="operating"') && at('value="operating"') < at('value="retired"'));
    assert.doesNotMatch(html.slice(at("data-group=\"rest\"")), /checked/);   // off by default
    assert.doesNotMatch(html, /proposed/);                              // the proposed new-row Status is not a choice
    fs.status = ["pre-construction"]; A.refilter(true);                 // the addition card has no units of its own, so it follows the plant card's statuses
    assert.deepEqual(plain(A.S.visible.map(function (i) { return A.cards()[i].pid; })), ["L1", "L1#add"]);
    fs.status = ["Pre construction", "retired"]; A.refilter(true);       // spelling does not matter
    assert.deepEqual(plain(A.S.visible.map(function (i) { return A.cards()[i].pid; })), ["L1", "L1#add", "L1#watch"]);
  });
});

test("an inferred status's age is dropped so shelved - inferred 2 y and 4 y are one choice in development", function () {
  var d = dataset();
  d.plants[0].units = [{gem_unit_id: "G1", unit_name: "F701", status: "shelved - inferred 2 y"}, {gem_unit_id: "G2", unit_name: "F702", status: "shelved - inferred 4 y"}];
  var P = page(d);
  return P.booted.then(function () {
    var html = P.$("f-status").innerHTML;
    assert.equal((html.match(/value="shelved - inferred"/g) || []).length, 1);
    assert.ok(html.indexOf('data-group="dev"') < html.indexOf('value="shelved - inferred"') && html.indexOf('value="shelved - inferred"') < (html.indexOf('data-group="rest"') < 0 ? 1e9 : html.indexOf('data-group="rest"')));
  });
});

test("every in-development status is listed under its group; one no plant has is grayed out and cannot be ticked", function () {
  var d = dataset();
  d.plants[0].units = [{gem_unit_id: "G1", unit_name: "F701", status: "pre-construction"}, {gem_unit_id: "G2", unit_name: "F702", status: "operating"}];
  var P = page(d);
  return P.booted.then(function () {
    var html = P.$("f-status").innerHTML;
    ["announced", "pre-construction", "construction", "shelved", "shelved - inferred"].forEach(function (s) { assert.ok(html.indexOf('value="' + s + '"') >= 0, s); });
    assert.match(html, /value="announced" disabled/);
    assert.doesNotMatch(html, /value="pre-construction" disabled/);
    assert.match(html, /schild none/);
  });
});

test("new to database sits below the other statuses and picks the plants GEM does not track yet", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api, html = P.$("f-status").innerHTML;
    assert.ok(html.indexOf('value="new to database"') > html.indexOf('value="shelved - inferred"'));
    assert.doesNotMatch(html, /value="new to database" disabled/);
    A.FS.status = ["new to database"]; A.refilter(true);
    assert.deepEqual(plain(A.S.visible.map(function (i) { return A.cards()[i].pid; })), ["new:severn-barge-station"]);
    A.FS.status = ["operating"]; A.refilter(true);
    assert.ok(A.S.visible.every(function (i) { return A.cards()[i].pid.indexOf("new:") !== 0; }));
  });
});

test("the plant card header gives unit count, current status and capacity, and has no ask-the-PM box", function () {
  var d = dataset();
  d.plants[0].units = [{gem_unit_id: "G1", unit_name: "F701", status: "operating", capacity: "1,200.5"}, {gem_unit_id: "G2", unit_name: "F702", status: "retired", capacity: "100"}, {gem_unit_id: "G3", unit_name: "F703", status: "operating", capacity: ""}];
  var P = page(d);
  return P.booted.then(function () {
    var ctx = /<div class="ctx">([\s\S]*?)<\/div>/.exec(showCard(P, "L1"));
    assert.ok(ctx);
    var text = plain(ctx[1]);
    assert.match(ctx[1], /3 units/);
    assert.doesNotMatch(ctx[1], /in the export/);
    assert.match(ctx[1], /status: operating 2, retired 1/);
    assert.match(ctx[1], /1,300\.5 MW/);
    assert.doesNotMatch(ctx[1], /pmplant|data-pmplant/);
  });
});

test("the page opens on the plants in development plus the new ones: an operating plant and its other cards wait behind the other statuses", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api;
    function shown() { return plain(A.S.visible.map(function (i) { return A.cards()[i].pid; })); }
    assert.deepEqual(plain(A.FS.status), ["announced", "pre-construction", "construction", "shelved", "shelved - inferred", "new to database"]);
    assert.deepEqual(shown(), ["new:severn-barge-station"]);
    assert.doesNotMatch(P.$("active-filters").innerHTML, /status/);            // the default draws no chip
    assert.equal(P.$("f-active").hidden, true);                                // and no active filters button
    assert.equal(A.routeHash(), "#/new%3Asevern-barge-station");                // and nothing in the address
    // ticking operating on under other statuses in the status menu brings the plant card and, with it, its addition and watch cards (they follow the plant's status)
    A.FS.status = A.defaults().status.concat(["operating"]); A.refilter(true); A.renderActive();
    assert.deepEqual(shown(), ["L1", "L1#add", "new:severn-barge-station", "L1#watch"]);
    assert.match(P.$("active-filters").innerHTML, /status: in development, operating, new to database/);
    assert.equal(P.$("active-filters").hidden, true);                          // the chips stay folded until the button is clicked
    assert.equal(P.$("f-active").hidden, false);
    assert.match(P.$("f-active").textContent, /active filters \(1\)/);
    assert.doesNotMatch(P.$("f-more").textContent, /\(/);                     // the status chip sits in the bar, not behind more filters
    // every status: written as "all" in the address, and read back
    A.FS.status = []; A.refilter(true); A.renderActive();
    assert.match(P.$("active-filters").innerHTML, /status: all/);
    assert.match(A.routeHash(), /sts=all/);
    // narrowing the status shows a chip in the bar but does not count toward more filters
    A.FS.status = ["construction"]; A.refilter(true); A.renderActive();
    assert.match(P.$("active-filters").innerHTML, /status: construction/);
    assert.doesNotMatch(P.$("f-more").textContent, /\(/);
    assert.deepEqual(shown(), []);
  });
});

function checkedLine(pid) {
  return line(pid, "checked:" + pid, {kind: "checked", column: "", severity: "check", tier: "", gem_unit_id: "", unit_name: "", current: {}, proposed: "",
                                       current_ref: [], proposed_refs: [], verifications: {}, group: 3, group_label: "status and timeline", checks: [10, 53], default: "hold"});
}
function withNoChangePlant(d) {
  d.plants.splice(1, 0, {pid: "L9", plant_pid: "L9", card_kind: "plant", no_changes: true, name: "Zed peaker", dir: "a", country: "United States", state: "Maryland",
                         units: [{gem_unit_id: "G3", unit_name: "1", status: "announced", capacity: "100", last_updated: "2025-03-03", researcher: "DO", research_status: "no changes"}],
                         lines: [checkedLine("L9")], items: []});
  return d;
}

test("a plant with no suggested changes: one flat card with a checked / hold for later line, the unit bookkeeping, and a to-check badge", function () {
  var P = page(withNoChangePlant(dataset()));
  return P.booted.then(function () {
    var A = P.app.api;
    assert.deepEqual(plain(A.S.visible.map(function (i) { return A.cards()[i].pid; })), ["L9", "new:severn-barge-station"]);   // announced: in the default view
    var html = showCard(P, "L9");
    assert.match(html, /class="flatcard"/);
    assert.doesNotMatch(html, /data-bulk=|data-tab="major"/);
    assert.match(html, /No suggested changes/);
    assert.match(html, /chip oo[^>]*>no suggested changes/);
    assert.doesNotMatch(html, /chip (high|major|minor|check)\b/);                 // no confidence or severity chip
    assert.match(html, /data-decide="accept"[^>]*>checked</);
    assert.match(html, /data-decide="hold"[^>]*>hold for later</);
    assert.doesNotMatch(html, /data-decide="reject"|data-suggest/);
    assert.match(html, /set Last Updated and Research status in the database/);
    assert.match(html, /<td>2025-03-03<\/td><td>DO<\/td><td>no changes<\/td>/);
    var ctx = /<div class="ctx">([\s\S]*?)<\/div>/.exec(html)[1];
    assert.doesNotMatch(ctx, /last updated/);
    assert.match(ctx, /<b>no suggested changes<\/b>/);
    assert.doesNotMatch(ctx, /unrated/);                                          // no confidence summary on this card
    A.S.hideDone = false; A.renderQueue();
    // the queue lists one tab at a time: a plant with nothing proposed sits on "to check", not "suggestions"
    assert.doesNotMatch(P.$("pipes").innerHTML, /Zed peaker/);
    assert.match(P.$("qtabs").innerHTML, /data-qtab="suggestions" aria-selected="true"[^>]*>suggestions <span class="n">0<\/span>/);
    assert.match(P.$("qtabs").innerHTML, />new <span class="n">1<\/span>/);
    assert.match(P.$("qtabs").innerHTML, />to check <span class="n">1<\/span>/);
    A.selectPipe(A.cards().findIndex(function (p) { return p.pid === "L9"; }));   // opening it switches the tab
    assert.match(P.$("qtabs").innerHTML, /data-qtab="check" aria-selected="true"/);
    assert.doesNotMatch(P.$("pipes").innerHTML, /Severn barge station/);
    assert.match(P.$("pipes").innerHTML, /Zed peaker[\s\S]*?<span class="n todo">to check<\/span>/);
    // a line like this refuses a call it does not offer, and takes the ones it does
    var l = A.LINES.filter(function (x) { return x.kind === "checked"; })[0];
    assert.deepEqual(plain(A.lineActions(l).buttons.map(function (b) { return b[0]; })), ["accept", "hold"]);
    assert.equal(A.lineActions(l).suggest, false);
    l.reviewed = true; l.decision = "accept"; l.decided_by = "BL"; l.decided_at = "2026-10-23T10:00:00-04:00";
    A.renderQueue();
    assert.match(P.$("pipes").innerHTML, /Zed peaker[\s\S]*?<span class="n">checked<\/span>/);
    assert.match(showCard(P, "L9"), /checked by BL/);
    l.decision = "hold"; A.renderQueue();
    assert.match(P.$("pipes").innerHTML, /held for later/);
    assert.match(showCard(P, "L9"), /held for later by BL/);
  });
});

test("the unit table of a no-change plant groups the rows by status, in development first, and grays out the rest", function () {
  var d = withNoChangePlant(dataset());
  d.plants[1].units = [{gem_unit_id: "G1", unit_name: "1", status: "retired", capacity: "50", last_updated: "2020-01-01", researcher: "", research_status: ""},
                       {gem_unit_id: "G2", unit_name: "2", status: "operating", capacity: "60", last_updated: "2024-01-01", researcher: "DO", research_status: "no changes"},
                       {gem_unit_id: "G3", unit_name: "3", status: "shelved - inferred 2 y", capacity: "70", last_updated: "", researcher: "", research_status: ""},
                       {gem_unit_id: "G4", unit_name: "4", status: "mothballed", capacity: "80", last_updated: "", researcher: "", research_status: ""},
                       {gem_unit_id: "G5", unit_name: "5", status: "announced", capacity: "90", last_updated: "", researcher: "", research_status: ""},
                       {gem_unit_id: "G6", unit_name: "6", status: "operating", capacity: "61", last_updated: "", researcher: "", research_status: ""}];
  var P = page(d);
  return P.booted.then(function () {
    var html = showCard(P, "L9");
    var rows = html.match(/<tr( class="other")?><td>[^<]*<\/td><td>([^<]*)<\/td>/g).map(function (r) { return (/class="other"/.test(r) ? "*" : "") + /<td>([^<]*)<\/td>$/.exec(r)[1]; });
    assert.deepEqual(rows, ["announced", "shelved - inferred 2 y", "*mothballed", "*operating", "*operating", "*retired"]);   // in development first, then the rest alphabetically, export order within a status
    assert.match(html, /<tr class="other"><td>unit 2 \(G2\)<\/td><td>operating<\/td>[\s\S]*?<tr class="other"><td>unit 6 \(G6\)<\/td><td>operating<\/td>/);
    assert.match(html, /units-say[^>]*>The grayed rows are not in development/);
    d.plants[1].units = d.plants[1].units.slice(0, 2); P.app.api.reload(d);
    assert.match(showCard(P, "L9"), /No unit here is in development/);
    d.plants[1].units = d.plants[1].units.slice(0, 0).concat([{gem_unit_id: "G5", unit_name: "5", status: "announced", capacity: "90"}]); P.app.api.reload(d);
    assert.doesNotMatch(showCard(P, "L9"), /units-say|class="other"/);
  });
});

test("the close-out panel lists the no-change plants by whether they were checked, and the draft counts them", function () {
  var d = withNoChangePlant(dataset());
  d.plants.splice(2, 0, {pid: "L8", plant_pid: "L8", card_kind: "plant", no_changes: true, name: "Old mill", dir: "a", country: "United States", state: "Maryland",
                         units: [{gem_unit_id: "G4", unit_name: "1", status: "operating", capacity: "50", last_updated: "", researcher: "", research_status: ""}],
                         lines: [checkedLine("L8")], items: []});
  var P = page(d);
  return P.booted.then(function () {
    var A = P.app.api;
    var l9 = A.LINES.filter(function (x) { return x.record_id === "checked:L9"; })[0];
    l9.reviewed = true; l9.decision = "accept"; l9.decided_by = "BL"; l9.decided_at = "2026-10-23T10:00:00-04:00";
    A.S.panel = "closeout"; A.S.pipe = -1;
    A.renderCard();
    var html = P.$("card").innerHTML;
    assert.match(html, /no suggested changes, marked checked <span class="n">\(1\)<\/span>[\s\S]*?Zed peaker/);
    assert.match(html, /no suggested changes, not checked yet <span class="n">\(1\)<\/span>[\s\S]*?Old mill/);
    assert.match(html, /3 tracked plants on the page, 1 checked; 2 had no suggested change, 1 of them marked checked\./);
  });
});

test("a minor change nobody has decided loads as held and grayed out; a decided one keeps its call", function () {
  var data = dataset();
  data.plants[0].lines.push(line("L1", "L1:G1:start-year-ref", {severity: "minor", kind: "reverified"}),
                            line("L1", "L1:G1:status-detail", {severity: "minor", column: "Status detail", decision: "accept", reviewed: true, decided_by: "BL", decided_at: "2026-10-25T10:00:00"}));
  var P = page(data);
  return P.booted.then(function () {
    var A = P.app.api, ls = A.cards()[find(A, "L1")].lines;
    assert.equal(A.dstate(ls[0]), "undecided", "a major change is left alone");
    assert.equal(A.dstate(ls[1]), "hold");
    assert.equal(A.dstate(ls[2]), "accept");
    A.S.tab = "all";                  // the default undecided filter hides it on the minor tab, like any decided change
    var html = showCard(P, "L1");
    assert.match(html, /held by default: a minor change/);
  });
});

test("a plant card shows only its major changes tab until the + opens the others; the minus folds them back onto major", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api, html = showCard(P, "L1");
    assert.match(html, /data-tab="major"/);
    assert.doesNotMatch(html, /role="tab" data-tab="(minor|items|all)"/);
    assert.match(html, /data-tabfold="open" aria-expanded="false"/);
    function click(sel, val) {
      var ev = {target: {closest: function (q) { return q === sel ? {getAttribute: function () { return val; }, tagName: "BUTTON"} : null; }}, preventDefault: function () {}};
      (P.$("card")._listeners.click || []).forEach(function (fn) { fn(ev); });
      return P.$("card").innerHTML;
    }
    // the notice comes first: "OK, I understand" leaves the tabs folded
    html = click("button[data-tabfold]", "open");
    assert.doesNotMatch(html, /role="tab" data-tab="minor"/);
    assert.match(P.$("dialog").innerHTML, /not an expected part of the regular update[\s\S]*Show anyway[\s\S]*OK, I understand/);
    P.$("dlg-close").onclick();
    assert.equal(A.S.moreTabs, false);
    // "Show anyway" opens them
    click("button[data-tabfold]", "open");
    P.$("dlg-show").onclick();
    html = P.$("card").innerHTML;
    assert.match(html, /role="tab" data-tab="minor"/);
    assert.match(html, /role="tab" data-tab="all"/);
    assert.match(html, /data-tabfold="close" aria-expanded="true"/);
    A.S.tab = "items";
    html = click("button[data-tabfold]", "close");
    assert.equal(A.S.tab, "major");
    assert.doesNotMatch(html, /role="tab" data-tab="items"/);
  });
});
