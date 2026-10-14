/* GOGPT extension for the shared review app (gem-review-app). Loads after review_core/web/app.js and registers everything GOGPT-only through ReviewApp.define: the checklist groups and the checklist pane, the where filter (country and state), the ask-the-PM flag, units on a plant, new rows, the IRP chip, watch items and the close-out panel. */
(function () {
  "use strict";
  if (!window.ReviewApp || !window.ReviewApp.define) return;
  var TB = (window.REVIEW_STATIC || {}).tracker || {};

  window.ReviewApp.define(function (A) {
    var $ = A.$, esc = A.esc, chip = A.chip, tipAttrs = A.tipAttrs, blankv = A.blankv, cur = A.cur, S = A.S;
    var ROW_LABEL = {};        // checklist row number -> its label (from the dataset's groups)
    var VIEW = "plants";       // the left pane: "plants" (the queue) or "checklist" (the QC/Country checklist groups)
    var closeoutCopy = {};     // the close-out panel's copy buttons: units, draft

    var KIND_LABEL = {plant: "plant-wide", reverified: "re-verified", monitor: "watch item", entity: "new owner or operator to create"};
    var MONITOR_LABEL = {new_to_tracker: "watch item: new to the tracker", existing_plant: "watch item: existing plant"};
    var KIND_TIP = {concern: "a question the researcher raised about data already in GEM: a value that could not be checked, two sources that disagree, a possible duplicate. It never changes a cell by itself",
                    entity: "an owner, operator or parent that is not in GEM's entity list yet. Someone has to create it in the GEM web form before the ownership edit can land",
                    new_to_tracker: "a plant or project GEM does not track at all yet. The researcher found it but it did not clear the bar for a new row (too early, too small, or too thin on evidence). Decide whether it goes into the database now, stays on the watchlist, goes to the possible-updates sheet, or comes off the list",
                    existing_plant: "something to watch on a plant GEM already tracks: a permit in progress, an expansion, a retirement date to confirm. The plant's row is not changed by this item"};
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
    function isOpen(o) { return o._item ? !(o.call && o.reviewed) : !cur(o); }
    function flagged(o, p) { return !!(o.pm_flag || (p && p.pm_flag)); }
    // "new:<name>" ids mark a plant GEM does not track yet (a discovery candidate on the monitor list)
    function untracked(p) { return !p.pid || p.pid.indexOf("new:") === 0; }
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
    // where on the plant a line lands: "unit F701 (G100000401771)", "plant-wide (4 units)", "new row"
    function rowLabel(l) {
      if (l.kind === "new_row") return "new row";
      var p = plants()[l._p];
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
    // the choices of the where picker: value "" is the whole page, else "country|state" (state "" = the whole country). One choice when the page covers one place
    function whereOptions() {
      var cs = countries(), out = [];
      if (cs.length === 1) {
        var k = cs[0], st = realStates(k);
        if (st.length < 2) return [{v: "", label: st.length ? st[0] : k}];
        out.push({v: "", label: "all: " + st.join(", ")});
        st.forEach(function (s) { out.push({v: k + "|" + s, label: s, c: k, s: s}); });
        return out;
      }
      out.push({v: "", label: "all"});
      cs.forEach(function (k) {
        var st = realStates(k);
        if (st.length < 2) return out.push({v: k + "|", label: st.length ? st[0] + ", " + k : k, c: k});
        out.push({v: k + "|", label: "all of " + k, c: k, group: k});
        st.forEach(function (s) { out.push({v: k + "|" + s, label: s, c: k, s: s, group: k}); });
      });
      return out;
    }
    function whereValue() { return FS().country ? FS().country + "|" + FS().state : ""; }
    // the where picker, each choice with its live line + item count under the other filters (the unit the other pickers count)
    function renderWhere() {
      var sel = $("f-where");
      if (!sel) return;
      var q = FS().q.trim().toLowerCase(), per = plants().map(function (p) {
        var n = 0;
        p.lines.forEach(function (l) { if (A.match(l, p, FS(), "where", q)) n++; });
        p.items.forEach(function (it) { if (A.match(it, p, FS(), "where", q)) n++; });
        return n;
      });
      function count(o) {
        var n = 0;
        plants().forEach(function (p, i) { if ((!o.c || p.country === o.c) && (!o.s || p.state === o.s)) n += per[i]; });
        return n;
      }
      var h = "", group = null;
      whereOptions().forEach(function (o) {
        if ((o.group || null) !== group) { h += (group ? "</optgroup>" : "") + (o.group ? '<optgroup label="' + esc(o.group) + '">' : ""); group = o.group || null; }
        h += '<option value="' + esc(o.v) + '">' + esc(o.label) + " (" + count(o) + ")</option>";
      });
      sel.innerHTML = h + (group ? "</optgroup>" : "");
      sel.value = whereValue();
    }
    // header: what the page covers, in words, with its plant count. It does not follow the filters: the where picker shows the narrowing
    function renderScope() {
      var el = $("scope");
      if (!el || !D()) return;
      var n = plants().filter(function (p) { return !p.statewide; }).length;
      el.innerHTML = '<span class="where">' + esc(countries().map(placeName).join("; ")) + "</span> &middot; " + plural(n, "plant");
    }

    // ---- checklist groups ----
    // per checklist group: everything in it (edits and items), how much is still open, how much is flagged for the PM
    function groupStats() {
      var out = {};
      (D().groups || []).forEach(function (g) { out[String(g.id)] = {total: 0, open: 0, pm: 0, rows: {}}; });
      A.LINES.concat(A.ITEMS).forEach(function (o) {
        var gid = groupOf(o), s = out[gid] || (out[gid] = {total: 0, open: 0, pm: 0, rows: {}});
        s.total++;
        if (isOpen(o)) s.open++;
        if (o.pm_flag) s.pm++;
        (o.checks || []).forEach(function (n) { s.rows[n] = s.rows[n] || {total: 0, open: 0}; s.rows[n].total++; if (isOpen(o)) s.rows[n].open++; });
      });
      return out;
    }
    function pmCount() {
      return A.LINES.concat(A.ITEMS).filter(function (o) { return o.pm_flag; }).length + plants().filter(function (p) { return p.pm_flag; }).length;
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
      var gs = groupStats(), h = [], closeout = S.panel === "closeout";
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
        return nm + (blankv(sc[id]) ? " (blank now)" : " (now " + sc[id] + ")");
      }).join(", ");
      return '<tr class="note"><td></td><td colspan="3"><div class="faint">the same edit lands on the other unit rows of this plant: ' + esc(txt) + "</div></td></tr>";
    }
    function newRowTable(vals, refs, l) {
      vals = vals || {}; refs = refs || {};
      var tr = Object.keys(vals).filter(function (c) { return !blankv(vals[c]); }).map(function (c) {
        return "<tr><td>" + esc(c) + "</td><td>" + esc(vals[c]) + A.copyBtn(vals[c]) + "</td></tr>";
      });
      Object.keys(refs).forEach(function (c) {
        var us = A.asList(refs[c]);
        if (!us.length) return;
        tr.push("<tr><td>" + esc(c) + "</td><td>" + us.map(function (u) { return A.urlLink(u) + A.copyBtn(u) + " " + A.vmark(u, l); }).join("<br>") + "</td></tr>");
      });
      return '<table class="rowdata">' + tr.join("") + "</table>";
    }
    function newRowBody(l) {
      var units = l.units || [];
      var h = '<div class="row1">' + chip(l.lane === "newunits" ? "new unit on a tracked plant" : "new plant", "newrow") +
        ' <span class="faint">' + (l.lane === "newunits" ? "a unit row to add under a plant GEM already tracks" :
          "a plant GEM does not track yet; every field below is new" + (units.length ? ", with " + units.length + " unit row" + (units.length === 1 ? "" : "s") + " to add under it. One call covers the plant and its units" : "")) + "</span></div>";
      h += newRowTable(l.proposed_values, l.refs_by_col, l);
      // a new plant's unit rows: each one its own small table under the plant fields
      units.forEach(function (u) {
        h += '<div class="row1 newunit"><span class="col">unit ' + esc(u.unit_name || "(unnamed)") + "</span></div>" + newRowTable(u.fields, u.refs_by_col, l);
        if (u.action) h += '<div class="dtxt"><span class="k">what to do in the GEM form:</span> ' + esc(u.action) + "</div>";
        if (u.notes) h += '<div class="dtxt"><span class="k">researcher notes:</span> ' + esc(u.notes) + "</div>";
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
    // the checklist group chip every line and item carries: "checklist 3" with the rows it ticks on hover
    function groupChip(o) {
      var gid = groupOf(o);
      return chip("checklist " + (gid === "other" ? "gap" : gid), "grp", groupTip(o));
    }
    function pmChip(o) { return chip("PM", "pm", "flagged for the project manager" + (o.pm_note ? ": " + o.pm_note : "")); }
    // the ask-the-PM box: a flag beside the decision, with a short note. Works on a line, an item or the whole plant.
    function pmBox(o, attr, id) {
      var dis = !A.Store.caps.decide, on = !!o.pm_flag;
      return '<label class="pmbox' + (on ? " on" : "") + '"' + tipAttrs(dis ? A.NOT_YET : "flag this for the GOGPT project manager. The flag sits beside your decision: you can accept something and still ask about it. Flagged items are listed together in the evidence file and can be filtered with \"ask the PM\"") +
        '><input type="checkbox" ' + attr + '="' + esc(id) + '"' + (on ? " checked" : "") + (dis ? " disabled" : "") + "> ask the PM</label>" +
        (on ? '<input type="text" class="pmnote" ' + attr + '-note="' + esc(id) + '" placeholder="question for the PM" value="' + esc(o.pm_note || "") + '"' + (dis ? " disabled" : "") + ">" : "");
    }

    // ---- items ----
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
      if (!Store.caps.decide || !Store.flag) return A.notYet();
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
      var units = {updated: [], open: [], none: []}, itemsOnly = [];
      plants().forEach(function (p) {
        if (p.statewide || untracked(p)) return;
        if (!p.lines.length && p.items.length) { itemsOnly.push(p); return; }
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
      // the numbers behind the summary draft
      var c = {accept: 0, hold: 0, reject: 0, suggest: 0, undecided: 0};
      LINES.forEach(function (l) { c[dstate(l)]++; });
      var statusAcc = LINES.filter(function (l) { return l.column === "Status" && cur(l) === "accept" && l.kind !== "reverified"; });
      var newRows = LINES.filter(function (l) { return l.kind === "new_row" && cur(l) === "accept"; });
      var watchNew = ITEMS.filter(function (it) { return it.kind === "monitor" && it.monitor_kind === "new_to_tracker"; });
      var watchOld = ITEMS.filter(function (it) { return it.kind === "monitor" && it.monitor_kind !== "new_to_tracker"; });
      var promote = ITEMS.filter(function (it) { return it.kind === "monitor" && it.call === "add_to_database"; });
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
      var nPlants = plants().filter(function (p) { return !p.statewide && !untracked(p); }).length;
      var sentences = [];
      sentences.push((quarter ? quarter.toUpperCase() + " " : "") + "GOGPT review of " + (where || "this scope") + ": " + plural(nPlants, "tracked plant") + " looked at.");
      sentences.push(plural(c.accept, "change") + " accepted, " + c.reject + " rejected, " + c.hold + " held, " + c.suggest + " sent back with a suggestion" + (c.undecided ? ", " + c.undecided + " not decided yet" : "") + ".");
      if (statusAcc.length) sentences.push("Status changes: " + statusAcc.map(function (l) {
        var p = plantOf(l), v = l.proposed_values && l.proposed_values.Status, from = l.current && l.current.Status;
        return p.name + (l.unit_name ? " " + l.unit_name : "") + (from ? " from " + from : "") + " to " + (v || "?");
      }).join("; ") + ".");
      if (newRows.length) sentences.push(plural(newRows.length, "new row") + " accepted for the database.");
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
    function info(savedWhere) {
      return "<h3>how this works</h3>" +
        "<p>This page shows the <b>edits a research batch proposes</b> for the Global Oil and Gas Plant Tracker. " +
        "Nothing here is in the GEM database yet, and nothing on this page can write to it. Your job is to say yes or no to each edit.</p>" +
        "<h4>what you see</h4>" +
        "<ul>" +
        "<li><b>Left list:</b> the plants with something to decide. Click one to open it.</li>" +
        "<li><b>Card:</b> that plant's proposed changes, one per cell, grouped by unit. Each change shows the cell as it is <b>now</b> and the <b>proposed</b> value, " +
        "plus the source links that back it. A new link is <b>added next to</b> the links already in the Data Source cell. It never replaces one.</li>" +
        "<li><b>Major / minor:</b> a <b>major change</b> moves a value: it fills a blank, changes or clears a value, sets a plant-wide field, or adds a row. " +
        "A <b>minor change</b> means the value was checked again and stands, so only a source link is added. " +
        "The card opens on the major changes; the minor ones have their own tab and an <b>accept all minor changes</b> button.</li>" +
        "<li><b>Color:</b> green means one fully checked source (a status change needs two independent publishers), yellow means one source or a partial match, and red means weak. " +
        "Green changes default to accept; the rest default to hold.</li>" +
        "<li><b>Plant-wide:</b> a plant-level field such as the location or the owner is repeated on every unit row, so one accept covers all of them.</li>" +
        "<li><b>Items</b> tab: questions the researcher raised, plants and projects to watch, and owners or operators to create. They take a call and a note, but they never change a cell.</li>" +
        "<li><b>Checklist:</b> every change and item is sorted into one of the groups of the GOGPT QC/Country checklist (the \"checklist N\" chip; hover it for the rows it ticks). " +
        "The <b>checklist</b> dropdown in the filters shows one group at a time, decided or not.</li>" +
        "</ul>" +
        "<h4>your four calls</h4>" +
        "<ul>" +
        "<li><b>accept:</b> yes, this edit goes into the actions workbook.</li>" +
        "<li><b>hold:</b> not sure yet, leave it open.</li>" +
        "<li><b>reject:</b> no, do not apply this.</li>" +
        "<li><b>suggest:</b> something else is right, so type the value or a note, and the source link if you have one. The researcher looks at it again; it does not go into the workbook as is.</li>" +
        "</ul>" +
        "<p><b>Ask the PM:</b> a checkbox beside every change, every item and at the top of every plant. It sits beside your decision, so you can accept something and still flag it. " +
        "Write the question in the box that appears. The <b>ask the PM</b> filter lists everything flagged; the evidence file gathers the questions in one place.</p>" +
        "<h4>the four kinds of item</h4>" +
        "<ul>" +
        "<li><b>Question about existing data:</b> the researcher doubts something already in GEM: a value that could not be checked, two sources that disagree, a possible duplicate. " +
        "Calls: <b>confirmed</b> (the question stands and goes into the evidence file), <b>dismissed</b> (closed), <b>needs research</b> (back to the researcher).</li>" +
        "<li><b>Watch item, new to the tracker:</b> a plant or project GEM does not track at all yet. It did not clear the bar for a new row (too early, too small, or thin on evidence), so it is on a watchlist instead.</li>" +
        "<li><b>Watch item, existing plant:</b> something to keep an eye on at a plant GEM already tracks: a permit in progress, an expansion, a retirement date to confirm. The plant's row is not changed by the item.</li>" +
        "<li><b>New owner or operator to create:</b> a company that is not in GEM's entity list. Someone creates it in the GEM web form before the ownership edit can land.</li>" +
        "</ul>" +
        "<p><b>IRP chip</b> (United States only): the finding comes from a utility integrated resource plan. The chip says whether the unit's IRP box in the database is already ticked; \"IRP: tick the box\" means it is not. The close-out panel lists them under row 37.</p>" +
        "<p><b>Watch items take four calls</b> instead of accept and reject: <b>incorporate into database</b> (it belongs in GEM now; the researcher writes it up as a full edit for the next batch), " +
        "<b>hold</b> (keep watching), <b>send to possible updates</b> (park it on the possible-updates sheet for a later cycle), and <b>remove from watchlist</b> (drop it, with a note saying why). " +
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
        "<li>A grayed change is already decided. A bright change still needs you.</li>" +
        "<li>Press <kbd>?</kbd> for the keyboard shortcuts.</li>" +
        "</ul>";
    }

    return {
      name: "gogpt",
      cards_key: "plants",
      words: {card: "plant", cards: "plants", line: "change", lines: "changes"},
      searchPlaceholder: "plant name / GEM id / unit",
      pidTip: "click to copy the GEM plant id",
      references: true,
      // the vocabularies: the built page's tracker block (TrackerConfig.page_block) wins for calls and note rules, so the watch-item calls stay in step with review_app/checklist.py WATCH_CALLS; these are the fallbacks
      line_kinds: ["fill", "change", "delete", "plant", "reverified", "new_row"],
      item_kinds: ["concern", "monitor", "entity", "other"],
      item_calls: TB.item_calls || {concern: ["confirmed", "dismissed", "needs_research"], monitor: ["add_to_database", "hold", "possible_updates", "remove"]},
      other_calls: TB.other_calls || ["noted", "todo", "dismissed"],
      note_required: TB.note_required || ["monitor:remove"],
      kind_label: KIND_LABEL,
      kind_tip: KIND_TIP,
      kindLabel: function (o, KL) { return o.kind === "monitor" ? (MONITOR_LABEL[o.monitor_kind] || KL.monitor) : (KL[o.kind] || o.kind); },
      kindTip: function (o, KT) { return o.kind === "monitor" ? KT[o.monitor_kind] || "" : KT[o.kind] || ""; },
      call_label: {add_to_database: "incorporate into database", hold: "hold", possible_updates: "send to possible updates", remove: "remove from watchlist", needs_research: "needs research"},
      call_help: {add_to_database: "this belongs in GEM now: the researcher turns it into a full edit (a new row or a change) for the next batch",
                  hold: "not sure yet, leave it on the watchlist", possible_updates: "goes on the possible-updates sheet for a later cycle",
                  remove: "take it off the watchlist for good; say why in the note"},
      call_hint: {concern: "confirmed: the concern stands and goes into the evidence file. dismissed: closed, nothing to do. needs research: back to the researcher for another pass",
                  monitor: "incorporate into database: this belongs in GEM now, the researcher writes it up as a full edit. hold: keep watching. send to possible updates: park it on the possible-updates sheet for a later cycle. remove from watchlist: drop it, with a note saying why",
                  other: "noted: seen. todo: to do later. dismissed: closed"},
      sev_tip: {major: "major change: a cell value moves. A blank is filled, a value is changed or cleared, a plant-wide field is set, or a row is added"},
      tier_tip: TIER_TIP,
      hideFields: ["gem_unit_id", "unit_name", "group", "group_label", "checks", "monitor_kind", "pm_flag", "pm_note", "pm_by", "duplicate_of", "concern_type_raw", "plant_name"],
      itemFacets: ["group"],
      store: {flag: "/api/flag"},
      QK: {decision: "d", kind: "k", group: "g", tier: "t", dir: "dir", column: "col", q: "q", country: "c", state: "st", by: "by", status: "status", pm: "pm"},

      slots: {
        "filters": '<label><span data-tip="the country and state this page covers; pick one state to see only its plants">where</span> <select id="f-where"></select></label>' +
          '<label data-after="f-kind"><span data-tip="the group of the GOGPT QC/Country checklist every change and item is sorted into; pick one to see everything in it, decided or not">checklist</span> <select id="f-group"></select></label>' +
          '<label class="check" data-after="f-tier" data-tip="everything flagged with the ask-the-PM box, whatever its decision"><input type="checkbox" id="f-pm"> ask the PM</label>',
        "filters-more": '<label class="check" data-tip="plants whose Status is changed by a staged edit"><input type="checkbox" id="f-status"> status changes only</label>'
      },

      // ---- filters ----
      defaults: function () { return {group: "", country: "", state: "", status: false, pm: false}; },
      // items (questions, watch items, entity checks) sit beside the edits whenever a checklist group or the ask-the-PM filter is on
      itemsInView: function (fs) { return !!(fs.group || fs.pm); },
      match: function (o, p, fs, skip) {
        var item = !!o._item;
        if (skip !== "group" && fs.group && groupOf(o) !== fs.group) return false;
        if (fs.pm && !flagged(o, p)) return false;
        if (fs.status && (item || o.column !== "Status")) return false;
        if (skip !== "where" && fs.country && (p.country !== fs.country || (fs.state && p.state !== fs.state))) return false;
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
        renderWhere();
        var groups = D().groups || [], gids = groups.map(function (g) { return String(g.id); }), gl = {};
        groups.forEach(function (g) { gl[String(g.id)] = (g.id === "other" ? "" : g.id + " · ") + g.label; });
        if (gids.indexOf("other") < 0 && A.LINES.concat(A.ITEMS).some(function (o) { return groupOf(o) === "other"; })) { gids.push("other"); gl.other = "other"; }
        A.facetSelect("f-group", "group", gids, gl);
      },
      selectFilters: ["group"],
      initFilters: function () {
        $("f-status").onchange = function () { FS().status = this.checked; A.changed(); };
        // "ask the PM" matches flagged lines and items whatever their decision: drop the undecided-only default
        $("f-pm").onchange = function () { FS().pm = this.checked; if (FS().pm && FS().decision === "undecided") FS().decision = ""; A.changed(); };
        $("f-where").onchange = function () {
          var i = this.value.indexOf("|");
          FS().country = i < 0 ? "" : this.value.slice(0, i);
          FS().state = i < 0 ? "" : this.value.slice(i + 1);
          A.changed();
        };
      },
      syncControls: function () {
        var fs = FS();
        // a route from before the where picker (several ticked states) or for a place not on the page falls back to the whole page
        if (!whereOptions().some(function (o) { return o.v === whereValue(); })) { fs.country = ""; fs.state = ""; }
        $("f-where").value = whereValue();
        $("f-status").checked = fs.status;
        $("f-pm").checked = fs.pm;
      },
      activeChips: function (chipFn, when) {
        var fs = FS();
        if (when === "before") {
          if (fs.group) chipFn("group", "checklist: " + groupLabel(fs.group), false);
          if (fs.pm) chipFn("pm", "ask the PM", false);
        } else if (fs.status) chipFn("status", "status changes only", true);
      },
      progressNote: function () { var pm = pmCount(); return pm ? " &middot; " + pm + " flagged for the PM" : ""; },
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
        (data.groups || []).forEach(function (g) { (g.rows || []).forEach(function (r) { ROW_LABEL[r.row] = r.label; }); });
      },
      prepare: function (p) {
        p.units = p.units || [];
        p._hay = [p.name, p.pid, p.state].concat(p.units.map(function (u) { return u.gem_unit_id + " " + u.unit_name; })).join(" ").toLowerCase();
      },

      // ---- the queue and the checklist pane ----
      renderQueue: function () { if (VIEW !== "checklist") return false; renderChecklist(); return true; },
      queueRow: function (p, i, x) {
        var pm = p._pm ? ' <span class="pm"' + tipAttrs(p._pm + " question" + (p._pm === 1 ? "" : "s") + " for the PM on this plant") + ">PM " + p._pm + "</span>" : "";
        var un = unitNames(p);
        var where = p.statewide ? "statewide" : (p.units.length + " unit" + (p.units.length === 1 ? "" : "s"));
        return '<div class="pname">' + esc(p.name || "(no name)") +
          (un.length ? ' <span class="pseg">' + esc(un[0]) + (un.length > 1 ? " +" + (un.length - 1) : "") + "</span>" : "") + pm +
          '</div><div class="pmeta"><span>' + esc(p.statewide ? p.state : (untracked(p) ? "not in GEM yet" : p.pid)) + " &middot; " + esc(where) +
          '</span><span class="grow"></span>' + x.badge + '</div>' + (x.dots ? '<div class="dots">' + x.dots + "</div>" : "");
      },
      onQueueClick: function (e) {
        var g = e.target.closest("li[data-g]");
        if (g) selectGroup(g.getAttribute("data-g"));
      },

      // ---- lines ----
      lineBody: function (l) {
        if (l.kind === "new_row") return newRowBody(l);
        var h = A.pairTable(A.valueRows(l) + siblingRow(l) + A.refRow(l));
        var facts = [];
        if (l.column === "Status") {
          if ((l.publishers || 0) < 2) facts.push(chip("single source", "single", "fewer than two independent publishers: a status change is green only with two or more. One source makes it yellow"));
          else facts.push(chip(l.publishers + " publishers"));
        }
        if (l.independent) facts.push(chip("second source", "ok", "a second independent source was recorded for this value"));
        return h + (facts.length ? '<div class="facts">' + facts.join(" ") + "</div>" : "");
      },
      lineChips: function (l, base) {
        var chips = [];
        if (l.kind === "new_row") chips.push(chip(A.KIND_LABEL.new_row, "newrow"));
        if (l.kind === "plant") chips.push(chip("plant-wide", "oo", "a plant-level field: the export repeats it on every unit row, so the edit lands on every unit row of this plant"));
        chips = chips.concat(base);
        chips.push(groupChip(l));
        if (l.irp) chips.push(irpChip(l));
        if (l.pm_flag) chips.push(pmChip(l));
        return chips;
      },
      lineTitle: function (l) {
        var pv = l.proposed_values || {};
        return l.kind === "new_row" ? (pv["Plant name"] || pv["Unit name"] || l.unit_name || l.plant_name || "new row") : (l.column || "");
      },
      lineWhere: rowLabel,
      lineControls: function (l) { return pmBox(l, "data-pm", l.key); },
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
          case "concern": return concernHead(it);
          case "monitor": return (it.reason || it.item || "watch this plant") + (it.recheck_by ? " (check again by " + it.recheck_by + ")" : "");
          case "entity": return (it.entity_name || "entity") + (it.role ? " as " + it.role : "");
          default: return it.title || it.kind;
        }
      },
      itemWhere: function (it) { return it.gem_unit_id ? unitText(unitOf(plants()[it._p], it.gem_unit_id), it.gem_unit_id) : "plant"; },
      itemClass: function (it) { return it.kind === "monitor" ? " watch-" + (it.monitor_kind || "existing_plant") : ""; },
      kindClass: function (it) { return it.kind === "monitor" ? "watch" : ""; },
      itemChips: function (it) { return groupChip(it) + (it.irp ? " " + irpChip(it) : "") + (it.pm_flag ? " " + pmChip(it) : ""); },
      itemFacts: function (it) {
        if (it.kind !== "monitor") return "";
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
        label: function (g) { return (g === "other" ? "" : "checklist " + g + ": ") + groupLabel(g); }
      },

      // ---- the card ----
      cardContext: function (p) {
        return [p.statewide && "<b>statewide notes, not one plant</b>", untracked(p) && !p.statewide && "<b>not in GEM yet: a candidate plant</b>",
                p.state && esc(p.state), p.units.length && p.units.length + " unit" + (p.units.length === 1 ? "" : "s") + " in the export",
                A.tierSummary(p), '<span class="pmplant">' + pmBox(p, "data-pmplant", p.pid) + "</span>"];
      },
      cardSub: function (p) {
        var un = unitNames(p);
        return un.length > 4 ? un.slice(0, 3).join(" / ") + " / +" + (un.length - 3) : un.join(" / ");
      },
      showPid: function (p) { return !(p.statewide || untracked(p)); },
      cardPanel: function (name) { return name === "closeout" ? closeoutHtml() : ""; },
      onCardClick: function (e) {
        var cp = e.target.closest("button[data-copy]");
        if (cp) { var what = cp.getAttribute("data-copy"); A.copyText(closeoutCopy[what] || "", what === "draft" ? "draft copied" : "unit lists copied"); return true; }
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
      routeKey: function (data) { var c = (data && data.scope) || {}; return "review-route:" + [c.country || "", (c.states || []).join(","), c.quarter || ""].join("|"); },
      // the filter state was made before this file registered its keys: start it again with them
      onInit: function () { A.FS = A.defaults(); },
      onBoot: function (data) {
        renderScope();
        setView("plants");        // no checklist tab on the left bar any more
      },
      afterReload: function () { renderScope(); }
    };
  });
})();
