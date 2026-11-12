// The GOGPT card's "copy for Chrome" button: one plant's accepted changes as a message for Claude in Chrome on the GEM web form.
// The message names the plant and its database page, lists each accepted change with its current and new value and the links to add, lists the changes that were not accepted as off limits, carries the SOP rules, and asks for a read-back. Nothing is copied while nothing on the card is accepted.
"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var stub = require("./stub_page.js");

var GEO_JS = fs.readFileSync(path.join(stub.ROOT, "review_core", "web", "geo.js"), "utf8");
var GOGPT_EXT = fs.readFileSync(path.join(stub.ROOT, "trackers", "gogpt", "web", "ext.js"), "utf8");

function page(data, extra) {
  var store = {
    caps: {decide: true, item: true},
    whoami: function () { return Promise.resolve("BL"); },
    load: function () { return Promise.resolve(data); },
    decide: function () { return Promise.resolve([]); },
    item: function () { return Promise.resolve([]); },
    flag: function () { return Promise.resolve([]); }
  };
  var g = {StaticStore: store};
  Object.keys(extra || {}).forEach(function (k) { g[k] = extra[k]; });
  return stub.page({globals: g, before: [[GEO_JS, "geo.js"]], after: [[GOGPT_EXT, "ext.js"]]});
}

var SEC = "https://www.sec.gov/Archives/edgar/data/1/lnt-20260630.htm";
var DNR = "https://programs.iowadnr.gov/easyair/permit-69395";
var OLD = "https://www.eia.gov/electricity/data/eia860/xls/eia8602022.zip";
function ver(urls) { var v = {}; urls.forEach(function (u) { v[u] = {ok: true, contains_value: true, name_found: true, note: ""}; }); return v; }
function line(pid, rid, extra) {
  var l = {key: "a::" + rid, record_id: rid, pid: pid, dir: "a", kind: "change", column: "Status", columns: ["Status"], ref_col: "Status Data Source",
           severity: "major", tier: "high", gem_unit_id: "G1", unit_name: "RH", current: {Status: "announced"}, current_ref: [OLD],
           proposed_values: {Status: "pre-construction"}, proposed_refs: [SEC, DNR], verifications: ver([SEC, DNR]),
           group: 1, group_label: "status", checks: [8], decision: null, reviewed: false, decided_by: null, decided_at: null,
           researcher_notes: "", action: "Set Status of unit RH (G1) to pre-construction. It now says announced. Add the 2 links below to the Status Data Source box. Keep the links already there.", irp: false, sibling_unit_ids: [], sibling_current: {}};
  Object.keys(extra || {}).forEach(function (k) { l[k] = extra[k]; });
  return l;
}
var OLD_DETAIL = "AM 05/2026: The county board rejected the proposal. https://www.wqad.com/old";
var NEW_ENTRY = "January 2026: The cooperative applied for an air construction permit.\n\n" + DNR;
function dataset() {
  var name = "Bobcat Energy Center", units = [{gem_unit_id: "G1", unit_name: "RH", status: "announced", irp_box: "no"}, {gem_unit_id: "G2", unit_name: "3", status: "announced", irp_box: "yes"}];
  return {
    built: "2026-10-29T09:00:00-04:00", dirs: ["a"], us: true,
    scope: {country: "United States", states: ["Iowa"], quarter: "q4-2026"},
    groups: [{id: 1, label: "status", rows: [{row: 8, label: "status"}]}],
    plants: [
      {pid: "L100001062090", plant_pid: "L100001062090", card_kind: "plant", name: name, dir: "a", country: "United States", state: "Iowa", units: units,
       lines: [
         line("L100001062090", "L100001062090:G1:status", {decision: "accept", reviewed: true, irp: true}),
         line("L100001062090", "L100001062090:plant:owner-s", {kind: "plant", column: "Owner(s)", columns: ["Owner(s)"], ref_col: "Owners Data Source", reverified: true,
              current: {"Owner(s)": "Interstate Power and Light Co [100%]"}, current_ref: [SEC], proposed_values: {"Owner(s)": "Interstate Power and Light Co [100%]"}, proposed_refs: [SEC],
              sibling_unit_ids: ["G2"], sibling_current: {G2: "Interstate Power and Light Co [100%]"}, decision: "accept", reviewed: true, severity: "minor",
              action: "Leave Owner(s) of all 2 units of Bobcat Energy Center as Interstate Power and Light Co [100%]. It is still correct."}),
         line("L100001062090", "L100001062090:G1:status-detail", {column: "Status Detail", columns: ["Status Detail"], ref_col: "Status Detail",
              current: {"Status Detail": OLD_DETAIL}, current_ref: ["https://www.wqad.com/old"], proposed_values: {"Status Detail": NEW_ENTRY + "\n\n" + OLD_DETAIL}, proposed_refs: [DNR],
              decision: "accept", reviewed: true, action: "Add the entry below at the top of the Status Detail box of unit RH (G1), above the text already there.\n\n" + NEW_ENTRY}),
         line("L100001062090", "L100001062090:G2:start-year", {kind: "fill", column: "Start year", columns: ["Start year"], ref_col: "Start Year Data Source", gem_unit_id: "G2", unit_name: "3",
              current: {"Start year": ""}, current_ref: [], proposed_values: {"Start year": "2029"}, decision: "hold", reviewed: true}),
         line("L100001062090", "L100001062090:G2:capacity", {kind: "change", column: "Capacity (MW)", columns: ["Capacity (MW)"], ref_col: "Capacity Data Source", gem_unit_id: "G2", unit_name: "3",
              current: {"Capacity (MW)": "250"}, current_ref: [], proposed_values: {"Capacity (MW)": "262"}})
       ],
       items: [{key: "a::L100001062090:entity:new-co", record_id: "L100001062090:entity:new-co", pid: "L100001062090", dir: "a", kind: "entity", gem_unit_id: "", unit_name: "",
                entity_name: "Bobcat Holdings LLC", role: "parent", lookup_result: "No match in the entity list.", links: [], verifications: {}, notes: "", call: null, call_note: "",
                group: 1, group_label: "status", checks: [19], pm: false, irp: false},
               {key: "a::L100001062090:entity:ipl", record_id: "L100001062090:entity:ipl", pid: "L100001062090", dir: "a", kind: "entity", gem_unit_id: "", unit_name: "",
                entity_name: "Interstate Power and Light Co", role: "owner", lookup_result: "Entity appears on 28 units. Reuse existing entity ID; do NOT create a new one.", links: [], verifications: {}, notes: "", call: null, call_note: "",
                group: 1, group_label: "status", checks: [19], pm: false, irp: false}]},
      {pid: "L100001062090#add", plant_pid: "L100001062090", card_kind: "addition", name: name, dir: "a", country: "United States", state: "Iowa", units: units,
       lines: [line("L100001062090#add", "L100001062090:new:gt1", {kind: "new_row", column: "", columns: ["Unit name", "Capacity (MW)"], ref_col: "", unit_name: "GT1", gem_unit_id: "",
                    current: {}, current_ref: null, proposed_values: {"Unit name": "GT1", "Capacity (MW)": "21.3"}, proposed_refs: [SEC], refs_by_col: {"Capacity Data Source": [SEC]},
                    units: [], lane: "newunits", plant_name: name, ready: true, decision: "accept", reviewed: true, action: ""})],
       items: []},
      {pid: "new:severn-barge-station", plant_pid: "", card_kind: "addition", name: "Severn barge station", dir: "a", country: "United States", state: "Iowa", units: [],
       lines: [line("new:severn-barge-station", "us-ia-x:plant:newplant", {kind: "new_row", column: "", columns: ["Owner(s)"], ref_col: "", unit_name: "", gem_unit_id: "",
                    current: {}, current_ref: null, proposed_values: {"Owner(s)": "Acme Power LLC [100%]"}, proposed_refs: [SEC], refs_by_col: {"Owners Data Source": [SEC]},
                    units: [{unit_name: "1", fields: {"Capacity (MW)": "300", Status: "announced"}, refs_by_col: {"Status Data Source": [SEC]}, notes: "", action: ""}],
                    lane: "newplants", plant_name: "Severn barge station", ready: true, decision: "accept", reviewed: true, action: ""})],
       items: []},
      {pid: "L2", plant_pid: "L2", card_kind: "plant", name: "Quiet station", dir: "a", country: "United States", state: "Iowa", units: [{gem_unit_id: "G9", unit_name: "1", status: "announced"}],
       lines: [line("L2", "L2:G9:status", {gem_unit_id: "G9", unit_name: "1"})], items: []}
    ]
  };
}
function find(A, pid) { var hit = -1; A.cards().forEach(function (p, i) { if (p.pid === pid) hit = i; }); return hit; }
function showCard(P, pid) { var A = P.app.api; A.FS.status = []; A.refilter(true); A.S.pipe = find(A, pid); A.renderCard(); return P.$("card").innerHTML; }
function click(P, sel) {
  var ev = {target: {closest: function (s) { return s === sel ? {getAttribute: function () { return "1"; }} : null; }}, preventDefault: function () {}};
  (P.$("card")._listeners.click || []).forEach(function (fn) { fn(ev); });
}

test("the card head carries the copy for Chrome button; clicking it copies the plant's accepted changes as one message with the rules", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api, copied = [], toasts = [];
    A.copyText = function (t, m) { copied.push(t); toasts.push(m); };
    A.toast = function (m) { toasts.push(m); };
    var html = showCard(P, "L100001062090");
    assert.match(html, /<button type="button" class="bulk chrome" data-chrome="1"[^>]*>[^<]*copy for Chrome<\/button>/);
    assert.doesNotMatch(html, /data-bulk=/);
    click(P, "button[data-chrome]");
    assert.equal(copied.length, 1);
    var t = copied[0];
    assert.match(toasts[0], /copied for Claude in Chrome/);
    // the opening points at the public instructions page; the message carries only this plant's specifics
    assert.match(t, /^You are helping Baird apply reviewed edits to one plant in the GEM project database web form\.\nBefore you touch the form, open this page and read all of it: https:\/\/raw\.githubusercontent\.com\/bairdlangenbrunner\/gogpt-researcher\/main\/docs\/chrome_apply_instructions\.md\nThat page says how to fill in the form\. This message says what to change\. If you cannot open the page, stop and tell me\.\n\n/);
    assert.match(t, /\n\nAPPLIER: Baird Langenbrunner\nDATE: \d{4}-\d\d-\d\d\nCOUNTRY: United States\nPLANT: Bobcat Energy Center \(GEM plant id L100001062090; Iowa, United States\)\nOpen: https:\/\/gem-project-db\.herokuapp\.com\/projects\/edit\/100001062090\n\nEDITS \(3\), already in the order of work\n\n/);
    // the how-to lives on the instructions page, not in the message
    assert.doesNotMatch(t, /RULES|ORDER OF WORK|UNIT NAMES|On the form|Record of Full Updates|Never press Return/);
    // the three accepted edits, in card order except that ownership goes last, with the current and new values and the links to add; the two kept links are never repeated
    assert.match(t, /EDITS \(3\), already in the order of work\n\n1\. Unit RH \(G1\): Status\n   Now: announced\n   Set to: pre-construction\n   Add to the Status Data Source box:\n     https:\/\/www\.sec\.gov[^\n]*\n     https:\/\/programs\.iowadnr\.gov[^\n]*\n   Also tick the IRP box on this unit\.\n/);
    assert.match(t, /   The researcher wrote: Set Status of unit RH \(G1\) to pre-construction\.[^\n]*\n   Record id: L100001062090:G1:status\n/);
    assert.match(t, /3\. All 2 units of the plant \(G1, G2\), the same value on each: Owner\(s\)\n   Now: Interstate Power and Light Co \[100%\]\n   Leave as: Interstate Power and Light Co \[100%\]\n   Owners Data Source: the link is already in the box\. Add nothing there\.\n/);
    // Status Detail: the new entry only, between marker lines; its links stay in the text
    assert.match(t, /2\. Unit RH \(G1\): Status Detail\n   Now: the box starts with "AM 05\/2026: The county board rejected the proposal\. https:\/\/www\.wqad\.com\/old"\n   New entry for the top of the box:\n---- begin ----\nJanuary 2026: The cooperative applied for an air construction permit\.\n\nhttps:\/\/programs\.iowadnr\.gov\/easyair\/permit-69395\n---- end ----\n/);
    assert.doesNotMatch(t, /---- begin ----\n[\s\S]*AM 05\/2026[\s\S]*---- end ----/);
    // research status: updated on every existing unit an accepted edit touches, once each
    assert.match(t, /RESEARCH STATUS \(instructions section 9\)\nupdated on units RH \(G1\), 3 \(G2\)\n\nNOT INCLUDED:/);
    assert.doesNotMatch(t, /added on the new/);
    // the held and undecided changes are off limits; the missing entity is named, the existing one is not
    assert.match(t, /NOT INCLUDED: leave these alone, they were not accepted: Unit 3 \(G2\) Start year \(held\); Unit 3 \(G2\) Capacity \(MW\) \(not decided yet\)\.\n\n/);
    assert.match(t, /ENTITIES: Bobcat Holdings LLC \(parent\) is not in GEM's entity list yet\.\n\n/);
    assert.doesNotMatch(t, /Interstate Power and Light Co \(owner\)/);
    // the read-back format is on the instructions page
    assert.match(t, /WHEN DONE\nReload the page and reply with the read-back in section 11 of the instructions page, one JSON object per record id\.\n$/);
    assert.equal(t, P.app.chromeText(A.cards()[A.S.pipe]));
  });
});

test("new units at a tracked plant and a new plant have their own wording; a card with nothing accepted copies nothing and says so; a watch card has no button", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api, copied = [], toasts = [];
    A.copyText = function (t) { copied.push(t); };
    A.toast = function (m) { toasts.push(m); };
    showCard(P, "L100001062090#add"); click(P, "button[data-chrome]");
    var add = copied.pop();
    assert.match(add, /Open: https:\/\/gem-project-db\.herokuapp\.com\/projects\/edit\/100001062090\n/);
    assert.match(add, /NEW UNITS \(1\)\n\n1\. Add a new unit at this plant, named GT1, with these fields:\n     Unit name: GT1\n     Capacity \(MW\): 21\.3\n[\s\S]*?     Links to add:\n       Capacity Data Source: https:\/\/www\.sec\.gov[^\n]*\n   Record id: L100001062090:new:gt1\n/);
    assert.doesNotMatch(add, /EDITS \(|UNIT NAMES|ADDING A UNIT/);
    assert.match(add, /RESEARCH STATUS \(instructions section 9\)\nadded on the new unit GT1\n\n/);
    assert.doesNotMatch(add, /updated on/);
    showCard(P, "new:severn-barge-station"); click(P, "button[data-chrome]");
    var np = copied.pop();
    assert.match(np, /added on the new unit 1\n/);
    assert.match(np, /PLANT: Severn barge station \(new to GEM; Iowa, United States\)\nI have already created this project in the web form and have its edit page open in this tab\. Do not create another one\.\n\n/);
    assert.match(np, /NEW PLANT \(1\)\n\n1\. Fill in the plant fields of Severn barge station in Iowa, United States\. The project already exists, so set these fields on it and leave any field already filled in that matches:\n   Then add unit 1, named 1:\n     Capacity \(MW\): 300\n     Status: announced\n     Links to add:\n       Status Data Source: https:\/\/www\.sec\.gov[^\n]*\n   Last, after the units, set the ownership fields of the plant:\n     Owner\(s\): Acme Power LLC \[100%\]\n     Links to add:\n       Owners Data Source: https:\/\/www\.sec\.gov/);
    // nothing accepted: the button still works and copies every proposed change that is not rejected, with a note saying so
    var html = showCard(P, "L2");
    assert.match(html, /class="bulk chrome" data-chrome="1"/);
    assert.doesNotMatch(html, /aria-disabled/);
    var before = copied.length;
    click(P, "button[data-chrome]");
    assert.equal(copied.length, before + 1);
    assert.match(copied[copied.length - 1], /NOTE: nothing on this card has been accepted yet/);
  });
});

test("country and coordinates come first and ownership last: location edits lead the list, location fields lead each entry, a new plant's owners follow its units", function () {
  var d = dataset(), bob = d.plants[0], sev = d.plants[2];
  bob.lines.push(line("L100001062090", "L100001062090:plant:location", {kind: "plant", column: "Latitude", columns: ["Location accuracy", "Longitude", "Latitude"], ref_col: "",
    current: {Latitude: "41.1", Longitude: "-91.5", "Location accuracy": "approximate"}, proposed_values: {Latitude: "41.2", Longitude: "-91.6", "Location accuracy": "exact"},
    proposed_refs: [], sibling_unit_ids: ["G2"], decision: "accept", reviewed: true, action: ""}));
  sev.lines[0].proposed_values = {"Owner(s)": "Acme Power LLC [100%]", Longitude: "-91.0", "Country/Area": "United States", Latitude: "41.0"};
  var P = page(d);
  return P.booted.then(function () {
    var A = P.app.api, copied = [];
    A.copyText = function (t) { copied.push(t); };
    A.toast = function () {};
    showCard(P, "L100001062090"); click(P, "button[data-chrome]");
    var t = copied.pop();
    assert.match(t, /EDITS \(4\), already in the order of work\n\n1\. All 2 units of the plant \(G1, G2\), the same value on each: Latitude, Longitude, Location accuracy\n   Latitude:\n   Now: 41\.1\n   Set to: 41\.2\n   Longitude:\n   Now: -91\.5\n   Set to: -91\.6\n   Location accuracy:\n/);
    assert.match(t, /\n2\. Unit RH \(G1\): Status\n[\s\S]*\n3\. Unit RH \(G1\): Status Detail\n[\s\S]*\n4\. All 2 units of the plant \(G1, G2\), the same value on each: Owner\(s\)\n/);
    showCard(P, "new:severn-barge-station"); click(P, "button[data-chrome]");
    var np = copied.pop();
    assert.match(np, /leave any field already filled in that matches:\n     Country\/Area: United States\n     Latitude: 41\.0\n     Longitude: -91\.0\n   Then add unit 1[\s\S]*\n   Last, after the units, set the ownership fields of the plant:\n     Owner\(s\): Acme Power LLC \[100%\]\n/);
  });
});

test("the message names the page's reviewer as the person applying the edits; a page without one names Baird", function () {
  var P = page(dataset(), {REVIEW_STATIC: {reviewer: "AL", reviewer_name: "Amalia Llano"}});
  return P.booted.then(function () {
    var A = P.app.api, copied = [];
    A.copyText = function (t) { copied.push(t); };
    A.toast = function () {};
    showCard(P, "L100001062090");
    click(P, "button[data-chrome]");
    var t = copied[0];
    assert.match(t, /^You are helping Amalia apply reviewed edits/);
    assert.match(t, /\nAPPLIER: Amalia Llano\n/);
    assert.doesNotMatch(t, /Baird/);
  });
});

test("a new plant's card puts each block's sources right under its data points: the plant's under the plant fields, each unit's under that unit", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var h = showCard(P, "new:severn-barge-station");
    var order = ["<td>Owner(s)</td>", ">sources<", "<td>Owners Data Source</td>", "unit 1", "<td>Capacity (MW)</td>", "<td>Status</td>", ">sources<", "<td>Status Data Source</td>"];
    var at = [], from = 0;
    order.forEach(function (s) { var i = h.indexOf(s, from); at.push(i); if (i >= 0) from = i + 1; });
    at.forEach(function (i, n) { assert.ok(i >= 0, order[n] + " present in order"); });
    assert.equal((h.match(/class="rowdata refs"/g) || []).length, 2);
  });
});

test("engine counts sit at the top of a card with the total capacity: on a new row, and on an edit that leaves the total as it is", function () {
  var P = page(dataset());
  return P.booted.then(function () {
    var A = P.app.api;
    var nr = A.cards()[find(A, "L100001062090#add")].lines[0];
    nr.proposed_values = {"Unit name": "GT1", Status: "announced", "Capacity Per Engine": "7.1", "Capacity (MW)": "21.3", "Number Of Engines": "3"};
    var h = showCard(P, "L100001062090#add");
    var order = ["<td>Capacity (MW)</td>", "<td>Number Of Engines</td>", "<td>Capacity Per Engine</td>", "<td>Unit name</td>", "<td>Status</td>"];
    var at = order.map(function (s) { return h.indexOf(s); });
    at.forEach(function (i, n) { assert.ok(i >= 0, order[n] + " present"); if (n) assert.ok(i > at[n - 1], order[n] + " after " + order[n - 1]); });
    var ed = A.cards()[find(A, "L100001062090")].lines.filter(function (l) { return l.column === "Capacity (MW)"; })[0];
    ed.columns = ["Number Of Engines"]; ed.column = "Number Of Engines";
    ed.current = {"Capacity (MW)": "250", "Number Of Engines": "2"}; ed.proposed_values = {"Number Of Engines": "3"};
    h = showCard(P, "L100001062090");
    var cap = h.indexOf('<td class="f">Capacity (MW)</td>'), eng = h.indexOf('<td class="f">Number Of Engines</td>');
    assert.ok(cap >= 0 && eng > cap, "the unchanged total shows just above the engine count");
  });
});
