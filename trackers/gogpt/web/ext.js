/* GOGPT extension for the shared review app (gem-review-app). Loads after review_core/web/app.js and registers everything GOGPT-only through ReviewApp.define: the checklist groups and the checklist pane, the where filter (country and state), the ask-the-PM flag, units on a plant, new rows, the IRP chip, watch items and the close-out panel. */
(function () {
  "use strict";
  if (!window.ReviewApp || !window.ReviewApp.define) return;
  var TB = (window.REVIEW_STATIC || {}).tracker || {};

  window.ReviewApp.define(function (A) {
    var $ = A.$, esc = A.esc, linkText = A.linkText, chip = A.chip, tipAttrs = A.tipAttrs, blankv = A.blankv, cur = A.cur, S = A.S;
    var ROW_LABEL = {};        // checklist row number -> its label (from the dataset's groups)
    var VIEW = "plants";       // the left pane: "plants" (the queue) or "checklist" (the QC/Country checklist groups)
    var QTAB = "suggestions";  // the queue tab: "suggestions" (tracked plants with something proposed: edits, items, watch), "check" (plants the batch proposed nothing for) or "new" (plants GEM does not track yet and new units at tracked plants)
    try { var qt = localStorage.getItem("review-qtab"); if (qt === "check" || qt === "new") QTAB = qt; } catch (e) { /* ignore */ }
    var closeoutCopy = {};     // the close-out panel's copy buttons: units, draft

    var KIND_LABEL = {plant: "plant-wide", reverified: "re-verified", checked: "no suggested changes", monitor: "watch item", entity: "new owner or operator to create"};
    var MONITOR_LABEL = {new_to_tracker: "watch item: new to the tracker", existing_plant: "watch item: existing plant"};
    var LEAD_LABEL = {newunits: "new unit lead", newplants: "new plant lead"};
    var KIND_TIP = {concern: "a question the researcher raised about data already in GEM: a value that could not be checked, two sources that disagree, a possible duplicate. It never changes a cell by itself",
                    entity: "an owner, operator or parent that is not in GEM's entity list yet. Someone has to create it in the GEM web form before the ownership edit can land",
                    new_to_tracker: "a plant or project GEM does not track at all yet. The researcher found it but it did not clear the bar for a new row (too early, too small, or too thin on evidence). Decide whether it goes into the database now, stays on the watchlist, goes to the possible-updates sheet, or comes off the list",
                    existing_plant: "something to watch on a plant GEM already tracks: a permit in progress, an expansion, a retirement date to confirm. The plant's row is not changed by this item",
                    lead: "the researcher found signs of a new unit or plant but not enough to write the row: no capacity, no status, or no source that states them. Decide whether it goes into the database now, gets researched further in the next batch, stays on the watchlist, goes to the possible-updates sheet, or comes off the list"};
    // the three sections of the left list, in page order: what a card is decides where it sits (review_data.py card_kind)
    // the new tab splits its cards in two: the ones with a row to add (a new plant or new units) first, then the ones with only leads or questions
    var SECTION = {plant: "plants", addition: "proposed additions", watch: "watch list", newrows: "new rows to add", newleads: "leads and questions"};
    var SECTION_TIP = {plant: "plants GEM tracks in this scope. On the suggestions tab: the ones with proposed cell edits, questions about existing data or owners to create. On the to check tab: the ones the batch proposed nothing for, which you mark checked once you have looked at them",
                       addition: "on the new tab: the plants GEM does not track yet, and the new units the batch proposes at tracked plants, with the leads that are not ready to add yet",
                       watch: "things to keep an eye on at plants GEM already tracks; nothing here changes a cell",
                       newrows: "the major decisions: plants GEM does not track yet and new units at tracked plants where the batch wrote the row to add. Accepting one adds it to the database",
                       newleads: "the smaller calls: leads, watch items and questions on whether something is new. No row is written yet, so nothing here adds to the database by itself"};
    var BY_PLANT = {};         // GEM plant id -> {plant: card index, addition: card index, watch: card index}
    var TIER_TIP = {high: "green: one fully checked source (a status change needs two independent publishers)",
                    medium: "yellow: a single source on a status change, or a source that only partly supports the value",
                    low: "red: a single weak or unchecked source"};
    var CONCERN_ISSUE = {unverified_value: "a value could not be checked against its source", conflict: "two sources disagree",
                         duplicate: "this may duplicate another row", missing_source: "a value has no source link",
                         capacity: "the capacity figure needs a closer look", status: "the status needs a closer look",
                         ownership: "the owner or operator needs a closer look",
                         // the normalized kinds (review_app/checklist.py CONCERN_KINDS in gogpt-researcher)
                         existence: "does this plant or unit exist as GEM records it?", scope: "is this in the tracker's scope?",
                         "capacity-threshold": "is this above the capacity threshold?", identity: "which plant or unit is this?",
                         attribution: "who owns or operates this?", "conversion-link": "how does this link to a coal or other unit?",
                         location: "where exactly is this?", source: "the source needs a closer look", validation: "a GEM validation error",
                         other: "a question about this plant's data"};

    // ---- small helpers ----
    function D() { return A.D; }
    function FS() { return A.FS; }
    function plants() { return A.cards(); }
    // the checklist group of a line or item as a string ("1".."9" or "other"); review_data.py sets it
    function groupOf(o) { return o.group == null ? "other" : String(o.group); }
    function groupLabel(gid) {
      var g = (D().groups || []).filter(function (x) { return String(x.id) === gid; })[0];
      return g ? g.label : (gid === "other" ? "other" : "group " + gid);
    }
    function groupTip(o) {
      var rows = (o.checks || []).map(function (n) { return "row " + n + (ROW_LABEL[n] ? ": " + ROW_LABEL[n] : ""); });
      return "QC/Country checklist group " + groupOf(o) + ": " + groupLabel(groupOf(o)) + (rows.length ? "\nticks " + rows.join("\n") : "\n(no checklist row: a gap the checklist does not cover)");
    }
    // "new:<name>" ids mark a plant GEM does not track yet (a discovery candidate on the monitor list)
    function untracked(p) { return !p.pid || p.pid.indexOf("new:") === 0; }
    // plant (its edits) | addition (new plant, or new units and leads at a tracked plant) | watch; older datasets carry no card_kind
    function cardKind(p) { return p.card_kind || (untracked(p) ? "addition" : "plant"); }
    // the GEM plant id behind a card: the "<id>#add" and "<id>#watch" cards share it with the plant card; "" for a plant GEM does not track
    function plantId(p) { return p.plant_pid != null ? p.plant_pid : (untracked(p) ? "" : String(p.pid || "").replace(/#(add|watch)$/, "")); }
    function isLead(it) { return it.kind === "monitor" && !!it.lead_for; }
    // the other cards of the same plant: [{kind, index, card}], in section order
    function siblings(p) {
      var id = plantId(p), by = id && BY_PLANT[id], out = [];
      if (!by) return out;
      ["plant", "addition", "watch"].forEach(function (k) { if (by[k] != null && plants()[by[k]] !== p) out.push({kind: k, index: by[k], card: plants()[by[k]]}); });
      return out;
    }
    function unitOf(p, id) {
      var us = (p && p.units) || [];
      for (var i = 0; i < us.length; i++) if (us[i].gem_unit_id === id) return us[i];
      return null;
    }
    function unitText(u, id) {
      if (!u) return id ? "unit " + id : "";
      return "unit " + (u.unit_name ? u.unit_name + " (" + u.gem_unit_id + ")" : u.gem_unit_id);
    }
    function unitNames(p) {
      return p.units.map(function (u) { return String(u.unit_name || u.gem_unit_id || "").trim(); }).filter(Boolean);
    }
    // a new row is a new unit (lane newunits) or a new plant; an older dataset without the lane goes by the unit name
    function newUnit(l) { return l.lane ? l.lane === "newunits" : !!l.unit_name; }
    // where on the plant a line lands: "unit F701 (G100000401771)", "plant-wide (4 units)", "under Fisk Generating Station" (a new unit row; a new plant row has no where)
    function rowLabel(l) {
      var p = plants()[l._p];
      if (l.kind === "new_row") return newUnit(l) ? "under " + (l.plant_name || (p && p.name) || "the plant") : "";
      if (l.kind === "plant") {
        var n = 1 + (l.sibling_unit_ids || []).length;
        return "plant-wide" + (n > 1 ? " (" + n + " units)" : "");
      }
      return unitText(unitOf(p, l.gem_unit_id), l.gem_unit_id);
    }
    // the unit a line sits under for grouping: "" = plant-wide
    function lineUnit(l) { return l.kind === "plant" || l.kind === "new_row" ? "" : (l.gem_unit_id || ""); }
    function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

    // ---- where: the one location filter (country and state) ----
    function countries() { return A.uniq(plants().map(function (p) { return p.country; })); }
    // a country's batch states; a non-US batch's "state" is its country name, which is not a state
    function realStates(k) {
      var all = (D().scope && D().scope.states) || [];
      return all.filter(function (s) { return s !== k && plants().some(function (p) { return p.country === k && p.state === s; }); });
    }
    function andList(xs) { return xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]; }
    function placeName(k) { var st = realStates(k); return st.length ? andList(st) + ", " + k : k; }
    var NO_COUNTRY = "(none)";   // FS.country sentinel: every box unticked, so nothing matches (empty = no filter)
    // the countries in view: the ticked ones, or all of them when none is ticked
    function countriesInView() {
      var all = countries(), sel = FS().country || [];
      return sel.length ? all.filter(function (k) { return sel.indexOf(k) >= 0; }) : all;
    }
    // the states offered, alphabetically: only once a country is picked (or the page covers just one), and only for countries that have states (the United States, say)
    function stateChoices() {
      var cs = countriesInView(), out = [];
      if (!FS().country.length && cs.length > 1) return out;
      cs.forEach(function (k) { out = out.concat(realStates(k)); });
      return out.sort(function (a, b) { return a.localeCompare(b); });
    }
    // ticked values in the filter, leaving out the nothing-ticked sentinel
    function picked(v) { return (v || []).filter(function (x) { return x !== NO_COUNTRY; }); }
    // the last state subset the reviewer picked: when the state menu goes away (the country is unticked) and comes back, that subset returns instead of all states
    var lastStates = [];
    function rememberStates() { var st = picked(FS().state); if (st.length) lastStates = st; }
    // after the countries change: keep the states that are still offered, and bring the remembered subset back when the menu was gone
    function reconcileStates(hadChoices) {
      var f = FS(), ok = stateChoices(), keep = picked(f.state).filter(function (st) { return ok.indexOf(st) >= 0; });
      if (!keep.length && !hadChoices && ok.length) keep = lastStates.filter(function (st) { return ok.indexOf(st) >= 0; });
      f.state = keep.length === ok.length ? [] : keep;
    }
    // drop a route's country or state that is not on this page
    function whereValid() {
      var fs = FS(), all = countries(), sts = stateChoices();
      return picked(fs.country).every(function (k) { return all.indexOf(k) >= 0; }) && picked(fs.state).every(function (st) { return sts.indexOf(st) >= 0; });
    }
    // two-letter postal codes for the US states: the header boxes show the code, the state menu shows the code and the full name
    var ABBR = {"Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY", "Puerto Rico": "PR"};
    function abbr(st) { return ABBR[st] || st; }
    // one checkbox menu (the same as the pipelines reviewer's country menu): any ticked value matches, none ticked is no filter, each with its live count under the other filters
    function checkMenu(id, label, values, field, counts, show) {
      var box = $(id), fs = FS(), sel = fs[field] || [], n = sel.length, was = box.querySelector("details"), open = was && was.open;
      box.hidden = !values.length;
      if (box.hidden) return;
      box.innerHTML = '<details class="cdrop"' + (open ? " open" : "") + "><summary>" + label + '</summary><div class="cmenu"><button type="button" class="ctoggle">' + (!n || picked(sel).length === values.length ? "deselect all" : "select all") + "</button>" +
        values.map(function (k) { return '<label class="check"><input type="checkbox" value="' + esc(k) + '"' + (!n || sel.indexOf(k) >= 0 ? " checked" : "") + "> " + esc(show ? show(k) : k) + " (" + counts[k] + ")</label>"; }).join("") + "</div></details>";
    }
    // the country and state menus; the state menu shows once a country that has states is in view
    function renderCountries() {
      var fs = FS(), q = fs.q.trim().toLowerCase(), all = countries(), sts = stateChoices(), cc = {}, sc = {};
      all.forEach(function (k) { cc[k] = 0; });
      sts.forEach(function (k) { sc[k] = 0; });
      plants().forEach(function (p) {
        p.lines.concat(p.items).forEach(function (o) {
          if (A.match(o, p, fs, "country", q)) cc[p.country]++;
          if (p.state in sc && A.match(o, p, fs, "state", q)) sc[p.state]++;
        });
      });
      checkMenu("f-country", "country", all, "country", cc);
      checkMenu("f-state", "state", sts, "state", sc, function (st) { return abbr(st) === st ? st : abbr(st) + " - " + st; });
      renderStatus();
    }
    // ---- status: the plant's current status (its units' statuses), grouped into in development and the rest ----
    // statuses compare by letters only, so "pre-construction" and "Pre construction" match; an inferred status carries its age ("shelved - inferred 2 y"), which is dropped so every age is one choice
    function statusBase(s) { return String(s || "").trim().replace(/\s+\d+\s*y(ears?)?$/i, ""); }
    function statusKey(s) { return statusBase(s).toLowerCase().replace(/[^a-z]/g, ""); }
    var DEV_STATUS = ["announced", "preconstruction", "construction", "shelved", "shelvedinferred"];
    var DEV_LABEL = ["announced", "pre-construction", "construction", "shelved", "shelved - inferred"];
    // the other statuses GEM uses, always in the menu so a page with no plant in one still shows it grayed out
    var REST_LABEL = ["operating", "mothballed", "retired", "cancelled", "cancelled - inferred"];
    function isDev(s) { return DEV_STATUS.indexOf(statusKey(s)) >= 0; }
    // the statuses a card's plant has now: its units' statuses as they stand in the database. A status the researcher proposes (a change line, a new row) never counts; a card with no unit rows yet has no current status
    function statusesOf(p) {
      var out = [];
      function add(units) { (units || []).forEach(function (u) { var v = statusBase(u.status); if (v && out.indexOf(v) < 0) out.push(v); }); }
      add(p.units);
      // a watch card with no unit rows of its own takes its plant card's statuses, so "in development" keeps a plant's other cards in view
      if (!out.length && !untracked(p) && cardKind(p) === "watch") {
        var at = BY_PLANT[plantId(p)], pc = at && at.plant != null ? plants()[at.plant] : null;
        if (pc) add(pc.units);
      }
      return out;
    }
    // the page opens on the plants in development (plus the new plants proposed in development): the rest is under "other statuses" and "new (other)" in the status menu, off until ticked
    function devDefault() { return DEV_LABEL.concat([NEW_DEV]); }
    function isDefaultStatus(sel) { return sel.map(statusKey).sort().join("|") === devDefault().map(statusKey).sort().join("|"); }
    // every status on the page: in development first (all five, announced to shelved, in that order), then the rest alphabetically (the known ones too); a status the page has no plant in is left out of `have` and shows grayed out
    function statusChoices() {
      var seen = {}, all = [];
      plants().forEach(function (p) { if (!byProposal(p)) statusesOf(p).forEach(function (s) { if (!seen[statusKey(s)]) { seen[statusKey(s)] = s; all.push(s); } }); });
      var dev = DEV_STATUS.map(function (k, i) { return seen[k] || DEV_LABEL[i]; });
      var rest = all.filter(function (s) { return !isDev(s); });
      REST_LABEL.forEach(function (l) { if (!seen[statusKey(l)]) rest.push(l); });
      rest.sort(function (a, b) { return a.localeCompare(b); });
      return {dev: dev, rest: rest, have: all};
    }
    // the addition cards (a plant GEM does not track yet, or new units proposed at a tracked plant) filter on the statuses their new rows and leads propose, not on the plant's current status:
    // "new (in-dev)" when any proposed status is in development (shelved included) or none is given, "new (other)" when every one is outside it (operating, retired and so on).
    // So a new unit row that is already operating, such as a 1968 peaker missing from GEM, stays off the default view (Baird 2026-10-27)
    var NEW_DEV = "new (in-dev)", NEW_OTHER = "new (other)";
    function byProposal(p) { return untracked(p) || cardKind(p) === "addition"; }
    function isNew(s) { return s === NEW_DEV || s === NEW_OTHER; }
    function newStatusOf(p) {
      var ss = [];
      p.lines.forEach(function (l) {
        if (l.kind !== "new_row") return;
        [l.proposed_values || {}].concat((l.units || []).map(function (u) { return u.fields || {}; })).forEach(function (f) { if (f.Status) ss.push(f.Status); });
      });
      p.items.forEach(function (it) { if (it.status) ss.push(it.status); });
      return !ss.length || ss.some(isDev) ? NEW_DEV : NEW_OTHER;
    }
    function statusOn(p, sel) {
      if (byProposal(p)) return sel.indexOf(newStatusOf(p)) >= 0;
      var ss = statusesOf(p);
      if (!ss.length) return !(sel.length === 1 && sel[0] === NO_COUNTRY);     // a card whose status the page does not know stays in view unless every box is unticked
      return ss.some(function (s) { return sel.some(function (x) { return statusKey(x) === statusKey(s); }); });
    }
    // the status menu in the bar: an "in development" box that ticks its five statuses together, each with its live count, then "new (in-dev)".
    // Below a divider, the other statuses (operating, retired, cancelled and so on) sit under an "other statuses" box, then "new (other)" at the very bottom, all off by default
    function renderStatus() {
      var box = $("f-status");
      if (!box) return;
      var fs = FS(), q = fs.q.trim().toLowerCase(), ch = statusChoices(), news = plants().filter(byProposal).map(newStatusOf), all = ch.have.concat([NEW_DEV, NEW_OTHER].filter(function (s) { return news.indexOf(s) >= 0; })), sel = fs.status || [], n = sel.length, counts = {};
      var was = box.querySelector("details"), open = was && was.open;
      box.hidden = !all.length;
      if (box.hidden) return;
      all.forEach(function (s) { counts[s] = 0; });
      plants().forEach(function (p) {
        var mine = byProposal(p) ? [statusKey(newStatusOf(p))] : statusesOf(p).map(statusKey);
        p.lines.concat(p.items).forEach(function (o) {
          if (!A.match(o, p, fs, "status", q)) return;
          all.forEach(function (s) { if (mine.indexOf(statusKey(s)) >= 0) counts[s]++; });
        });
      });
      function avail(s) { return all.some(function (x) { return statusKey(x) === statusKey(s); }); }
      function on(s) { return avail(s) && (!n || sel.some(function (x) { return statusKey(x) === statusKey(s); })); }
      function group(id, label, tip, xs) {
        if (!xs.length) return "";
        var have = xs.filter(avail), k = have.filter(on).length;
        return '<label class="check sgroup"' + tipAttrs(tip) + '><input type="checkbox" data-group="' + id + '"' + (have.length ? "" : " disabled") + (have.length && k === have.length ? " checked" : "") + (k && k < have.length ? ' data-partial="1"' : "") + "> <b>" + label + "</b></label>" +
          xs.map(function (s) { var ok = avail(s); return '<label class="check schild' + (ok ? "" : " none") + '"' + (ok ? "" : tipAttrs("no plant on this page has this status")) + '><input type="checkbox" value="' + esc(s) + '"' + (ok ? "" : " disabled") + (on(s) ? " checked" : "") + "> " + esc(s) + " (" + (counts[s] || 0) + ")</label>"; }).join("");
      }
      function newBox(s, tip, cls) {
        var ok = news.indexOf(s) >= 0;
        return '<label class="check sgroup' + cls + (ok ? "" : " none") + '"' + tipAttrs(ok ? tip : "no plant like this on this page") + '><input type="checkbox" value="' + esc(s) + '"' + (ok ? "" : " disabled") + (on(s) ? " checked" : "") + "> <b>" + esc(s) + " (" + (counts[s] || 0) + ")</b></label>";
      }
      var restOn = ch.rest.concat([NEW_OTHER]).filter(on).length;
      box.innerHTML = '<details class="cdrop"' + (open ? " open" : "") + '><summary>status' + (restOn ? ' <span class="n">+' + restOn + "</span>" : "") + '</summary><div class="cmenu"><button type="button" class="ctoggle">' + (!n || picked(sel).length === all.length ? "deselect all" : "select all") + "</button>" +
        group("dev", "in development", "announced, pre-construction, construction, shelved and shelved-inferred: the plants the update is about", ch.dev) +
        newBox(NEW_DEV, "new plants and new units this page proposes adding as in development (shelved included), or with no status given", "") +
        group("rest", "other statuses", "every status outside in development: operating, retired, cancelled and so on. Off by default, so the page stays on the plants the update is about", ch.rest).replace('class="check sgroup"', 'class="check sgroup ssep"') +
        newBox(NEW_OTHER, "new plants and new units this page proposes adding with a status outside in development, such as operating or retired. Off by default", "") + "</div></details>";
      Array.prototype.forEach.call(box.querySelectorAll("input[data-partial]"), function (i) { i.indeterminate = true; });
    }
    // header: the ticked countries as boxes, alphabetical, then the ticked states whenever the state menu shows, then the plant count.
    // A country or state the filter leaves out is not shown at all, and the boxes do nothing on a click: the filter dropdowns are the one place to tick and untick (Baird 2026-10-26)
    function renderScope() {
      var el = $("scope");
      if (!el || !D()) return;
      var fs = FS(), inView = countriesInView();
      // the plant count follows the country and state boxes: a plant counts when its country is ticked and, if states are narrowed, its state is too
      var n = plants().filter(function (p) {
        if (p.statewide) return false;
        if (fs.country.length && fs.country.indexOf(p.country) < 0) return false;
        return !fs.state.length || fs.state.indexOf(p.state) >= 0;
      }).length;
      function box(name, tip, shown) { return '<span class="cbox"' + tipAttrs(tip) + ">" + esc(shown || name) + "</span>"; }
      function sorted(xs) { return xs.slice().sort(function (a, b) { return a.localeCompare(b); }); }
      var states = stateChoices().filter(function (st) { return !fs.state.length || fs.state.indexOf(st) >= 0; });
      el.innerHTML = sorted(inView).map(function (k) { return box(k, "country filter: " + k); }).join("") +
        sorted(states).map(function (st) { return box(st, "state filter: " + st, abbr(st)); }).join("") +
        '<span class="nplants">' + plural(n, "plant") + "</span>";
      el.onclick = null;
    }

    // ---- checklist groups ----
    // per checklist group: everything in it (edits and items), how much is still open, how much is flagged for the PM
    function groupStats() {
      var out = {};
      (D().groups || []).forEach(function (g) { out[String(g.id)] = {total: 0, open: 0, pm: 0, rows: {}}; });
      A.LINES.concat(A.ITEMS).forEach(function (o) {
        var gid = groupOf(o), s = out[gid] || (out[gid] = {total: 0, open: 0, pm: 0, rows: {}});
        if (!A.counted(o)) return;
        var open = A.isOpen(o);
        s.total++;
        if (open) s.open++;
        if (o.pm_flag) s.pm++;
        (o.checks || []).forEach(function (n) { s.rows[n] = s.rows[n] || {total: 0, open: 0}; s.rows[n].total++; if (open) s.rows[n].open++; });
      });
      return out;
    }
    // captive power: the records that tick checklist rows 6 and 44 (captive plants at LNG terminals) and row 39 (gas-fired data centers, US only), selected together
    var CAPTIVE_ROWS = [6, 39, 44];
    function isCaptive(o) { return (o.checks || []).some(function (n) { return CAPTIVE_ROWS.indexOf(n) >= 0; }); }
    // plants with a related data center: any record of the plant (on any of its cards) ticks row 39, the gas-fired data center row; read once per loaded dataset
    var DC_ROW = 39, dcFor = null, dcSet = {};
    function hasDataCenter(p) {
      if (dcFor !== D()) {
        dcFor = D(); dcSet = {};
        plants().forEach(function (q) {
          if (q.lines.concat(q.items).some(function (o) { return (o.checks || []).indexOf(DC_ROW) >= 0; })) dcSet[plantId(q) || q.pid] = true;
        });
      }
      return !!dcSet[plantId(p) || p.pid];
    }
    function captiveStats() {
      var s = {total: 0, open: 0};
      A.LINES.concat(A.ITEMS).forEach(function (o) {
        if (!isCaptive(o) || !A.counted(o)) return;
        s.total++;
        if (A.isOpen(o)) s.open++;
      });
      return s;
    }
    function pmCount() {
      return A.LINES.concat(A.ITEMS).filter(function (o) { return o.pm_flag; }).length + plants().filter(function (p) { return p.pm_flag; }).length;
    }
    // ---- the queue tabs: suggestions | to check | new ----
    // the new tab holds every addition card, so it matches "new (in-dev)" and "new (other)" in the status menu: plants GEM does not track yet and new units proposed at a tracked plant (Baird 2026-10-29)
    // the section a card sits under in the left list; on the new tab, whether it carries a row to add
    function sectionOf(p) { return qtabOf(p) !== "new" ? cardKind(p) : p.lines.length ? "newrows" : "newleads"; }
    // the new tab's cards keep their slots in the dataset's order, but the ones with a row to add move ahead of the ones with only leads or questions
    function newRowsFirst(cs) {
      var slots = [], cards = [];
      cs.forEach(function (p, i) { p.lines = p.lines || []; p.items = p.items || []; if (qtabOf(p) === "new") { slots.push(i); cards.push(p); } });
      var sorted = cards.filter(function (p) { return p.lines.length; }).concat(cards.filter(function (p) { return !p.lines.length; }));
      slots.forEach(function (i, n) { cs[i] = sorted[n]; });
    }
    function qtabOf(p) { return byProposal(p) && !p.statewide ? "new" : noChanges(p) ? "check" : "suggestions"; }
    function setQtab(t) {
      QTAB = t;
      try { localStorage.setItem("review-qtab", t); } catch (e) { /* ignore */ }
    }
    // the tab buttons with how many cards each would list under the current filters, and how many of them are still open
    function renderQtabs() {
      var box = $("qtabs");
      if (!box) return;
      var all = plants(), c = {suggestions: {n: 0, open: 0}, check: {n: 0, open: 0}, new: {n: 0, open: 0}};
      S.visible.forEach(function (i) {
        var p = all[i], done = p.lines.length > 0 && !p.lines.some(A.isOpen), t = c[qtabOf(p)];
        if (S.hideDone && done && i !== S.pin) return;
        t.n++;
        if (!done) t.open++;
      });
      var tip = {suggestions: "plants GEM tracks with proposed edits, questions or owners to create, then the watch list",
                 new: "plants GEM does not track yet that the batch proposes adding, and new units proposed at plants GEM already tracks",
                 check: "plants the batch proposed nothing for: look each one over, set its Last Updated and Research status in the database, then mark it checked"};
      box.innerHTML = [["suggestions", "suggestions"], ["check", "to check"], ["new", "new"]].map(function (t) {
        var k = c[t[0]];
        return '<button type="button" role="tab" data-qtab="' + t[0] + '" aria-selected="' + (QTAB === t[0]) + '"' + tipAttrs(tip[t[0]] + ". " + k.open + " of the " + k.n + " listed still open") + ">" +
          t[1] + ' <span class="n">' + k.n + "</span></button>";
      }).join("");
    }
    function onQtabClick(e) {
      var b = e.target.closest("button[data-qtab]");
      if (!b || b.getAttribute("data-qtab") === QTAB) return;
      setQtab(b.getAttribute("data-qtab"));
      var first = S.visible.filter(function (i) { return qtabOf(plants()[i]) === QTAB; })[0];
      if (first != null) A.selectPipe(first); else A.renderQueue();
      $("pipes").scrollTop = 0;
    }
    function setView(v) {
      if (v !== "plants" && v !== "checklist") return;
      VIEW = v;
      try { localStorage.setItem("review-view", v); } catch (e) { /* ignore */ }
      var pm = $("pane-mode");
      if (pm) Array.prototype.forEach.call(pm.querySelectorAll("button[data-view]"), function (b) {
        b.setAttribute("aria-selected", String(b.getAttribute("data-view") === v));
      });
      A.renderQueue();
    }
    // the left pane in checklist mode: one row per QC/Country checklist group with how much of it is still open; a click filters the plants to that group. A group with nothing open gets a check mark.
    function renderChecklist() {
      var gs = groupStats(), h = [], closeout = S.panel === "closeout", cs = captiveStats();
      if (cs.total) {
        h.push('<li data-captive="1" class="grp captive' + (FS().captive ? " sel" : "") + (!cs.open ? " done" : "") + '"' +
          tipAttrs("captive power, rows " + CAPTIVE_ROWS.join(", ") + ": captive plants at LNG terminals (rows 6 and 44) and gas-fired data centers (row 39, US only). Click to list them together") + ">" +
          '<div class="pname">' + (!cs.open ? "✓ " : "") + 'captive power</div><div class="pmeta"><span class="grow">rows ' + CAPTIVE_ROWS.join(", ") + "</span>" +
          (cs.open ? '<span class="n todo">' + cs.open + " open of " + cs.total + "</span>" : '<span class="n">' + cs.total + " &middot; done</span>") + "</div></li>");
      }
      (D().groups || []).forEach(function (g) {
        var gid = String(g.id), s = gs[gid] || {total: 0, open: 0, pm: 0, rows: {}};
        if (S.hideDone && s.total && !s.open && !g.panel && FS().group !== gid) return;
        var rows = (g.rows || []).filter(function (r) { return s.rows[r.row]; }).map(function (r) {
          var rs = s.rows[r.row];
          return '<span class="grow-row' + (rs.open ? "" : " done") + '"' + tipAttrs("checklist row " + r.row + ": " + r.label + (r.optional ? " (optional)" : "")) + ">" +
            (rs.open ? "" : "✓ ") + "row " + r.row + " <span class=\"n\">" + (rs.open ? rs.open + " open" : rs.total) + "</span></span>";
        });
        var badge = g.panel ? '<span class="n">' + (closeout ? "open" : "click to open the panel") + "</span>" :
          !s.total ? '<span class="n">nothing staged</span>' :
          s.open ? '<span class="n todo">' + s.open + " open of " + s.total + "</span>" : '<span class="n">' + s.total + " &middot; done</span>";
        h.push('<li data-g="' + esc(gid) + '" class="grp' + (FS().group === gid || (g.panel && closeout) ? " sel" : "") + (s.total && !s.open ? " done" : "") + '">' +
          '<div class="pname">' + (s.total && !s.open ? "✓ " : "") + esc((g.id === "other" ? "" : g.id + ". ") + g.label) + (s.pm ? ' <span class="pm" data-tip="' + s.pm + " flagged for the PM in this group\">PM " + s.pm + "</span>" : "") + "</div>" +
          '<div class="pmeta"><span class="grow">' + esc(g.blurb || "") + '</span>' + badge + "</div>" +
          (rows.length ? '<div class="grows">' + rows.join(" ") + "</div>" : "") + "</li>");
      });
      $("pipes").innerHTML = h.join("");
    }
    // a click on the captive power chip: filter to its rows, decided or not, and show the plants
    function selectCaptive() {
      FS().captive = !FS().captive;
      if (FS().captive) FS().decision = "";
      A.changed();
      setView("plants");
    }
    // a click on a checklist group: filter the plants to it and show them
    function selectGroup(gid) {
      var g = (D().groups || []).filter(function (x) { return String(x.id) === gid; })[0];
      if (g && g.panel) {
        // the close-out group is not a filter: it opens a panel in the card pane that gathers what the end-of-state checklist rows need (units to mark, a summary draft, the sheets to update)
        S.panel = S.panel === "closeout" ? null : "closeout";
        S.line = -1;
        A.renderQueue(); A.renderCard();
        return;
      }
      FS().group = FS().group === gid ? "" : gid;
      FS().decision = "";                 // a group lists everything in it, decided or not
      A.changed();
      setView("plants");
    }

    // ---- line pieces ----
    // a plant-wide line: the same value lands on every unit row of the plant
    function siblingRow(l) {
      var ids = l.sibling_unit_ids || [];
      if (!ids.length) return "";
      var p = plants()[l._p], sc = l.sibling_current || {};
      var txt = ids.map(function (id) {
        var u = unitOf(p, id), nm = u && u.unit_name ? u.unit_name : id;
        var v = sc[id];
        if (v && typeof v === "object") {
          var has = !blankv(v.Latitude) && !blankv(v.Longitude);
          return nm + (has ? " (now " + v.Latitude + ", " + v.Longitude + (blankv(v["Location accuracy"]) ? "" : ", " + v["Location accuracy"]) + ")" : " (blank now)");
        }
        return nm + (blankv(v) ? " (blank now)" : " (now " + v + ")");
      }).join(", ");
      return '<tr class="note"><td></td><td colspan="3"><div class="faint">the same edit lands on the other unit rows of this plant: ' + esc(txt) + "</div></td></tr>";
    }
    // ---- location block: two satellite patches (Esri World Imagery, zoom 16, a 2 by 2 grid of tiles) with a crosshair ----
    var ESRI_TILE = window.ReviewGeo.BASEMAPS.satellite.url;     // the shared basemaps and tile math (review_core/web/geo.js)
    var ESRI_ATTRIBUTION = "Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community";
    var LOC_ZOOM = 16;
    var METHOD_WORDS = {address: "placed from an address", site_reference: "placed from a site reference in a document",
                        dataset: "taken from a dataset point", map: "georeferenced from a map in a document",
                        imagery: "placed from the satellite picture of the plant"};
    var tileXY = window.ReviewGeo.tileXY;
    function locPoint(pt) { return pt && typeof pt.lat === "number" && typeof pt.lon === "number"; }
    function locPane(title, pt) {
      var h = '<div class="pane"><div class="ttl">' + esc(title) + "</div>";
      if (!locPoint(pt)) return h + '<div class="nopt">no coordinate in GEM yet</div></div>';
      var t = tileXY(pt.lat, pt.lon, LOC_ZOOM), x0 = Math.floor(t.x - 0.5), y0 = Math.floor(t.y - 0.5), imgs = "";
      for (var dy = 0; dy < 2; dy++) {
        for (var dx = 0; dx < 2; dx++) {
          var u = ESRI_TILE.replace("{z}", LOC_ZOOM).replace("{y}", y0 + dy).replace("{x}", x0 + dx);
          // tiles embedded at build time (an artifact page cannot load images from other hosts)
          if (pt.tiles && pt.tiles.uris && pt.tiles.x0 === x0 && pt.tiles.y0 === y0) u = pt.tiles.uris[dy * 2 + dx];
          imgs += '<img loading="lazy" alt="" src="' + esc(u) + '" style="left:' + (dx * 50) + "%;top:" + (dy * 50) + '%">';
        }
      }
      var cx = (t.x - x0) / 2 * 100, cy = (t.y - y0) / 2 * 100;
      h += '<div class="tiles">' + imgs + '<span class="cross h" style="left:' + cx.toFixed(2) + "%;top:" + cy.toFixed(2) + '%"></span>' +
        '<span class="cross v" style="left:' + cx.toFixed(2) + "%;top:" + cy.toFixed(2) + '%"></span></div>';
      h += '<div class="coord">' + esc(pt.lat.toFixed(5) + ", " + pt.lon.toFixed(5)) + (pt.accuracy ? " (" + esc(pt.accuracy) + ")" : "");
      if (pt.satellite) h += ' <a href="' + esc(pt.satellite) + '" target="_blank" rel="noopener">satellite</a>';
      if (pt.pin) h += ' <a href="' + esc(pt.pin) + '" target="_blank" rel="noopener">pin</a>';
      return h + "</div></div>";
    }
    function movedText(m) {
      if (m == null || m === "") return "GEM had no point";
      m = Number(m);
      return "moved " + (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");
    }
    function locationBlock(loc) {
      var cur = loc.current || {}, pro = loc.proposed || {};
      var cap = [METHOD_WORDS[loc.method] || loc.method, movedText(loc.moved_m)];
      if (cur.accuracy && pro.accuracy && cur.accuracy !== pro.accuracy) cap.push(cur.accuracy + " to " + pro.accuracy);
      else if (pro.accuracy) cap.push(pro.accuracy);
      var h = '<div class="loc"><div class="panes">' + locPane("now", cur) + locPane("proposed", pro) + "</div>" +
        '<div class="cap">' + cap.filter(Boolean).map(esc).join(", ") + "</div>" +
        '<div class="attr">' + esc(ESRI_ATTRIBUTION) + "</div>";
      // the saved map render is an artifact asset ({role, caption, asset, url, path, width, height}; review_core/assets.py), drawn by the shared image block:
      // the loopback server's /asset/ copy, the upload's url on the artifact page, or "image not uploaded" while that page has none (click opens it full size)
      var img = loc.image;
      if (typeof img === "string") img = img ? {url: img, caption: "saved map render"} : null;   // an older dataset's bare repo path
      if (img) {
        h += '<div class="mapimg">' + window.ReviewGeo.imageBlock([img]);
        var cps = loc.control_points || [];
        if (cps.length) {
          h += '<table class="cpts"><tr><th>feature</th><th>pixel</th><th>lat, lon</th></tr>' + cps.map(function (c) {
            var px = c.px || [];
            return "<tr><td>" + esc(c.feature || "") + "</td><td>" + esc(px.join(", ")) + "</td><td>" + esc(typeof c.lat === "number" && typeof c.lon === "number" ? c.lat.toFixed(5) + ", " + c.lon.toFixed(5) : "") + "</td></tr>";
          }).join("") + "</table>";
        }
        if (loc.fit_m != null) h += '<div class="attr">fit error ' + esc(loc.fit_m) + " m</div>";
        h += "</div>";
      }
      return h + "</div>";
    }
    // engine counts on a card: the total capacity, the number of engines and the capacity per engine sit together at the top of the value list
    var CAP_GROUP = ["Capacity (MW)", "Number Of Engines", "Capacity Per Engine"];
    function hasEngines(cols) { return cols.indexOf("Number Of Engines") >= 0 || cols.indexOf("Capacity Per Engine") >= 0; }
    function capFirst(cols) {
      if (!hasEngines(cols)) return cols;
      return CAP_GROUP.filter(function (c) { return cols.indexOf(c) >= 0; }).concat(cols.filter(function (c) { return CAP_GROUP.indexOf(c) < 0; }));
    }
    // an edit card's value rows in that order; when the line sets engine fields but not the total, the unit's current total shows as an unchanged row beside them
    function editValueRows(l) {
      var pv = l.proposed_values || {}, curv = l.current || {}, cols = Object.keys(pv);
      if (!cols.length || !hasEngines(cols)) return A.valueRows(l);
      if (cols.indexOf("Capacity (MW)") < 0 && !blankv(curv["Capacity (MW)"])) cols.push("Capacity (MW)");
      return capFirst(cols).map(function (c) {
        if (!(c in pv) && blankv(curv[c])) return "";
        return A.valueRow(c, curv[c], c in pv ? pv[c] : curv[c], l.reverified, l);
      }).join("");
    }
    // the data points of a new row: one row per filled field, each with a copy button (its source links go in newRowRefs at the bottom of the card)
    function newRowTable(vals) {
      vals = vals || {};
      var tr = capFirst(Object.keys(vals)).filter(function (c) { return !blankv(vals[c]); }).map(function (c) {
        return "<tr><td>" + esc(c) + "</td><td>" + esc(vals[c]) + A.copyBtn(vals[c]) + "</td></tr>";
      });
      return tr.length ? '<table class="rowdata">' + tr.join("") + "</table>" : "";
    }
    // a block's source links in one sources table right under its data points: the plant's under the plant fields, each unit's under that unit's fields
    function newRowRefs(refs, l) {
      return A.sourcesTable(Object.keys(refs || {}).map(function (c) { return [c, A.asList(refs[c])]; }), function (u) { return A.vmark(u, l); });
    }
    function newRowBody(l) {
      var units = l.units || [];
      // the title already says new unit or new plant; a new plant that brings unit rows gets one line saying one call covers them all
      var h = newUnit(l) || !units.length ? "" :
        '<div class="faint">A plant GEM does not track yet, with ' + units.length + " unit row" + (units.length === 1 ? "" : "s") + " to add under it. One call covers the plant and its units.</div>";
      h += newRowTable(l.proposed_values) + newRowRefs(l.refs_by_col, l);
      // a new plant's unit rows: each one its own small table under the plant fields, with that unit's sources right under it
      units.forEach(function (u) {
        h += '<div class="row1 newunit"><span class="col">unit ' + esc(u.unit_name || "(unnamed)") + "</span></div>" + newRowTable(u.fields) + newRowRefs(u.refs_by_col, l);
        if (u.action) h += '<div class="dtxt"><span class="k">what to change</span>' + linkText(u.action) + "</div>";
        if (u.notes) h += '<div class="dtxt"><span class="k">researcher notes</span>' + linkText(u.notes) + "</div>";
      });
      return h;
    }
    // the IRP box state of the unit a line or item sits on: "yes" / "no" / "" (unknown or no unit)
    function irpBoxOf(o) {
      var p = plants()[o._p], u = p && o.gem_unit_id ? unitOf(p, o.gem_unit_id) : null;
      return u ? (u.irp_box || "") : "";
    }
    // a finding that comes from a utility integrated resource plan (US only; checklist row 37)
    function irpChip(o) {
      var box = irpBoxOf(o);
      var tip = "this comes from a utility integrated resource plan (IRP). " +
        (o.kind === "new_row" ? "Tick the IRP box on the new row when it is created." :
         box === "yes" ? "The unit's IRP box is already ticked in the database." :
         box === "no" ? "The unit's IRP box is not ticked yet: tick it in the web form when the change goes in." :
         "The export does not show this unit's IRP box; check it in the web form.") + " QC/Country checklist row 37.";
      return chip("IRP" + (box === "no" ? ": tick the box" : ""), box === "no" ? "irp todo" : "irp", tip);
    }
    // the checklist group chip every line and item carries (not a new row: every new row is in the same group): the group's words, "status and timeline", with the rows it ticks on hover
    function groupChip(o) {
      var gid = groupOf(o), label = groupLabel(gid);
      // chips read lowercase; a label that opens with an acronym ("IDs, IRPs and data centers") keeps its case
      if (/^[A-Z][a-z]/.test(label)) label = label.charAt(0).toLowerCase() + label.slice(1);
      return chip(gid === "other" ? "no checklist row" : label, "grp", groupTip(o));
    }
    // the one chip on a new row: how many of its source links were fetched and found stating a value (url_verifier.py at staging). The marks in the row's table show each link
    function readinessChip(l) {
      var urls = A.asList(l.proposed_refs), v = l.verifications || {}, n = urls.length;
      var k = urls.filter(function (u) { return v[u] && v[u].contains_value; }).length;
      var links = n + " source link" + (n === 1 ? "" : "s");
      if (!n) return chip("no source link", "single", "this row cites no source link: read the researcher notes before accepting");
      if (!k) return chip("no source verified", "single", "none of the " + links + " on this row was checked to state its value: read the sources before accepting");
      return chip(k + " of " + n + " source" + (n === 1 ? "" : "s") + " verified", k === n ? "ready" : "single",
        (k === n ? "every source link" : k + " of the " + links) + " on this row loaded and states a value on the page. The marks in the table below show each link's checks");
    }
    function pmChip(o) { return chip("PM", "pm", "flagged for the project manager" + (o.pm_note ? ": " + o.pm_note : "")); }
    // the ask-the-PM box: a flag beside the decision, with a short note. Works on a line, an item or the whole plant.
    function pmBox(o, attr, id) {
      var dis = !A.Store.caps.decide, on = !!o.pm_flag;
      return '<label class="pmbox' + (on ? " on" : "") + '"' + tipAttrs(dis ? A.NOT_YET : "flag this for the GOGPT project manager. The flag sits beside your decision: you can accept something and still ask about it. Flagged items are listed together in the evidence file") +
        '><input type="checkbox" ' + attr + '="' + esc(id) + '"' + (on ? " checked" : "") + (dis ? " disabled" : "") + "> ask the PM</label>" +
        (on ? '<input type="text" class="pmnote" ' + attr + '-note="' + esc(id) + '" placeholder="question for the PM" value="' + esc(o.pm_note || "") + '"' + (dis ? " disabled" : "") + ">" : "");
    }

    // the plant's current unit statuses and capacity for the card header: "operating 2, retired 1" and "450 MW" (units with no capacity in the export are left out of the sum)
    function unitStatusText(p) {
      var by = {}, order = [];
      (p.units || []).forEach(function (u) { var s = statusBase(u.status); if (!s) return; if (!(s in by)) { by[s] = 0; order.push(s); } by[s]++; });
      return order.length ? esc("status: " + order.map(function (s) { return s + (p.units.length > 1 ? " " + by[s] : ""); }).join(", ")) : "";
    }
    function unitCapacityText(p) {
      var n = 0, any = false;
      (p.units || []).forEach(function (u) { var v = parseFloat(String(u.capacity || "").replace(/,/g, "")); if (isFinite(v)) { n += v; any = true; } });
      return any ? esc(String(Math.round(n * 10) / 10).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " MW") : "";
    }
    // the latest Last Updated date over the plant's units, as the export shows it (an ISO date, so the largest string is the latest)
    function lastUpdatedText(p) {
      var best = "";
      (p.units || []).forEach(function (u) { var v = String(u.last_updated || "").trim(); if (v > best) best = v; });
      return best ? esc("last updated " + best) : "";
    }
    // a plant card with no suggested changes: its one line is the "checked" line
    // a "new units at" card: its new unit rows, its leads (watch items) and its questions on whether something is new
    function addCount(p, sep, unitWord) {
      var leads = p.items.filter(function (it) { return it.kind === "monitor"; }).length, qs = p.items.length - leads;
      var parts = [];
      if (p.lines.length || (!leads && !qs)) parts.push(plural(p.lines.length, unitWord || "new unit"));
      if (leads) parts.push(plural(leads, "lead"));
      if (qs) parts.push(plural(qs, "question"));
      return parts.join(sep);
    }
    function noChanges(p) { return !!p.no_changes || (cardKind(p) === "plant" && p.lines.length > 0 && p.lines.every(function (l) { return l.kind === "checked"; })); }
    // a no-change plant whose every unit shows a Last Updated on or after the cycle start (`checked_in_db`, set by the dataset builder):
    // someone already checked it in the database this cycle, so its line is done (grayed, out of the counts) until a person calls it
    function preChecked(l) { return l.kind === "checked" && !!l.checked_in_db && !cur(l); }
    // a tracked plant counts as checked when every change on it has a call other than hold (a no-change plant: its line is marked checked, here or in the database)
    function plantChecked(p) { return p.lines.length > 0 && p.lines.every(function (l) { var d = cur(l); return preChecked(l) || (d && d !== "hold"); }); }
    function trackedPlants() { return plants().filter(function (p) { return cardKind(p) === "plant" && !p.statewide && !untracked(p); }); }
    // the body of a "checked" line: what to do, then every unit of the plant with its research bookkeeping as the export shows it
    function checkedBody(l) {
      var p = plants()[l._p], units = p.units || [];
      var n = (p.items || []).length;
      var h = '<p class="checked-say">The research batch proposed no change for this plant.' +
        (n ? " It did leave " + (n === 1 ? "a note" : n + " notes") + " below, which may need a fix by hand." : "") +
        " Look it over, set Last Updated and Research status in the database, then mark it checked here. Hold it for later if you want to come back to it.</p>";
      if (!units.length) return h + '<p class="muted">The export lists no unit for this plant.</p>';
      // the rows sit in status groups: the in-development statuses first (announced to shelved, in that order), then the rest alphabetically, each group in export order.
      // Only the units in development need their bookkeeping set; the others (operating, retired and so on) are grayed out
      var sorted = unitsByStatus(units), other = sorted.filter(function (u) { return !isDev(u.status); }).length;
      // the table sits in a box that scrolls sideways when the window is narrow, so its columns keep their widths instead of crushing into each other
      h += '<div class="units-wrap"><table class="pair units"><tr><th>unit</th><th>status</th><th>capacity (MW)</th><th>last updated</th><th>researcher</th><th>research status</th></tr>' +
        sorted.map(function (u) {
          return "<tr" + (isDev(u.status) ? "" : ' class="other"') + "><td>" + esc(unitText(u)) + "</td><td>" + esc(u.status || "") + "</td><td>" + esc(u.capacity || "") + "</td><td>" + esc(u.last_updated || "") + "</td><td>" + esc(u.researcher || "") + "</td><td>" + esc(u.research_status || "") + "</td></tr>";
        }).join("") + "</table></div>";
      if (other) h += '<p class="muted units-say">' + (other === units.length ? "No unit here is in development, so none needs its Last Updated or Research status set." : "The grayed rows are not in development (operating, retired, mothballed and so on) and do not need their Last Updated or Research status set.") + "</p>";
      return h;
    }
    // the units in status order: the five in-development statuses first, in their fixed order, then the other statuses alphabetically; within a status, as the export lists them
    function unitsByStatus(units) {
      function rank(u) { var i = DEV_STATUS.indexOf(statusKey(u.status)); return i >= 0 ? i : DEV_STATUS.length; }
      return units.map(function (u, i) { return {u: u, i: i}; }).sort(function (a, b) {
        var d = rank(a.u) - rank(b.u);
        if (!d && rank(a.u) === DEV_STATUS.length) d = statusBase(a.u.status).toLowerCase().localeCompare(statusBase(b.u.status).toLowerCase());
        return d || a.i - b.i;
      }).map(function (x) { return x.u; });
    }

    // ---- items ----
    // two agents asked the same question (the plant's own check and the statewide plan check): the assembler folded the second into this record
    function mergedChip(it) {
      return chip("two checks, one question", "", "the statewide plan check asked this at plant level too. That record (" + it.merged_from + ") was folded into this one; its finding is in the notes");
    }
    function concernHead(it) {
      var t = String(it.concern_type || "concern");
      if (CONCERN_ISSUE[t]) return CONCERN_ISSUE[t];
      // a column name: "Capacity (MW): a question about this value"
      return /^[A-Z]/.test(t) ? t + ": a question about this value" : t.replace(/_/g, " ");
    }

    // ---- ask-the-PM flag records ----
    // an ask-the-PM flag: key "pm::<line or item key>", or "pm::<dir>::plant:<pid>" for a whole plant
    function applyFlagRecord(r) {
      var key = String(r.key || "").replace(/^pm::/, ""), o = A.LINE_BY_KEY[key] || A.ITEM_BY_KEY[key];
      if (!o && r.kind === "plant") plants().forEach(function (p) { if (p.pid === r.pid && (!r.dir || p.dir === r.dir)) o = p; });
      if (!o) return;
      o.pm_flag = !!r.on && !r.undecided;
      o.pm_note = o.pm_flag ? (r.note || "") : "";
      o.pm_by = o.pm_flag ? r.reviewer : null;
    }
    // Save an ask-the-PM flag (line, item or plant). The box re-renders when the store confirms.
    function saveFlag(target, rec) {
      var Store = A.Store;
      var canFlag = Store.caps.flag !== undefined ? !!Store.caps.flag : typeof Store.flag === "function";
      if (!Store.caps.decide || !canFlag || typeof Store.flag !== "function") return A.notYet();
      var k = "pm:" + (rec.key || rec.pid);
      if (S.saving[k]) return;
      S.saving[k] = true;
      Store.flag([rec]).then(function (saved) {
        A.applySaved(saved);
        if (target && target.key) S.stay[target.key] = true;
        A.banner("");
        var keepLine = S.line;
        A.refilter(true);
        if (keepLine >= 0 && $("line-" + keepLine)) A.setLine(keepLine, true);
        A.toast(rec.on ? "flagged for the PM" : "flag removed");
      }).catch(function (e) {
        A.renderCard();
        A.toast("not saved: " + e.message);
      }).then(function () { delete S.saving[k]; });
    }
    function onPmChange(e) {
      var box = e.target.closest("input[data-pm], input[data-pm-note]"), pb = e.target.closest("input[data-pmplant], input[data-pmplant-note]");
      var t = box || pb;
      if (!t) return false;
      var isNote = t.hasAttribute("data-pm-note") || t.hasAttribute("data-pmplant-note");
      if (box) {
        var key = t.getAttribute(isNote ? "data-pm-note" : "data-pm"), o = A.LINE_BY_KEY[key] || A.ITEM_BY_KEY[key];
        if (!o) return true;
        var wrap = t.closest(".controls, .icall"), cb = wrap.querySelector("input[data-pm]"), nt = wrap.querySelector("input[data-pm-note]");
        var on = cb.checked, note = nt ? nt.value : (o.pm_note || "");
        if (isNote && on && note === (o.pm_note || "")) return true;
        saveFlag(o, {key: key, on: on, note: on ? note : ""});
        return true;
      }
      var p = plants()[S.pipe];
      if (!p) return true;
      var pw = t.closest(".pmplant"), pcb = pw.querySelector("input[data-pmplant]"), pnt = pw.querySelector("input[data-pmplant-note]");
      var pon = pcb.checked, pnote = pnt ? pnt.value : (p.pm_note || "");
      if (isNote && pon && pnote === (p.pm_note || "")) return true;
      saveFlag(null, {pid: p.pid, dir: p.dir, on: pon, note: pon ? pnote : ""});
      return true;
    }

    // ---- close-out panel (checklist group 9) ----
    // Not one plant: what the end-of-state rows of the QC/Country checklist need, computed from the decisions made so far. Nothing here is saved; it is read off the page and typed into the sheets.
    function closeoutHtml() {
      var data = D(), LINES = A.LINES, ITEMS = A.ITEMS, dstate = A.dstate;
      var links = data.links || {}, us = !!data.us, scope = data.scope || {}, where = (scope.states || []).join(", ") || scope.country || "";
      var quarter = scope.quarter || "";
      function link(key, fallback) {
        var l = links[key];
        return l && l.url ? '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + " ↗</a>" : esc(fallback || (l && l.label) || key);
      }
      function row(n) { return '<span class="rown"' + tipAttrs("QC/Country checklist row " + n + (ROW_LABEL[n] ? ": " + ROW_LABEL[n] : "")) + ">row " + n + "</span>"; }
      function plantOf(o) { return plants()[o._p]; }
      // units: every unit a staged change touches, by what its decisions add up to
      var units = {updated: [], open: [], none: []}, itemsOnly = [], seen = {};
      plants().forEach(function (p) {
        if (p.statewide || untracked(p)) return;
        // a plant with a watch card or an addition card but no edits card: items only, listed once per plant
        if (!p.lines.length && p.items.length) {
          var id = plantId(p);
          if (!BY_PLANT[id] || BY_PLANT[id].plant == null) { if (!seen[id]) { seen[id] = 1; itemsOnly.push(p); } }
          return;
        }
        p.units.forEach(function (u) {
          var ls = p.lines.filter(function (l) { return lineUnit(l) === u.gem_unit_id || (lineUnit(l) === "" && l.kind === "plant"); });
          if (!ls.length) return;
          var acc = ls.some(function (l) { return cur(l) === "accept"; });
          var open = ls.some(function (l) { var d = cur(l); return !d || d === "hold" || d === "suggest"; });
          var entry = {p: p, u: u, n: ls.length, nAcc: ls.filter(function (l) { return cur(l) === "accept"; }).length};
          (acc ? units.updated : open ? units.open : units.none).push(entry);
        });
      });
      function unitLine(e) { return esc(e.p.name) + " · " + esc(unitText(e.u)) + ' <span class="n">(' + e.nAcc + " of " + e.n + " accepted)</span>"; }
      function unitText2(e) { return e.p.name + "\t" + (e.u.unit_name || "") + "\t" + e.u.gem_unit_id; }
      function unitList(title, list, say) {
        if (!list.length) return "";
        return '<details class="colist"' + (list.length <= 12 ? " open" : "") + "><summary>" + esc(title) + ' <span class="n">(' + list.length + ")</span></summary><p class=\"muted\">" + esc(say) + "</p><ul>" +
          list.map(function (e) { return "<li>" + unitLine(e) + "</li>"; }).join("") + "</ul></details>";
      }
      function plantList(title, list, say) {
        if (!list.length) return "";
        return '<details class="colist"' + (list.length <= 12 ? " open" : "") + "><summary>" + esc(title) + ' <span class="n">(' + list.length + ")</span></summary><p class=\"muted\">" + esc(say) + "</p><ul>" +
          list.map(function (p) { return "<li>" + esc(p.name) + ' <span class="n">(' + plural(p.units.length, "unit") + (lastUpdatedText(p) ? ", " + lastUpdatedText(p) : "") + ")</span></li>"; }).join("") + "</ul></details>";
      }
      // the numbers behind the summary draft
      var c = {accept: 0, hold: 0, reject: 0, suggest: 0, undecided: 0};
      LINES.forEach(function (l) { c[dstate(l)]++; });
      var statusAcc = LINES.filter(function (l) { return l.column === "Status" && cur(l) === "accept" && l.kind !== "reverified"; });
      var newRows = LINES.filter(function (l) { return l.kind === "new_row" && cur(l) === "accept"; });
      var watchNew = ITEMS.filter(function (it) { return it.kind === "monitor" && it.monitor_kind === "new_to_tracker"; });
      var watchOld = ITEMS.filter(function (it) { return it.kind === "monitor" && it.monitor_kind !== "new_to_tracker" && !isLead(it); });
      var leads = ITEMS.filter(isLead);
      var promote = ITEMS.filter(function (it) { return it.kind === "monitor" && it.call === "add_to_database"; });
      var moreResearch = ITEMS.filter(function (it) { return it.kind === "monitor" && it.call === "research_further"; });
      var toSheet = ITEMS.filter(function (it) { return it.kind === "monitor" && it.call === "possible_updates"; });
      var held = ITEMS.filter(function (it) { return it.kind === "monitor" && it.call === "hold"; });
      var entities = ITEMS.filter(function (it) { return it.kind === "entity"; });
      var concerns = ITEMS.filter(function (it) { return it.kind === "concern" && it.call === "confirmed"; });
      var pm = pmCount();
      // records from a utility resource plan, by what the unit's IRP box needs (row 37)
      var irpRecs = LINES.concat(ITEMS).filter(function (o) { return o.irp; });
      var irpNew = irpRecs.filter(function (o) { return o.kind === "new_row"; });
      var irpTick = irpRecs.filter(function (o) { return o.kind !== "new_row" && irpBoxOf(o) === "no"; });
      var irpDone = irpRecs.filter(function (o) { return o.kind !== "new_row" && irpBoxOf(o) === "yes"; });
      var irpUnknown = irpRecs.filter(function (o) { return o.kind !== "new_row" && !irpBoxOf(o); });
      var nPlants = A.uniq(plants().filter(function (p) { return !p.statewide && !untracked(p); }).map(plantId)).length;
      var tracked = trackedPlants(), noChange = tracked.filter(noChanges), checkedPlants = tracked.filter(plantChecked);
      var ncChecked = noChange.filter(plantChecked), ncOpen = noChange.filter(function (p) { return !plantChecked(p); });
      var sentences = [];
      sentences.push((quarter ? quarter.toUpperCase() + " " : "") + "GOGPT review of " + (where || "this scope") + ": " + plural(nPlants, "tracked plant") + " on the page, " + checkedPlants.length + " checked" +
        (noChange.length ? "; " + noChange.length + " had no suggested change, " + ncChecked.length + " of them marked checked" : "") + ".");
      sentences.push(plural(c.accept, "change") + " accepted, " + c.reject + " rejected, " + c.hold + " held, " + c.suggest + " sent back with a suggestion" + (c.undecided ? ", " + c.undecided + " not decided yet" : "") + ".");
      if (statusAcc.length) sentences.push("Status changes: " + statusAcc.map(function (l) {
        var p = plantOf(l), v = l.proposed_values && l.proposed_values.Status, from = l.current && l.current.Status;
        return p.name + (l.unit_name ? " " + l.unit_name : "") + (from ? " from " + from : "") + " to " + (v || "?");
      }).join("; ") + ".");
      if (newRows.length) sentences.push(plural(newRows.length, "new row") + " accepted for the database.");
      if (leads.length) sentences.push(plural(leads.length, "lead") + " on new units or plants not ready to add" + (moreResearch.length ? "; " + moreResearch.length + " sent back for more research" : "") + ".");
      if (us && irpRecs.length) sentences.push(plural(irpRecs.length, "finding") + " from utility resource plans" + (irpTick.length ? "; IRP box to tick on " + plural(irpTick.length, "unit") : "") + ".");
      if (watchNew.length || watchOld.length) sentences.push("Watch list: " + watchNew.length + " new to the tracker and " + watchOld.length + " on existing plants" +
        (promote.length ? "; " + promote.length + " to be added to the database" : "") + (toSheet.length ? "; " + toSheet.length + " sent to the possible-updates sheet" : "") + ".");
      if (entities.length) sentences.push(entities.length + " new owner" + (entities.length === 1 ? "" : "s") + " or operator" + (entities.length === 1 ? "" : "s") + " to create in the database.");
      if (concerns.length) sentences.push(plural(concerns.length, "open question") + " about existing data confirmed for follow-up.");
      if (pm) sentences.push(plural(pm, "question") + " for the project manager.");
      sentences.push("Researched with an AI agent (Claude); every change was checked by a person on the review page before it went into the actions workbook.");
      var draft = sentences.join(" ");
      var unitText3 = ["mark updated"].concat(units.updated.map(unitText2)).concat(["", "mark no changes"]).concat(units.none.map(unitText2)).join("\n");

      var h = '<div class="closeout">';
      h += '<div class="cohead"><h2>Close-out' + (where ? ": " + esc(where) : "") + "</h2>" +
        '<p class="muted">The end-of-state rows of the QC/Country checklist. Not one plant: this panel adds up the calls made so far so the sheet and doc updates can be typed from it. ' +
        "Nothing on it is saved; make the calls on the plants, then come back here. " + link("checklist", "QC/Country checklist tab") + "</p></div>";

      h += "<section><h3>Research status per unit " + row(53) + "</h3>" +
        '<p>In the database, every unit the state sweep touched is set to "updated" or "no changes". The lists below come from the decisions on this page. Units the sweep did not touch are not listed; their status is yours to set.</p>' +
        unitList("mark updated", units.updated, "at least one change on the unit was accepted") +
        unitList("still open: decide before marking", units.open, "the unit has changes that are undecided, held, or sent back with a suggestion") +
        unitList("mark no changes", units.none, "every change on the unit was rejected: the current values stand") +
        plantList("no suggested changes, marked checked", ncChecked, "the batch proposed nothing for these plants and they were marked checked on this page: their Last Updated and Research status were set in the database by hand") +
        plantList("no suggested changes, not checked yet", ncOpen, "the batch proposed nothing for these plants and nobody has marked them checked yet (or they are held for later)") +
        (itemsOnly.length ? '<details class="colist"><summary>plants with items only <span class="n">(' + itemsOnly.length + ")</span></summary><p class=\"muted\">no cell changes were staged, only questions or watch items; the research status is your call</p><ul>" +
          itemsOnly.map(function (p) { return "<li>" + esc(p.name) + ' <span class="n">(' + plural(p.items.length, "item") + ")</span></li>"; }).join("") + "</ul></details>" : "") +
        (units.updated.length || units.none.length ? '<p><button type="button" class="ghost" data-copy="units">copy the unit lists</button> <span class="muted">(plant, unit, GEM unit id; one per line)</span></p>' : "") +
        "</section>";

      h += "<section><h3>" + (us ? "United States research row for the state " + row(35) + " " + row(29) : "Country tips and trends row " + row(29)) + "</h3>" +
        "<p>A draft for the state's row, from the counts on this page. Edit it before pasting. " + link(us ? "us_research" : "country_tips", us ? "United States research tab" : "Country tips trends tab") + "</p>" +
        '<blockquote class="draft">' + esc(draft) + "</blockquote>" +
        '<p><button type="button" class="ghost" data-copy="draft">copy the draft</button></p></section>';

      h += "<section><h3>Assignments tab, columns M and N " + row(30) + "</h3>" +
        '<p>On the ' + link("assignments", "Researcher Country Assignments tab") + ' the state\'s row has two columns the researcher fills: M is the best estimate in days for the next update, N is the status for this cycle (to do, in progress, done). ' +
        'Set N to done only after the units above are marked and the validation report comes back clean.</p></section>';

      h += "<section><h3>Sheets and docs to review and update " + row(31) + " " + row(32) + " " + (us ? row(34) + " " + row(36) : row(33)) + "</h3><ul>" +
        "<li>" + link("possible_updates", "GEM trackers possible updates sheet") + ": " + (toSheet.length ? plural(toSheet.length, "watch item") + " on this page " + (toSheet.length === 1 ? "was" : "were") + " sent there; the actions workbook has them on a sheet in the possible-updates column order, ready to paste." : "no watch item on this page was sent there.") +
        " Rows for this state already on the sheet are marked done or moved to the next cycle.</li>" +
        "<li>" + link("data_sources", "Gas and oil power plant data sources by country doc") + ": add any source the sweep used that the doc does not list yet (the evidence file names every source).</li>" +
        (us ? "<li>" + link("us_irps", "US IRPs tab") + ": the state's utility resource plans. " + (irpRecs.length ? plural(irpRecs.length, "record") + " on this page " + (irpRecs.length === 1 ? "comes" : "come") + " from a plan (the IRP chip); the actions workbook's irp_notes_draft sheet has a draft line per utility for the tab's Notes column." : "No record on this page comes from a plan. If the IRP step did not run for this state, read the state's rows by hand.") + "</li>" +
              "<li>" + link("us_guide", "GOGPT United States Data/Research Guide") + ": the state's section, if the sweep found a better source or a way in.</li>"
            : "<li>" + link("europe_doc", "Europe Workflow Map doc") + " (Europe only): the country's section.</li>") +
        "</ul></section>";

      if (us) {
        h += "<section><h3>IRP box " + row(37) + "</h3>" +
          "<p>The database has an IRP checkbox on every unit (the export's IRP column). A unit whose data comes from a utility integrated resource plan gets the box ticked. " +
          "The lists below pair the records on this page that come from a plan (the IRP chip) with the box as the export shows it.</p>" +
          (irpTick.length ? '<details class="colist" open><summary>tick the IRP box <span class="n">(' + irpTick.length + ")</span></summary><p class=\"muted\">a change from a plan sits on a unit whose box is not ticked yet; tick it in the web form when the change goes in</p><ul>" +
            irpTick.map(function (o) { return "<li>" + esc(plantOf(o).name) + " · " + esc(unitText(unitOf(plantOf(o), o.gem_unit_id), o.gem_unit_id)) + "</li>"; }).join("") + "</ul></details>" : "") +
          (irpNew.length ? '<details class="colist" open><summary>new rows from a plan <span class="n">(' + irpNew.length + ")</span></summary><p class=\"muted\">tick the IRP box on the new row when it is created</p><ul>" +
            irpNew.map(function (o) { return "<li>" + esc(plantOf(o).name) + (o.unit_name ? " · " + esc(o.unit_name) : "") + "</li>"; }).join("") + "</ul></details>" : "") +
          (irpDone.length ? '<details class="colist"><summary>already ticked <span class="n">(' + irpDone.length + ")</span></summary><p class=\"muted\">the box is ticked in the export; nothing to do</p><ul>" +
            irpDone.map(function (o) { return "<li>" + esc(plantOf(o).name) + " · " + esc(unitText(unitOf(plantOf(o), o.gem_unit_id), o.gem_unit_id)) + "</li>"; }).join("") + "</ul></details>" : "") +
          (irpUnknown.length ? '<details class="colist"><summary>check the box by hand <span class="n">(' + irpUnknown.length + ")</span></summary><p class=\"muted\">the record comes from a plan but names no unit the export shows; open the plant in the web form</p><ul>" +
            irpUnknown.map(function (o) { return "<li>" + esc(plantOf(o).name) + (o.unit_name ? " · " + esc(o.unit_name) : "") + "</li>"; }).join("") + "</ul></details>" : "") +
          (!irpRecs.length ? '<p class="muted">No record on this page comes from a plan. Units already ticked keep their box; the actions workbook\'s irp_box sheet lists them when the IRP step ran.</p>' : "") +
          "</section>";
      }

      h += "<section><h3>What this page cannot see " + row(52) + " " + row(54) + " " + row(56) + "</h3><ul>" +
        "<li><b>AI used</b> (row 52): yes. This batch was researched with Claude and reviewed here.</li>" +
        "<li><b>Validation report</b> (row 54): Baird runs the database's validation report for the state at close-out; it has to come back clean before the row is marked done.</li>" +
        '<li><b>No tracker found</b> (row 56): the combustion tracker search in the GEM database has a "no tracker found" filter. Baird runs that check from the database side; the page cannot.</li>' +
        "</ul></section>";

      if (held.length) h += "<section><h3>Watch items held, with notes</h3><p>Still on the watch list after this review. They come back on the next rebuild.</p><ul>" +
        held.map(function (it) { return "<li>" + esc(plantOf(it).name) + ": " + esc(A.itemHead(it)) + (it.call_note ? ' <span class="muted">' + esc(it.call_note) + "</span>" : "") + "</li>"; }).join("") + "</ul></section>";
      if (pm) h += "<section><h3>Questions for the project manager</h3><p>" + plural(pm, "question") + ' flagged on this page. <a href="#/?pm=1">show them</a>. The evidence file gathers them in one place.</p></section>';
      h += "</div>";
      closeoutCopy = {units: unitText3, draft: draft};
      return h;
    }

    // ---- the "how to" page ----
    // ---- copy for Chrome: one plant's accepted edits as a message for Claude in Chrome ----
    // The message is pasted into the Claude in Chrome side panel on the GEM web form. It carries only this plant's specifics: the accepted edits of this card (hold, reject,
    // suggest and undecided changes are listed as off limits), who is applying them and the date, and the record ids for the read-back. How to fill in the form (the rules,
    // the order of work, where each field is, the timelines, Datasource boxes, unit names, Research status, the checks and the read-back format) lives on one public page,
    // gogpt-researcher docs/chrome_apply_instructions.md, which the message tells the session to read first. The section numbers below point into that page.
    var INSTRUCTIONS_URL = "https://raw.githubusercontent.com/bairdlangenbrunner/gogpt-researcher/main/docs/chrome_apply_instructions.md";
    var DB_BASE = "https://gem-project-db.herokuapp.com";
    var ADDITIVE = {"Status Detail": true, "Notes": true};           // running logs: the new entry goes on top of the text already there (schema_constants.ADDITIVE_TEXT_COLUMNS)
    var ENTITY_EXISTS = /existing|found|no new entity/i;             // the lookup wording that means the entity is already in GEM (browser_apply.py ENTITY_EXISTS)
    // the order of work (instructions section 4): the web form needs the country and the coordinates before the rest, and ownership goes last
    var LOCATION_COLS = ["Country/Area", "Latitude", "Longitude"];
    var OWNERSHIP = /^(Owner|Operator|Parent)/i;
    function colRank(c) { var i = LOCATION_COLS.indexOf(c); return i >= 0 ? i : OWNERSHIP.test(c) ? LOCATION_COLS.length + 1 : LOCATION_COLS.length; }
    function stableBy(xs, rank) {
      return xs.map(function (x, i) { return [rank(x), i, x]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }).map(function (x) { return x[2]; });
    }
    function colsInOrder(cols) { return stableBy(cols, colRank); }
    function linesInOrder(ls) { return stableBy(ls, function (l) { return Math.min.apply(null, (l.columns || [l.column]).map(colRank)); }); }
    // the Research status each unit gets (instructions section 9; gogpt-researcher docs/reference/lifecycle_rules.md):
    // "updated" on an existing unit an accepted edit touches, "added" on every new unit
    function researchStatusText(p, edits, rows) {
      var names = {}, seen = {}, upd = [];
      (p.units || []).forEach(function (u) { names[u.gem_unit_id] = u.unit_name; });
      edits.forEach(function (l) {
        [l.gem_unit_id].concat(l.sibling_unit_ids || []).filter(Boolean).forEach(function (id) {
          if (seen[id]) return;
          seen[id] = true;
          upd.push(names[id] ? names[id] + " (" + id + ")" : id);
        });
      });
      var add = [];
      rows.forEach(function (l) {
        if (newUnit(l)) add.push(l.unit_name || "the new unit");
        else (l.units || []).forEach(function (u, i) { add.push(u.unit_name || "unit " + (i + 1)); });
      });
      if (!upd.length && !add.length) return "";
      var out = "RESEARCH STATUS (instructions section 9)\n";
      if (upd.length) out += "updated on " + (upd.length === 1 ? "unit " : "units ") + upd.join(", ") + "\n";
      if (add.length) out += "added on the new " + (add.length === 1 ? "unit " : "units ") + add.join(", ") + "\n";
      return out + "\n";
    }
    function todayIso() { var d = new Date(); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
    function dbEditUrl(p) {
      var m = !p.statewide && !untracked(p) && /^[A-Za-z]?(\d+)$/.exec(plantId(p));
      return m ? DB_BASE + "/projects/edit/" + m[1] : "";
    }
    function val(v) { return blankv(v) ? "(empty)" : String(v); }
    function firstPara(s) { return String(s || "").split(/\n\s*\n/)[0].trim(); }
    // a value with line breaks goes between marker lines, so nothing is typed with the message's indentation (instructions section 8)
    function block(label, text) {
      text = String(text || "");
      if (text.indexOf("\n") < 0) return "   " + label + ": " + text + "\n";
      return "   " + label + ":\n---- begin ----\n" + text + "\n---- end ----\n";
    }
    function lineWhere(p, l) {
      if (l.kind === "plant" || (l.sibling_unit_ids || []).length) {
        var ids = [l.gem_unit_id].concat(l.sibling_unit_ids || []).filter(Boolean);
        return "All " + plural(ids.length, "unit") + " of the plant (" + ids.join(", ") + "), the same value on each";
      }
      return "Unit " + (l.unit_name ? l.unit_name + " (" + l.gem_unit_id + ")" : l.gem_unit_id);
    }
    function nowOf(p, l, c) {
      var now = val((l.current || {})[c]), sc = l.sibling_current || {}, ids = Object.keys(sc);
      if (!ids.length || ids.every(function (id) { return val(sc[id]) === now; })) return now;
      return now + " on " + l.gem_unit_id + "; " + ids.map(function (id) { return val(sc[id]) + " on " + id; }).join("; ");
    }
    function editText(p, l, n) {
      var cols = colsInOrder(l.columns || [l.column]);
      var out = n + ". " + lineWhere(p, l) + ": " + cols.join(", ") + "\n";
      cols.forEach(function (c) {
        var want = (l.proposed_values || {})[c], now = (l.current || {})[c];
        if (cols.length > 1) out += "   " + c + ":\n";
        if (ADDITIVE[c]) {
          var entry = String(want || ""), old = String(now || "").trim();
          if (old && entry.trim().slice(-old.length) === old) entry = entry.trim().slice(0, -old.length).trim();
          out += "   Now: " + (old ? "the box starts with \"" + old.slice(0, 90).replace(/\s+/g, " ") + (old.length > 90 ? "..." : "") + "\"" : "(empty)") + "\n";
          out += block("New entry for the top of the box", entry);
          return;
        }
        out += block("Now", nowOf(p, l, c));
        if (l.reverified) out += block("Leave as", val(want));
        else if (blankv(want)) out += "   Set to: (empty)\n";
        else out += block("Set to", val(want));
      });
      if (l.ref_col && !ADDITIVE[l.ref_col]) {
        var have = l.current_ref || [], add = (l.proposed_refs || []).filter(function (u) { return have.indexOf(u) < 0; });
        if (add.length) out += "   Add to the " + l.ref_col + " box:\n" + add.map(function (u) { return "     " + u; }).join("\n") + "\n";
        else if ((l.proposed_refs || []).length) out += "   " + l.ref_col + ": the link is already in the box. Add nothing there.\n";
      }
      if (l.irp && irpBoxOf(l) !== "yes") out += "   Also tick the IRP box on this unit.\n";
      var why = firstPara(l.action);
      if (why) out += "   The researcher wrote: " + why + "\n";
      out += "   Record id: " + l.record_id + "\n";
      return out;
    }
    // keep: "rest" leaves out the ownership fields and their Data Source boxes, "own" keeps only those, anything else keeps all
    function fieldsText(fields, refs, indent, keep) {
      function kept(c) { return keep === "own" ? OWNERSHIP.test(c) : keep === "rest" ? !OWNERSHIP.test(c) : true; }
      var out = "";
      colsInOrder(Object.keys(fields || {})).forEach(function (c) {
        if (!kept(c) || blankv(fields[c])) return;
        out += indent + c + ": " + String(fields[c]).replace(/\s*\n\s*/g, " / ") + "\n";
      });
      var rc = colsInOrder(Object.keys(refs || {})).filter(function (c) { return kept(c) && (refs[c] || []).length; });
      if (rc.length) {
        out += indent + "Links to add:\n";
        rc.forEach(function (c) { out += indent + "  " + c + ": " + refs[c].join("  ") + "\n"; });
      }
      return out;
    }
    function newRowText(p, l, n) {
      var out;
      if (newUnit(l)) {
        out = n + ". Add a new unit at this plant" + (l.unit_name ? ", named " + l.unit_name : "") + ", with these fields:\n" + fieldsText(l.proposed_values, l.refs_by_col, "     ");
      } else {
        out = n + ". Fill in the plant fields of " + (l.plant_name || p.name) + (p.state ? " in " + p.state : "") + (p.country ? ", " + p.country : "") +
          ". The project already exists, so set these fields on it and leave any field already filled in that matches:\n" + fieldsText(l.proposed_values, l.refs_by_col, "     ", "rest");
        (l.units || []).forEach(function (u, i) {
          out += "   Then add unit " + (i + 1) + (u.unit_name ? ", named " + u.unit_name : "") + ":\n" + fieldsText(u.fields, u.refs_by_col, "     ");
        });
        var own = fieldsText(l.proposed_values, l.refs_by_col, "     ", "own");
        if (own) out += "   Last, after the units, set the ownership fields of the plant:\n" + own;
      }
      if (l.irp) out += "   Also tick the IRP box" + (newUnit(l) ? " on the new unit" : " on each new unit") + ".\n";
      var why = firstPara(l.action);
      if (why) out += "   The researcher wrote: " + why + "\n";
      out += "   Record id: " + l.record_id + "\n";
      return out;
    }
    function decisionWord(l) { var d = cur(l); return d === "hold" ? "held" : d === "reject" ? "rejected" : d === "suggest" ? "a different value was suggested" : "not decided yet"; }
    // the entity items of the plant whose lookup found nothing in GEM: someone creates those by hand, the browser session never does
    function missingEntities(p) {
      var seen = {}, out = [], id = plantId(p), cardsOf = (id && BY_PLANT[id]) || {};
      [p].concat(Object.keys(cardsOf).map(function (k) { return plants()[cardsOf[k]]; })).forEach(function (c) {
        ((c && c.items) || []).forEach(function (it) {
          if (it.kind !== "entity" || seen[it.record_id] || ENTITY_EXISTS.test(String(it.lookup_result || ""))) return;
          seen[it.record_id] = true;
          out.push((it.entity_name || "an entity") + (it.role ? " (" + it.role + ")" : ""));
        });
      });
      return out;
    }
    // the person applying the edits is the page's reviewer (artifacts.json "reviewer", carried in full as reviewer_name; "reviewer" there is initials); a page without one is Baird's (Baird 2026-11-05)
    function applier() { var r = window.REVIEW_STATIC && window.REVIEW_STATIC.reviewer_name; return (r && String(r).trim()) || "Baird Langenbrunner"; }
    // the message, or "" when nothing on the card can be copied
    // Accepted lines when there are any. With none accepted yet (the button works on any card), every proposed line that is not rejected, so the message can be copied before the calls are made.
    function chromeText(p) {
      var acc = p.lines.filter(function (l) { return l.kind !== "checked" && cur(l) === "accept"; }), unreviewed = false;
      if (!acc.length) {
        acc = p.lines.filter(function (l) { return l.kind !== "checked" && cur(l) !== "reject"; });
        unreviewed = true;
      }
      if (!acc.length) return "";
      var edits = linesInOrder(acc.filter(function (l) { return l.kind !== "new_row"; })), rows = acc.filter(function (l) { return l.kind === "new_row"; });
      var others = p.lines.filter(function (l) { return l.kind !== "checked" && acc.indexOf(l) < 0; });
      var url = dbEditUrl(p), id = plantId(p), where = [p.state, p.country].filter(Boolean).join(", ");
      var out = "You are helping " + applier().split(" ")[0] + " apply reviewed edits to one plant in the GEM project database web form.\n" +
        "Before you touch the form, open this page and read all of it: " + INSTRUCTIONS_URL + "\n" +
        "That page says how to fill in the form. This message says what to change. If you cannot open the page, stop and tell me.\n\n";
      out += "APPLIER: " + applier() + "\nDATE: " + todayIso() + "\n" + (p.country ? "COUNTRY: " + p.country + "\n" : "");
      if (untracked(p)) {
        out += "PLANT: " + p.name + " (new to GEM" + (where ? "; " + where : "") + ")\n";
        out += "I have already created this project in the web form and have its edit page open in this tab. Do not create another one.\n\n";
      } else {
        out += "PLANT: " + p.name + " (GEM plant id " + id + (where ? "; " + where : "") + ")\n";
        out += (url ? "Open: " + url + "\n" : "") + "\n";
      }
      if (unreviewed) out += "NOTE: nothing on this card has been accepted yet. These are the proposed changes that were not rejected, copied before the calls were made.\n\n";
      var n = 0;
      if (edits.length) {
        out += "EDITS (" + edits.length + "), already in the order of work\n\n";
        edits.forEach(function (l) { out += editText(p, l, ++n) + "\n"; });
      }
      if (rows.length) {
        out += (newUnit(rows[0]) ? "NEW UNITS" : "NEW PLANT") + " (" + rows.length + ")\n\n";
        rows.forEach(function (l) { out += newRowText(p, l, ++n) + "\n"; });
      }
      out += researchStatusText(p, edits, rows);
      if (others.length) {
        out += "NOT INCLUDED: leave these alone, they were not accepted: " +
          others.map(function (l) { return (l.kind === "new_row" ? "the new row " + (l.unit_name || l.plant_name || "") : lineWhere(p, l).replace(/^All /, "all ") + " " + (l.columns || [l.column]).join(", ")) + " (" + decisionWord(l) + ")"; }).join("; ") + ".\n\n";
      }
      var ents = missingEntities(p);
      if (ents.length) out += "ENTITIES: " + ents.join("; ") + (ents.length > 1 ? " are" : " is") + " not in GEM's entity list yet.\n\n";
      out += "WHEN DONE\nReload the page and reply with the read-back in section 11 of the instructions page, one JSON object per record id.\n";
      return out;
    }
    function chromeButton(p) {
      var k = cardKind(p);
      if (p.statewide || k === "watch" || noChanges(p)) return "";
      var n = p.lines.filter(function (l) { return l.kind !== "checked" && cur(l) === "accept"; }).length;
      return '<button type="button" class="bulk chrome" data-chrome="1"' +
        tipAttrs(n ? "copy this plant's " + plural(n, "accepted change") + " as a message to paste into Claude in Chrome on the GEM web form, with a link to the instructions page it follows" :
                     "nothing here is accepted yet: this copies every proposed change that is not rejected for Claude in Chrome") + ">&#10697; copy for Chrome</button>";
    }

    function info(savedWhere) {
      return "<h3>how this works</h3>" +
        "<p>This page shows the <b>edits a research batch proposes</b> for the Global Oil and Gas Plant Tracker. " +
        "Nothing here is in the GEM database yet, and nothing on this page can write to it. Your job is to say yes or no to each edit.</p>" +
        "<h4>what you see</h4>" +
        "<ul>" +
        "<li><b>Left list:</b> every plant in this scope, on three tabs. <b>Suggestions</b> holds the batch's changes to plants GEM tracks, in two sections. <b>Plants</b>: one card per tracked plant the batch proposes changes for, with its questions and owners to create. " +
        "<b>Watch list</b>: one card per tracked plant with something to keep an eye on. " +
        "<b>To check</b> holds the plants the batch proposed nothing for. Each shows one line, <b>no suggested changes</b>: look the plant over, set its Last Updated and Research status in the database, then mark it <b>checked</b> (or <b>hold for later</b>). That is how the page can say every plant was looked at. A plant whose every unit already shows a Last Updated from this cycle loads grayed out as already checked in the database, so hide done drops it. <b>New</b> holds everything the batch proposes adding: one card per plant GEM does not track yet, and one \"new units at\" card per tracked plant with new unit rows, leads, or questions on whether something is new to the tracker (a possible duplicate, whether a unit exists, whether it passes the size threshold). It lists them in two sections split by a line: <b>new rows to add</b> first, the major decisions, where the batch wrote the row for a new plant or new units; then <b>leads and questions</b>, the cards with only leads, watch items or questions and no row yet. " +
        "A plant can have a card in each section; the cards link to each other. Click a card to open it.</li>" +
        "<li><b>Card:</b> a plant's proposed changes, one per cell, grouped by unit. Each change shows the cell as it is <b>now</b> and the <b>proposed</b> value, " +
        "plus the source links that back it. A new link is <b>added next to</b> the links already in the Data Source cell. It never replaces one. " +
        "An addition or watch card has no tabs: its rows and items are all on one page.</li>" +
        "<li><b>Status filter:</b> the page opens on the plants <b>in development</b> (announced, pre-construction, construction, shelved and shelved-inferred) plus the plants new to the database, because the update is about them. " +
        "Operating, retired, cancelled and the other statuses are off until you tick them under <b>other statuses</b> in the status menu; an <b>active filters</b> button in the filter bar shows when one is on; click it to see the filters and clear one.</li>" +
        "<li><b>Major / minor:</b> a <b>major change</b> moves a value: it fills a blank, changes or clears a value, sets a plant-wide field, or adds a row. " +
        "A <b>minor change</b> means the value stands and only a source link is added (the value was checked again, or the cell already has a link), or the edit is to Status Detail. " +
        "The card opens on the major changes tab. The <b>+</b> next to it opens the <b>minor changes</b>, <b>items</b> and <b>everything</b> tabs, after a reminder that they are not an expected part of the regular update (<b>Show anyway</b> opens them, <b>OK, I understand</b> leaves them folded), and the <b>&minus;</b> folds them away again. A minor change carries a <b>minor</b> chip; major changes, the common case, carry none. A minor change loads as <b>held</b> and grayed out until you accept or reject it.</li>" +
        "<li><b>Color:</b> green means one fully checked source (a status change needs two independent publishers), yellow means one source or a partial match, and red means weak. " +
        "<b>unrated</b> means no rating. Green changes default to accept; the rest default to hold.</li>" +
        "<li><b>Plant-wide:</b> a plant-level field such as the location or the owner is repeated on every unit row, so one accept covers all of them.</li>" +
        "<li><b>Copy for Chrome:</b> the button at the top right of a card copies the plant's <b>accepted</b> changes as one message: the plant's database page to open, each change with its current and new value and the links to add, the changes to leave alone, and a link to the public instructions page that says how to fill in the form. " +
        "Paste it into the Claude in Chrome side panel on the GEM web form. The extension must be allowed to open raw.githubusercontent.com to read the instructions. The page itself never writes to the database. Accept the changes first: the button is gray until one is accepted.</li>" +
        "<li><b>Items</b> tab: questions the researcher raised, plants and projects to watch, and owners or operators to create. They take a call and a note, but they never change a cell.</li>" +
        "<li><b>Checklist:</b> every change and item is sorted into one of the groups of the GOGPT QC/Country checklist (the dashed chip with the group's name, such as \"status and timeline\"; hover it for the rows it ticks). " +
        "The <b>checklist</b> menu under <b>more filters</b> shows one group at a time, decided or not.</li>" +
        "<li><b>Validation report:</b> a gray box headed <b>The database's validation report says</b> means the change answers an error on GEM's validation report. A <b>validation fix</b> chip means it carries a value and a source: accept it and the value is typed into the web form.</li>" +
        "<li><b>Filters:</b> the <b>country</b>, <b>state</b> and <b>status</b> menus, decision and search sit in the bar at the top. <b>ask the PM</b> shows only what was flagged for the PM, and <b>data centers only</b> keeps the plants tied to a gas-fired data center. " +
        "<b>more filters</b> holds kind, checklist, attribute, batch, confidence and decided by, and <b>reset</b> clears them all. <b>hide done</b> drops the plants with nothing left to decide.</li>" +
        "</ul>" +
        "<h4>your four calls</h4>" +
        "<ul>" +
        "<li><b>accept:</b> yes, this edit goes into the actions workbook.</li>" +
        "<li><b>hold:</b> not sure yet, leave it open.</li>" +
        "<li><b>reject:</b> no, do not apply this.</li>" +
        "<li><b>suggest:</b> something else is right, so type the value or a note, and the source link if you have one. The researcher looks at it again; it does not go into the workbook as is.</li>" +
        "</ul>" +
        "<p><b>A plant with no suggested changes</b> takes two calls instead: <b>checked</b> (you looked at it and set its Last Updated and Research status in the database) and <b>hold for later</b>.</p>" +
        "<p><b>Ask the PM:</b> a checkbox beside every change, every item and at the top of every plant. It sits beside your decision, so you can accept something and still flag it. " +
        "Write the question in the box that appears. The evidence file gathers the questions in one place.</p>" +
        "<h4>the five kinds of item</h4>" +
        "<ul>" +
        "<li><b>Question about existing data:</b> the researcher doubts something already in GEM: a value that could not be checked, two sources that disagree, a possible duplicate. " +
        "Calls: <b>confirmed</b> (the question stands and goes into the evidence file), <b>dismissed</b> (closed), <b>needs research</b> (back to the researcher).</li>" +
        "<li><b>Watch item, new to the tracker:</b> a plant or project GEM does not track at all yet. It did not clear the bar for a new row (too early, too small, or thin on evidence), so it is on a watchlist instead. It sits under proposed additions.</li>" +
        "<li><b>New unit lead</b> or <b>new plant lead:</b> the researcher found signs of a new unit or plant but not enough to write the row. It sits under proposed additions with a \"lead\" chip, beside the rows that are ready.</li>" +
        "<li><b>Watch item, existing plant:</b> something to keep an eye on at a plant GEM already tracks: a permit in progress, an expansion, a retirement date to confirm. The plant's row is not changed by the item. It sits under the watch list.</li>" +
        "<li><b>New owner or operator to create:</b> a company that is not in GEM's entity list. Someone creates it in the GEM web form before the ownership edit can land.</li>" +
        "</ul>" +
        "<p><b>A new row</b> is titled <b>New unit</b> (a unit row under a plant GEM already tracks; the right-hand side names the plant) or <b>New plant</b> (with its unit rows under it; one call covers them all). " +
        "It carries one chip: <b>2 of 2 sources verified</b> means every source link on it was fetched and states a value on the page; <b>no source verified</b> means none was, so read the sources before accepting. " +
        "A new row has no confidence, severity or checklist chip, because all three read the same on every new row.</p>" +
        "<p><b>IRP chip</b> (United States only): the finding comes from a utility integrated resource plan. The chip says whether the unit's IRP box in the database is already ticked; \"IRP: tick the box\" means it is not. The close-out panel lists them under row 37.</p>" +
        "<p><b>Watch items and leads take their own calls</b> instead of accept and reject: <b>incorporate into database</b> (it belongs in GEM now; the researcher writes it up as a full edit for the next batch), " +
        "<b>hold</b> (keep watching), <b>send to possible updates</b> (park it on the possible-updates sheet for a later cycle), and <b>remove from watchlist</b> (drop it, with a note saying why). " +
        "A lead has one more: <b>research further</b> (it goes on the next batch's briefs for a closer look before anyone adds it). " +
        "A candidate staged in two batches shows an \"also staged in\" chip: decide it once and give the copy the same call.</p>" +
        "<h4>what happens when you accept</h4>" +
        "<ol>" +
        "<li>Your click is saved at once in the decision log" + savedWhere + ". The GEM database is <b>not</b> touched.</li>" +
        "<li>When the batch is built, every accepted change goes into the <b>actions workbook</b> and the evidence file. Held, rejected and suggested changes are listed there as left out.</li>" +
        "<li>Someone then applies the workbook by hand, cell by cell, in the GEM web form.</li>" +
        "</ol>" +
        "<h4>good to know</h4>" +
        "<ul>" +
        "<li><b>Undo:</b> click the pressed button again, or press <kbd>u</kbd>. Nothing is deleted; the log just records the undo. Unticking <b>ask the PM</b> works the same way.</li>" +
        "<li>A grayed change is already decided or held. A bright change still needs you.</li>" +
        "<li><b>theme</b> and the half-circle button change the page's colors.</li>" +
        "<li>Press <kbd>?</kbd> for the keyboard shortcuts.</li>" +
        "</ul>";
    }

    // the error text the database's validation report gave for a line or an item answering it
    function verrBox(o) {
      var errs = o.validation_errors || [];
      if (!errs.length) return "";
      return '<div class="verr"><span class="verr-h">The database\'s validation report says</span>' + errs.map(function (e) { return "<div>" + esc(e) + "</div>"; }).join("") + "</div>";
    }

    return {
      name: "gogpt",
      cards_key: "plants",
      words: {card: "plant", cards: "plants", line: "change", lines: "changes"},
      searchPlaceholder: "plant name / GEM id / unit",
      pidTip: "click to copy the GEM plant id",
      references: true,
      // the vocabularies: the built page's tracker block (TrackerConfig.page_block) wins for calls and note rules, so the watch-item calls stay in step with review_app/checklist.py WATCH_CALLS; these are the fallbacks
      line_kinds: ["fill", "change", "delete", "plant", "reverified", "new_row", "checked"],
      item_kinds: ["concern", "monitor", "entity", "other"],
      item_calls: TB.item_calls || {concern: ["confirmed", "dismissed", "needs_research"], monitor: ["add_to_database", "hold", "possible_updates", "research_further", "remove"]},
      other_calls: TB.other_calls || ["noted", "todo", "dismissed"],
      note_required: TB.note_required || ["monitor:remove"],
      // "research further" is a call on a lead only: a plain watch item never offers it
      itemCalls: function (kind, it) {
        if (kind !== "monitor" || isLead(it)) return null;
        var all = (TB.item_calls && TB.item_calls.monitor) || ["add_to_database", "hold", "possible_updates", "research_further", "remove"];
        return all.filter(function (c) { return c !== "research_further"; });
      },
      kind_label: KIND_LABEL,
      kind_tip: KIND_TIP,
      kindLabel: function (o, KL) { return o.kind === "monitor" ? (isLead(o) ? LEAD_LABEL[o.lead_for] : MONITOR_LABEL[o.monitor_kind] || KL.monitor) : (KL[o.kind] || o.kind); },
      kindTip: function (o, KT) {
        if (o.kind === "monitor") return (isLead(o) ? KT.lead : KT[o.monitor_kind]) || "";
        if (o.kind === "concern" && o.question) return concernHead(o) + " " + KT.concern;   // the generic heading moves to the chip when the question is the headline
        return KT[o.kind] || "";
      },
      call_label: {add_to_database: "incorporate into database", hold: "hold", possible_updates: "send to possible updates", research_further: "research further", remove: "remove from watchlist", needs_research: "needs research"},
      call_help: {add_to_database: "this belongs in GEM now: the researcher turns it into a full edit (a new row or a change) for the next batch",
                  hold: "not sure yet, leave it on the watchlist", possible_updates: "goes on the possible-updates sheet for a later cycle",
                  research_further: "worth a closer look before anyone adds it: the lead goes on the next batch's briefs",
                  remove: "take it off the watchlist for good; say why in the note"},
      call_hint: {concern: "confirmed: the concern stands and goes into the evidence file. dismissed: closed, nothing to do. needs research: back to the researcher for another pass",
                  monitor: "incorporate into database: this belongs in GEM now, the researcher writes it up as a full edit. hold: keep watching. send to possible updates: park it on the possible-updates sheet for a later cycle. research further (leads only): a closer look in the next batch before it is added. remove from watchlist: drop it, with a note saying why",
                  other: "noted: seen. todo: to do later. dismissed: closed"},
      sev_tip: {major: "major change: a cell value moves. A blank is filled, a value is changed or cleared, a plant-wide field is set, or a row is added",
                minor: "minor change: the value stands and only a source link is added (it was checked again, or the cell already has a link), or the edit is to Status Detail"},
      tier_tip: TIER_TIP,
      hideFields: ["gem_unit_id", "unit_name", "group", "group_label", "checks", "monitor_kind", "lead_for", "pm_flag", "pm_note", "pm_by", "duplicate_of", "concern_type_raw", "plant_name", "validation_errors", "validation_fix", "proposed_value", "ready", "question", "finding", "merged_from", "recommendation_raw"],
      itemFacets: ["group"],
      store: {flag: "/api/flag"},
      QK: {decision: "d", kind: "k", group: "g", tier: "t", dir: "dir", column: "col", q: "q", country: "c", state: "st", status: "sts", dc: "dc", by: "by", captive: "cap", pm: "pm"},
      routeEmpty: "all",         // every status (or country, state) ticked is written as "all" in the address, since the status default is not empty

      slots: {
        "queue-pane": '<div id="qtabs" class="tabs qtabs" role="tablist" aria-label="queue"></div>',
        "filters": '<span id="f-country" class="countries" role="group" aria-label="country" hidden></span><span id="f-state" class="countries" role="group" aria-label="state" hidden></span><span id="f-status" class="countries" role="group" aria-label="status" hidden></span>' +
          '<label class="check" data-tip="only records flagged ask the PM: lines, items and whole plants. Decided ones are listed too"><input type="checkbox" id="f-pm"> ask the PM</label>' +
          '<label class="check" data-tip="only plants with a related data center: a plant any of whose records ticks QC/Country checklist row 39 (gas-fired data centers, US only)"><input type="checkbox" id="f-dc"> data centers only</label>' +
          '<label data-after="f-kind" id="f-group-label"><span data-tip="the group of the GOGPT QC/Country checklist every change and item is sorted into; pick one to see everything in it, decided or not">checklist</span> <select id="f-group"></select></label>'
      },

      // ---- filters ----
      defaults: function () { return {group: "", country: [], state: [], status: devDefault(), dc: false, captive: false, pm: false}; },
      // items (questions, watch items, entity checks) sit beside the edits whenever a checklist group is on;
      // on an addition or watch card the items ARE the card, so they stay in view whatever the filters say
      itemsInView: function (fs, o, p) { return !!(fs.group || fs.captive || fs.pm || (p && cardKind(p) !== "plant")); },
      match: function (o, p, fs, skip) {
        if (skip !== "group" && fs.group && groupOf(o) !== fs.group) return false;
        if (fs.captive && !isCaptive(o)) return false;
        if (skip !== "country" && fs.country.length && fs.country.indexOf(p.country) < 0) return false;
        if (skip !== "state" && fs.state.length && fs.state.indexOf(p.state) < 0) return false;
        if (fs.pm && !o.pm_flag && !(p && p.pm_flag)) return false;
        if (fs.dc && !hasDataCenter(p)) return false;
        if (skip !== "status" && fs.status.length && !statusOn(p, fs.status)) return false;
        return true;
      },
      tally: function (p) {
        var pm = p.pm_flag ? 1 : 0;
        p.lines.forEach(function (l) { if (l.pm_flag) pm++; });
        p.items.forEach(function (it) { if (it.pm_flag) pm++; });
        p._pm = pm;
      },
      facetVal: function (o, facet) { return facet === "group" ? groupOf(o) : o[facet]; },
      renderChips: function () {
        renderScope();
        renderCountries();
        var groups = D().groups || [], gids = groups.map(function (g) { return String(g.id); }), gl = {};
        groups.forEach(function (g) { gl[String(g.id)] = (g.id === "other" ? "" : g.id + " · ") + g.label; });
        if (gids.indexOf("other") < 0 && A.LINES.concat(A.ITEMS).some(function (o) { return groupOf(o) === "other"; })) { gids.push("other"); gl.other = "other"; }
        A.facetSelect("f-group", "group", gids, gl);
      },
      selectFilters: ["group"],
      initFilters: function () {
        // a menu's select-all button and its checkboxes; all ticked is the same as none ticked
        function menu(id, field, values) {
          var box = $(id);
          box.onclick = function (e) {
            if (!e.target.classList.contains("ctoggle")) return;
            e.stopPropagation();
            var on = Array.prototype.every.call(box.querySelectorAll("input[type=checkbox]"), function (i) { return i.checked; });
            rememberStates();
            var had = stateChoices().length > 0;
            FS()[field] = on ? [NO_COUNTRY] : [];
            after(field, had);
          };
          box.onchange = function () {
            var boxes = box.querySelectorAll("input[type=checkbox]"), sel = Array.prototype.filter.call(boxes, function (i) { return i.checked; }).map(function (i) { return i.value; });
            rememberStates();
            var had = stateChoices().length > 0;
            FS()[field] = sel.length === boxes.length ? [] : sel.length ? sel : [NO_COUNTRY];
            after(field, had);
          };
        }
        // changing the countries can take the state menu away: drop states that are no longer offered
        function after(field, had) {
          if (field === "state") rememberStates();
          if (field === "country") reconcileStates(had);
          A.changed();
        }
        menu("f-country", "country");
        menu("f-state", "state");
        // the status menu: the group box ticks or unticks its statuses, the toggle button does every box in the menu; all ticked is the same as none ticked
        var sbox = $("f-status");
        function statusBoxes() { return Array.prototype.slice.call(document.querySelectorAll("#f-status input[value]:not(:disabled)")); }
        function setStatus() {
          var boxes = statusBoxes(), sel = boxes.filter(function (i) { return i.checked; }).map(function (i) { return i.value; });
          FS().status = sel.length === boxes.length ? [] : sel.length ? sel : [NO_COUNTRY];
          A.changed();
        }
        sbox.onclick = function (e) {
          if (!e.target.classList.contains("ctoggle")) return;
          e.stopPropagation();
          var boxes = statusBoxes(), allOn = boxes.every(function (i) { return i.checked; });
          function apply() { statusBoxes().forEach(function (i) { i.checked = !allOn; }); setStatus(); }
          // "select all" ticks the other statuses too, so it asks first the way ticking one of them does
          if (!allOn && boxes.some(function (i) { return !i.checked && isOther(i.value); })) { confirmOther(apply); return; }
          apply();
        };
        function isOther(v) { return !!v && v !== NEW_DEV && !isDev(v); }
        // ticking a status outside in development (the "other statuses" box or one of its statuses) changes nothing until the researcher clicks "Show anyway"; "OK, I understand" or closing the popup leaves the filter as it was
        function confirmOther(redo) {
          var dlg = $("dialog");
          dlg.setAttribute("data-kind", "info");
          dlg.innerHTML = "<h3>other statuses</h3><p><b>NOTE:</b> Checking statuses that aren't explicitly in development is not an expected part of the regular update.</p>" +
            '<div class="actions"><button type="button" class="dlg-alt" id="dlg-show">Show anyway</button><button type="button" class="dlg-ok" id="dlg-ok">OK, I understand</button></div>';
          $("dlg-ok").onclick = function () { dlg.close(); };
          $("dlg-show").onclick = function () { dlg.close(); redo(); };
          dlg.showModal();
        }
        // tick the group box or the one status, and the statuses under the group, then filter
        function tickStatus(group, value) {
          var t = group ? sbox.querySelector('input[data-group="' + group + '"]') : Array.prototype.filter.call(sbox.querySelectorAll("input[value]"), function (i) { return i.value === value; })[0];
          if (!t || t.disabled) return;
          t.checked = true;
          if (group) Array.prototype.forEach.call(sbox.querySelectorAll("input[value]:not(:disabled)"), function (i) { if (!isNew(i.value) && isDev(i.value) === (group === "dev")) i.checked = true; });
          setStatus();
        }
        sbox.onchange = function (e) {
          var g = e.target.getAttribute("data-group"), v = e.target.value;
          var other = g ? g === "rest" : isOther(v);
          if (other && e.target.checked) {
            renderStatus();     // the tick is not applied: draw the menu from the filter as it still is
            confirmOther(function () { tickStatus(g, v); });
            return;
          }
          if (g) Array.prototype.forEach.call(sbox.querySelectorAll("input[value]:not(:disabled)"), function (i) { if (!isNew(i.value) && isDev(i.value) === (g === "dev")) i.checked = e.target.checked; });
          setStatus();
        };
        $("f-dc").onchange = function () { FS().dc = this.checked; A.changed(); };
        // flagged records are often already decided, so ticking the box lifts the undecided-only default
        $("f-pm").onchange = function () { FS().pm = this.checked; if (this.checked) FS().decision = ""; A.changed(); };
        // the ask the PM and data center boxes sit after the search bar, just before the more filters button group (not inside it)
        var fm = $("f-more"); fm = fm.closest(".fbtns") || fm; fm.parentNode.insertBefore($("f-pm").closest("label"), fm); fm.parentNode.insertBefore($("f-dc").closest("label"), fm);
        // kind and checklist sit with the other less-used filters
        var more = $("more-filters"), first = more.firstElementChild;
        [$("f-kind").closest("label"), $("f-group-label")].forEach(function (l) { if (l) more.insertBefore(l, first); });
        document.addEventListener("click", function (e) {
          Array.prototype.forEach.call(document.querySelectorAll("#f-country details, #f-state details, #f-status details"), function (d) { if (d.open && !d.contains(e.target)) d.open = false; });
        });
      },
      syncControls: function () {
        var fs = FS();
        $("f-dc").checked = !!fs.dc;
        $("f-pm").checked = !!fs.pm;
        // a route from before the where buttons (several ticked states) or for a place not on the page falls back to the whole page
        if (!whereValid()) { fs.country = []; fs.state = []; }
      },
      activeChips: function (chipFn, when) {
        var fs = FS();
        if (when === "before") {
          // the status filter differs from its default (in development plus new in development): a chip says how
          var sel = fs.status || [];
          if (!isDefaultStatus(sel)) {
            var text, rest = sel.filter(function (x) { return x !== NO_COUNTRY && !isNew(x) && !isDev(x); });
            if (!sel.length) text = "status: all";
            else if (sel.length === 1 && sel[0] === NO_COUNTRY) text = "status: none";
            else {
              var dev = sel.filter(isDev), parts = [];
              if (dev.length === DEV_LABEL.length) parts.push("in development"); else parts = parts.concat(dev.map(statusBase));
              parts = parts.concat(rest);
              [NEW_DEV, NEW_OTHER].forEach(function (s) { if (sel.indexOf(s) >= 0) parts.push(s); });
              text = "status: " + parts.join(", ");
            }
            chipFn("status", text, false);
          }
          if (fs.kind) chipFn("kind", "kind: " + (KIND_LABEL[fs.kind] || fs.kind), true);
          if (fs.group) chipFn("group", "checklist: " + groupLabel(fs.group), true);
          if (fs.pm) chipFn("pm", "flagged ask the PM", false);
          if (fs.dc) chipFn("dc", "plants with data centers", false);
          if (fs.captive) chipFn("captive", "captive power (rows " + CAPTIVE_ROWS.join(", ") + ")", false);
        }
      },
      progressNote: function () {
        var pm = pmCount(), tracked = trackedPlants(), done = tracked.filter(plantChecked).length;
        return (tracked.length ? " &middot; " + done + " of " + plural(tracked.length, "plant") + " checked" : "") + (pm ? " &middot; " + pm + " flagged for the PM" : "");
      },
      progressHtml: function () {
        var gs = groupStats();
        return '<h4>by checklist group</h4><table class="sumtab"><tr><th>group</th><th>open</th><th>total</th></tr>' +
          (D().groups || []).filter(function (x) { return !x.panel; }).map(function (x) {
            var s = gs[String(x.id)] || {open: 0, total: 0};
            return "<tr><td>" + esc((x.id === "other" ? "" : x.id + " · ") + x.label) + '</td><td class="num">' + (s.total && !s.open ? "✓" : s.open) + '</td><td class="num">' + s.total + "</td></tr>";
          }).join("") + "</table>";
      },

      // ---- derived data ----
      onReload: function (data) {
        ROW_LABEL = {};
        BY_PLANT = {};
        newRowsFirst(data.cards || data[TB.cards_key || "plants"] || []);
        (data.groups || []).forEach(function (g) { (g.rows || []).forEach(function (r) { ROW_LABEL[r.row] = r.label; }); });
      },
      prepare: function (p, i) {
        p.units = p.units || [];
        var id = plantId(p);
        if (id && !p.statewide) (BY_PLANT[id] = BY_PLANT[id] || {})[cardKind(p)] = i;
        p._hay = [p.name, p.pid, id, p.state].concat(p.units.map(function (u) { return u.gem_unit_id + " " + u.unit_name; })).join(" ").toLowerCase();
        // a minor change nobody has decided loads as held (grayed out): a page default, not a saved record, so a person's call replaces it
        p.lines.forEach(function (l) {
          if (A.sevOf(l) !== "minor" || cur(l)) return;
          l.decision = "hold"; l.reviewed = true; l.decided_by = null; l.decided_at = null; l._autohold = true;
        });
      },

      // ---- the queue and the checklist pane ----
      renderQueue: function () { renderQtabs(); if (VIEW !== "checklist") return false; renderChecklist(); return true; },
      // the queue lists one tab at a time; opening a card from the other tab (a link, j / k never cross) switches to it
      queueShows: function (p) { return qtabOf(p) === QTAB; },
      beforeSelect: function (p) { if (!p || qtabOf(p) === QTAB) return false; setQtab(qtabOf(p)); return true; },
      hideItemsSwitch: false,
      hideDoneInFilters: true,
      // a header before the first card of each section, with how many of its cards the pane shows
      queueSection: function (p, prev, shown) {
        var k = sectionOf(p);
        if (prev && sectionOf(prev) === k) return "";
        var n = shown.filter(function (x) { return sectionOf(x) === k; }).length;
        return '<span' + tipAttrs(SECTION_TIP[k]) + ">" + esc(SECTION[k]) + '</span> <span class="n">' + n + "</span>";
      },
      queueRow: function (p, i, x) {
        var pm = p._pm ? ' <span class="pm"' + tipAttrs(p._pm + " question" + (p._pm === 1 ? "" : "s") + " for the PM on this plant") + ">PM " + p._pm + "</span>" : "";
        var un = unitNames(p), k = cardKind(p);
        if (noChanges(p)) {       // a plant with nothing proposed: to check, checked, or held for later
          var d = cur(p.lines[0]);
          x.badge = d === "accept" || preChecked(p.lines[0]) ? '<span class="n">checked</span>' : d === "hold" ? '<span class="n todo">held for later</span>' : '<span class="n todo">to check</span>';
        }
        var where = p.statewide ? "statewide" : k === "watch" ? "watch" :
          k === "addition" ? (untracked(p) ? "new plant" : addCount(p, ", ")) :
          (p.units.length + " unit" + (p.units.length === 1 ? "" : "s"));
        return '<div class="pname">' + esc(p.name || "(no name)") +
          (un.length && k === "plant" ? ' <span class="pseg">' + esc(un[0]) + (un.length > 1 ? " +" + (un.length - 1) : "") + "</span>" : "") + pm +
          '</div><div class="pmeta"><span>' + esc(p.statewide ? p.state : (untracked(p) ? "not in GEM yet" : plantId(p))) + " &middot; " + esc(where) +
          '</span><span class="grow"></span>' + x.badge + '</div>' + (x.dots ? '<div class="dots">' + x.dots + "</div>" : "");
      },
      onQueueClick: function (e) {
        if (e.target.closest("li[data-captive]")) return selectCaptive();
        var g = e.target.closest("li[data-g]");
        if (g) selectGroup(g.getAttribute("data-g"));
      },

      // ---- lines ----
      lineBody: function (l) {
        if (l.kind === "new_row") return newRowBody(l);
        if (l.kind === "checked") return checkedBody(l);
        var h = verrBox(l) + A.pairTable(editValueRows(l) + siblingRow(l) + A.refRow(l));
        var facts = [];
        if (l.column === "Status") {
          if ((l.publishers || 0) < 2) facts.push(chip("single source", "single", "fewer than two independent publishers: a status change is green only with two or more. One source makes it yellow"));
          else facts.push(chip(l.publishers + " publishers"));
        }
        if (l.independent) facts.push(chip("second source", "ok", "a second independent source was recorded for this value"));
        h += facts.length ? '<div class="facts">' + facts.join(" ") + "</div>" : "";
        return h + (l.location ? locationBlock(l.location) : "");
      },
      lineChips: function (l, base) {
        var chips = [];
        if (l.kind === "checked") {        // no confidence or severity chip: there is no proposed value to rate
          chips.push(chip("no suggested changes", "oo", "the research batch found nothing to change on this plant. Mark it checked once you have looked it over and set its Last Updated and Research status in the database"));
          base = [];
        }
        if (l.kind === "new_row") {        // the title says new unit or new plant; one chip counts the verified sources. No confidence, severity or checklist chip: all three read the same on every new row
          chips.push(readinessChip(l));
          base = [];
        }
        if (l.kind === "plant") chips.push(chip("plant-wide", "oo", "a plant-level field: the export repeats it on every unit row, so the edit lands on every unit row of this plant"));
        if (l.validation_fix) chips.push(chip("validation fix", "oo", "an answer to the database's validation report that carries a value and a source: accept it to type the value into the web form"));
        chips = chips.concat(base);
        if (l.location && l.location.needs_review) chips.push(chip("needs a second look", "single", "the researcher was not sure of this point: check it against the satellite picture before accepting"));
        if (l.kind !== "new_row") chips.push(groupChip(l));
        if (l.irp) chips.push(irpChip(l));
        if (l.pm_flag) chips.push(pmChip(l));
        return chips;
      },
      columnNoun: "attribute",
      actionLabel: "what to change",
      hideRecord: true,
      columnKey: function (c) { return /^(Latitude|Longitude|Location accuracy|City|Local area \(taluk, county\)|Major area \(prefecture, district\))$/.test(c) ? "Latitude" : c; },
      columnText: function (c) { return c === "Latitude" ? "Location" : c; },
      lineTitle: function (l) {
        var pv = l.proposed_values || {};
        if (l.kind === "checked") return "No suggested changes";
        if (l.location) return "Location";
        if (l.kind === "new_row") {        // "New unit: CT31-1", "New plant: Gowanus repowering (3 units)"
          var n = (l.units || []).length;
          return (newUnit(l) ? "New unit: " + (pv["Unit name"] || l.unit_name || pv["Plant name"] || l.plant_name || "(unnamed)")
                             : "New plant: " + (pv["Plant name"] || l.plant_name || pv["Unit name"] || l.unit_name || "(unnamed)")) +
            (n ? " (" + n + " unit" + (n === 1 ? "" : "s") + ")" : "");
        }
        return l.column || "";
      },
      lineWhere: function (l) { return l.kind === "checked" ? "" : rowLabel(l); },
      // a "checked" line offers checked and hold for later instead of accept / hold / reject, and no suggest form
      lineActions: function (l) {
        if (l.kind !== "checked") return null;
        return {buttons: [["accept", "checked", "I looked at this plant and set its Last Updated and Research status in the database"], ["hold", "hold for later", "come back to this plant later"]], suggest: false};
      },
      decisionText: function (l) {
        if (l._autohold && cur(l) === "hold" && !l.decided_by) return "held by default: a minor change. Accept or reject it to decide it";
        if (preChecked(l)) return "already checked in the database this cycle: every unit shows a Last Updated of " + l.checked_in_db + " or later";
        if (l.kind !== "checked" || !cur(l)) return null;
        return (cur(l) === "accept" ? "checked by " : "held for later by ") + (l.decided_by || "?") + " " + A.timeOf(l.decided_at) + (blankv(l.decision_note) ? "" : ". " + l.decision_note);
      },
      lineControls: function (l) { return pmBox(l, "data-pm", l.key); },
      // a no-change plant already checked in the database this cycle: grayed and left out of the open counts, so "hide done" drops it
      counted: function (l) { return !preChecked(l); },
      dimmed: function (l) { return A.grayed(l) || preChecked(l); },
      lineClass: function (l) { return l.kind === "new_row" ? " newcard" : ""; },
      firstRef: function (l) {
        if (l.kind !== "new_row") return null;
        var refs = l.refs_by_col || {}, out = "";
        Object.keys(refs).forEach(function (c) { if (!out) out = A.asList(refs[c])[0] || ""; });
        return out;
      },
      // lines grouped by unit when the plant has several units
      groupLines: function (p, keep) {
        var multi = p.units.length > 1 || keep.some(function (l) { return lineUnit(l) === ""; }) && keep.some(function (l) { return lineUnit(l) !== ""; });
        if (!multi) return null;
        var groups = [];
        var pw = keep.filter(function (l) { return lineUnit(l) === ""; });
        if (pw.length) groups.push({label: "plant-wide", lines: pw});
        p.units.forEach(function (u) {
          groups.push({label: unitText(u), lines: keep.filter(function (l) { return lineUnit(l) === u.gem_unit_id; })});
        });
        var rest = keep.filter(function (l) { return lineUnit(l) && !unitOf(p, lineUnit(l)); });
        if (rest.length) groups.push({label: "other units", lines: rest});
        return groups;
      },

      // ---- items ----
      itemHead: function (it) {
        switch (it.kind) {
          // the researcher's own question when the record carries one; else the generic heading for its concern type
          case "concern": return it.question || concernHead(it);
          // the recheck date is bookkeeping for the next batch, not for the reviewer; it stays out of the page
          case "monitor": return it.reason || it.item || "watch this plant";
          case "entity": return (it.entity_name || "entity") + (it.role ? " as " + it.role : "");
          default: return it.title || it.kind;
        }
      },
      itemWhere: function (it) { return it.gem_unit_id ? unitText(unitOf(plants()[it._p], it.gem_unit_id), it.gem_unit_id) : "plant"; },
      itemClass: function (it) { return it.kind === "monitor" ? " watch-" + (it.monitor_kind || "existing_plant") + (isLead(it) ? " lead" : "") : ""; },
      kindClass: function (it) { return it.kind === "monitor" ? "watch" : ""; },
      itemChips: function (it) {
        return (isLead(it) ? chip("lead", "lead", "not enough yet to write the row; research further puts it on the next batch's briefs") + " " : "") +
          groupChip(it) + (it.irp ? " " + irpChip(it) : "") + (it.merged_from ? " " + mergedChip(it) : "") + (it.pm_flag ? " " + pmChip(it) : "");
      },
      itemFacts: function (it) {
        if (it.kind !== "monitor") {
          var h = verrBox(it);
          var pv = it.kind === "concern" && (it.validation_errors || []).length ? Object.keys(it.proposed_value || {}).filter(function (k) { return String(it.proposed_value[k] || "").trim(); }) : [];
          if (pv.length) h += '<div class="facts">' + pv.map(function (k) { return chip((k === "value" ? "" : k + ": ") + it.proposed_value[k], "single", "the researcher suggested this value without a source for it, so it is a question, not an edit"); }).join(" ") + "</div>";
          return h;
        }
        var facts = [];
        if (it.capacity_mw) facts.push(chip(it.capacity_mw + " MW"));
        if (it.status) facts.push(chip(it.status));
        if (it.tier && it.tier !== "untiered") facts.push(chip(it.tier + " confidence", it.tier, TIER_TIP[it.tier]));
        if (it.duplicate_of) {
          var first = A.ITEM_BY_KEY[it.duplicate_of];
          facts.push(chip("also staged in " + A.dirLabel(first ? first.dir : it.duplicate_of.split("::")[0]), "oo", "the same candidate was staged twice (an update batch and a discovery batch): decide it once, on the first copy, and give this one the same call"));
        }
        return facts.length ? '<div class="facts">' + facts.join(" ") + "</div>" : "";
      },
      itemNoteHint: function (it) { return it.kind === "monitor" ? " (needed to remove from the watchlist)" : ""; },
      itemControls: function (it) { return pmBox(it, "data-pm", it.key); },
      // items grouped by checklist group, in the dataset's order
      itemGroup: {
        of: groupOf,
        order: function () { return (D().groups || []).map(function (g) { return String(g.id); }); },
        label: function (g) { return groupLabel(g); }        // the group's words, as on the chips
      },

      // ---- the card ----
      cardContext: function (p) {
        var k = cardKind(p);
        var dbId = !p.statewide && !untracked(p) && /^[A-Za-z]?(\d+)$/.exec(plantId(p));
        // the plant's other cards, as links: "plant edits", "2 proposed units", "watch"
        var links = siblings(p).map(function (s) {
          var c = s.card, text = s.kind === "plant" ? "plant edits" : s.kind === "watch" ? "watch list" :
            addCount(c, " and ", "proposed unit");
          return '<a href="#" data-card="' + s.index + '"' + tipAttrs("open this plant's " + SECTION[s.kind] + " card") + ">" + esc(text) + " &rarr;</a>";
        });
        return [dbId && '<a href="https://gem-project-db.herokuapp.com/projects/edit/' + dbId[1] + '" target="_blank" rel="noopener"' + tipAttrs("open this plant in the GEM project database") + ">project db ↗</a>",
                /^https?:\/\//.test(p.wiki || "") && '<a href="' + esc(p.wiki) + '" target="_blank" rel="noopener"' + tipAttrs("open this plant's page on the GEM wiki") + ">wiki ↗</a>",
                p.statewide && "<b>statewide notes, not one plant</b>", untracked(p) && !p.statewide && "<b>not in GEM yet: a candidate plant</b>",
                !untracked(p) && k === "addition" && "<b>new units proposed at this plant</b>", k === "watch" && "<b>watch list: nothing here changes a cell</b>",
                p.state && esc(p.state), k === "plant" && p.units.length && plural(p.units.length, "unit"),
                k === "plant" && unitStatusText(p), k === "plant" && unitCapacityText(p),
                noChanges(p) && "<b>no suggested changes</b>",
                k !== "watch" && !noChanges(p) && A.tierSummary(p), links.length && '<span class="xcards">' + links.join(" ") + "</span>",
                ];
      },
      cardSub: function (p) {
        if (cardKind(p) !== "plant") return "";
        var un = unitNames(p);
        return un.length > 4 ? un.slice(0, 3).join(" / ") + " / +" + (un.length - 3) : un.join(" / ");
      },
      showPid: function (p) { return !(p.statewide || untracked(p)); },
      pidText: plantId,
      // an addition or watch card, or a plant with no suggested changes, has no tabs: its rows, then its items, on one page
      flatCard: function (p) { return cardKind(p) !== "plant" || noChanges(p); },
      collapseTabs: true,      // a plant card shows its major changes tab; + opens minor changes, items and everything
      tabFoldNotice: "NOTE: These minor and additional changes are not an expected part of the regular update.",
      bulkButtons: chromeButton,     // no bulk accept: every change is decided one at a time; the one button copies the accepted changes for Claude in Chrome
      cardPanel: function (name) { return name === "closeout" ? closeoutHtml() : ""; },
      onCardClick: function (e) {
        var cp = e.target.closest("button[data-copy]");
        if (cp) { var what = cp.getAttribute("data-copy"); A.copyText(closeoutCopy[what] || "", what === "draft" ? "draft copied" : "unit lists copied"); return true; }
        var ch = e.target.closest("button[data-chrome]");
        if (ch) {
          var card = A.cards()[S.pipe], text = card ? chromeText(card) : "";
          if (!text) A.toast("nothing on this card is accepted yet: accept the changes first");
          else A.copyText(text, "copied for Claude in Chrome: paste it into the side panel on the GEM web form");
          return true;
        }
        var xc = e.target.closest("a[data-card]");
        if (xc) { e.preventDefault(); A.selectPipe(+xc.getAttribute("data-card")); return true; }
        return !!e.target.closest(".pmbox, .pmnote");       // the ask-the-PM box saves on change, not on click
      },
      onCardChange: onPmChange,
      applyRecord: function (r) {
        if (!("flag" in r)) return false;
        applyFlagRecord(r);
        return true;
      },

      // ---- help, routing, boot ----
      info: info,
      expose: {chromeText: chromeText},      // window.ReviewApp.chromeText(card): the Claude in Chrome message, for tests
      routeKey: function (data) { var c = (data && data.scope) || {}; return "review-route:" + [c.country || "", (c.states || []).join(","), c.quarter || ""].join("|"); },
      // the filter state was made before this file registered its keys: start it again with them
      onInit: function () { A.FS = A.defaults(); },
      onBoot: function (data) {
        renderScope();
        setView("plants");        // no checklist tab on the left bar any more
        $("qtabs").addEventListener("click", onQtabClick);
      },
      afterReload: function () { renderScope(); }
    };
  });
})();
