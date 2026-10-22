/* Pipelines extension for the shared review app (gem-review-app). Loads after review_core/web/app.js and registers everything pipelines-only through ReviewApp.define: the severity, fuel and country filters, rival candidates from validity concerns, the status, route and new-row bodies, the owners tab and segment rows, and the refresh-backend and push buttons. */
(function () {
  "use strict";
  if (!window.ReviewApp || !window.ReviewApp.define) return;
  var TB = (window.REVIEW_STATIC || {}).tracker || {};

  // ---- the single-file page's store: the pipelines parts of its checks (a port of the standalone pipelines static_store.js) ----
  if (window.StaticStore && window.StaticStore.extend) {
    // the concerns a line answers: c concern key, res the columns its accept resolves, cand the candidate a rival suggest takes, cols the columns that candidate covers
    var concernsOf = function (e, api) {
      var f = api.packed(e.obj.key);
      if (f && f.x) return f.x.map(function (x) { return {c: x[0], res: x[1] || [], cand: x[2] || "", cols: x[3] || []}; });
      return (e.obj.rivals || []).map(function (r) {
        var cols = Object.keys(r.cols || {}).sort();
        return {c: r.key, res: (r.agrees || []).slice().sort(), cand: cols.length ? String(r.value || "") : "", cols: cols};
      }).filter(function (x) { return x.res.length || x.cand; });
    };
    var coversOf = function (e, api) {
      var f = api.packed(e.obj.key);
      if (f && f.v) return f.v.map(function (x) { return {key: x[0], dir: x[0].substr(0, x[0].indexOf("::")), sheet_row: x[1] == null ? null : x[1], ref_col: x[2] || "", kind: x[3]}; });
      return (e.obj.covers || []).map(function (c) { return {key: c.key, dir: c.dir, sheet_row: c.sheet_row == null ? null : c.sheet_row, ref_col: c.ref_col || "", kind: c.kind}; });
    };
    var lastStamp = {ts: null, batch: ""};
    window.StaticStore.extend({
      // a record carries the sheet row and reference column, as the pipelines log always has
      fields: function (card, obj, grp) {
        var f = obj.record_id ? {record_id: obj.record_id} : {};
        if (grp === "lines") { f.sheet_row = obj.sheet_row == null ? null : obj.sheet_row; f.ref_col = obj.ref_col || obj.column || ""; }
        return f;
      },
      // taking a concern's candidate: recorded as a suggest carrying that candidate
      lineRequest: function (i, r, e, api) {
        var undo = !!(r.undo || r.undecided), rival = (!undo && r.rival) ? api.str(r.rival) : "";
        if (!rival) return r;
        var rv = concernsOf(e, api).filter(function (x) { return x.c === rival && x.cand; })[0];
        if (!rv) throw api.refuse("record " + i + ": " + JSON.stringify(rival) + " is not a concern with a candidate value on " + JSON.stringify(r.key));
        var decision = r.decision || "suggest";
        if (decision !== "suggest") throw api.refuse("record " + i + ": taking a concern's candidate is recorded as suggest, not " + decision);
        var out = {};
        Object.keys(r).forEach(function (k) { out[k] = r[k]; });
        out.decision = "suggest";
        out.suggested_value = api.str(r.suggested_value).trim() || rv.cand;
        out.rival = rival;
        return out;
      },
      // the basis the call was judged against, the rival taken, and one record per covered record (same call, same write)
      lineRecord: function (i, r, e, rec, api) {
        var f = api.packed(e.obj.key) || {}, b = f.b || e.obj.basis;
        if (typeof b === "string" && b) rec.basis = b;
        if (r.rival && !rec.undecided) rec.rival = api.str(r.rival);
        var out = [rec];
        coversOf(e, api).forEach(function (c) {
          var cr = {};
          Object.keys(rec).forEach(function (k) { cr[k] = rec[k]; });
          cr.key = c.key; cr.dir = c.dir; cr.sheet_row = c.sheet_row; cr.ref_col = c.ref_col; cr.kind = c.kind; cr.via = rec.key;
          out.push(cr);
        });
        return out;
      },
      // the concern calls a batch of line decisions owes: an accept dismisses the concerns it resolves, a taken candidate confirms its concern
      extras: function (recs, api) {
        var calls = {}, order = [];
        function put(k, call, cols) { if (!api.has(calls, k)) order.push(k); calls[k] = {call: call, cols: cols}; }
        recs.forEach(function (r) {
          if (r.undecided || r.via) return;
          var e = api.entry(r.key);
          if (!e) return;
          var xs = concernsOf(e, api);
          if (r.decision === "accept") {
            xs.forEach(function (x) {
              if (api.callOf(x.c) || !x.res.length) return;
              var cur = calls[x.c];
              if (cur && cur.call === "confirmed") return;
              var cols = cur ? cur.cols.slice() : [];
              x.res.forEach(function (col) { if (cols.indexOf(col) < 0) cols.push(col); });
              put(x.c, "dismissed", cols);
            });
          } else if (r.decision === "suggest" && r.rival) {
            if (api.callOf(r.rival) === "confirmed") return;
            var rv = xs.filter(function (x) { return x.c === r.rival; })[0];
            put(r.rival, "confirmed", rv ? rv.cols.slice() : []);
          }
        });
        return order.map(function (k) {
          var v = calls[k];
          return {key: k, call: v.call, note: v.call === "dismissed" ? "resolved by accepted " + v.cols.join(", ") + " fill" : "candidate accepted on " + v.cols.join(", ")};
        });
      },
      // every record of one save shares a batch id, and carries the snapshot it was judged against
      stamp: function (r) {
        if (lastStamp.ts !== r.ts) { lastStamp.ts = r.ts; lastStamp.batch = newBatch(); }
        r.batch = lastStamp.batch;
        r.snapshot = window.StaticStore.state.snapshot || "";
        r.origin = "artifact";
      },
      // the log laid over the data: applied, the rival a person took, a call made against other backend cells, and the covered records
      overlay: function (data, last, api) {
        (data.cards || data.pipelines || []).forEach(function (p) {
          (p.lines || []).forEach(function (l) {
            // applied is the latest machine record (config.overlay_extras). The page was built with the whole log and the browser holds part of it, so a machine record here only replaces an older one.
            var m = api.speak(l.key)[1];
            if (m && !(l.applied && Date.parse(l.applied.at) > Date.parse(m.ts))) l.applied = {by: m.reviewer, at: m.ts};
            var rec = last[l.key];
            if (!rec) return;
            var live = rec.undecided ? null : rec;
            l.rival = live && live.decision === "suggest" ? (live.rival || null) : null;
            l.drift = (live && live.basis && l.basis && live.basis !== l.basis) ? {decided_snapshot: live.snapshot || "", decided_basis: live.basis} : null;
            if (l.covers) {
              l.covers.forEach(function (c) { c.decision = l.decision; c.decided_by = l.decided_by; c.decided_at = l.decided_at; });
              l.uncovered = [];
            }
          });
        });
      }
    });
  }
  function newBatch() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var n = Math.random() * 16 | 0;
      return (c === "x" ? n : (n & 3 | 8)).toString(16);
    });
  }

  window.ReviewApp.define(function (A) {
    var $ = A.$, esc = A.esc, chip = A.chip, tipAttrs = A.tipAttrs, blankv = A.blankv, cur = A.cur, S = A.S;
    var timeOf = A.timeOf, tierOf = A.tierOf, tag = A.tag, copyBtn = A.copyBtn, shortLink = A.shortLink, urlLink = A.urlLink, pairTable = A.pairTable;
    function FS() { return A.FS; }
    function D() { return A.D; }
    function toast(m) { A.toast(m); }

    var SEV = ["major", "minor"];
    var MACHINE = {"backend sync": 1, "push": 1};   // not people: their records never count as reviewed
    var INFO = {confirmed: 1};                       // item kinds shown for information only
    var VERB = {accept: "accepted", hold: "held", reject: "rejected", suggest: "suggested"};
    var VERDICT_LABEL = {REVERIFIED: "re-verified"};
    var KIND_LABEL = {ref: "ref", fill: "fill", status: "status", oo: "owners tab", route: "route", new_row: "new row",
                      concern: "concern", routeqc: "route QC", route_suggestion: "route suggestion", monitor: "monitor", flag: "flag",
                      escalation: "escalation", unresolved: "unresolved", confirmed: "confirmed", other: "other"};
    var SEV_TIP = {major: "major change: the data point moves \u2014 a blank is filled, a value is cleared or changed, or this is a status / route / new-row decision",
                   minor: "minor change: the value stays as it is; the line only adds or re-verifies references"};
    // a dataset built before line severity existed parks every line on the major tab; a sticky banner says to rebuild it
    var STALE = "this dataset was built before line severity existed, so every line sits on the major tab. " +
                "Rebuild it: restart the server without --no-build, or republish the dataset for the Google page.";
    var FUELS = ["gas", "oil"];
    var NO_COUNTRY = "(none)";   // FS.country and FS.fuel sentinel: every box unticked, so nothing matches (empty = no filter)
    var CQ = "";                 // the country menu's search text

    // ---- small helpers ----
    function origDir(d) { return String(d || "").split("/").pop(); }
    function sevOf(l) { return l.severity || "major"; }
    // the sheet already holds the line: the snapshot had it (in_backend), push.py wrote it, or the route is in the routes repo with the sheet columns mapped (route_state.py, or the §8 apply's own record)
    function landed(l) { return !!l.in_backend || !!(l.applied && /^(push|routes_repo|apply_route_candidates)$/.test(l.applied.by)); }
    function routeAdded(l) { return l.kind === "route" && !!l.applied && (l.applied.by === "routes_repo" || l.applied.by === "apply_route_candidates"); }
    function addedText(l) {
      var a = l.applied || {};
      return "already added " + String(a.at || "").slice(0, 10) + (a.commit ? " (routes repo commit " + a.commit + ")" : "");
    }
    // a status line whose folded Status [ref] record still says something else: deciding again covers it
    function gap(l) { return !!(cur(l) && l.uncovered && l.uncovered.length); }
    function dimmed(l) { return (A.grayed(l) && !gap(l)) || landed(l); }
    function splitUrls(text) {
      return String(text || "").split(/,\s*(?=https?:\/\/)|\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    function classLabel(v) { return String(v).toLowerCase().replace(/_/g, " "); }
    // distinct non-empty segment names of a pipeline, in sheet order
    function segNames(p) {
      var seen = {};
      return (p.segments || []).map(function (s) { return String(s.segment || "").trim(); })
        .filter(function (n) { if (!n || seen[n]) return false; seen[n] = 1; return true; });
    }
    // a new pipeline card: say whether the sheet already has a pipeline of this name, and link its wiki page
    function existingHtml(ex) {
      var out = (ex.matches || []).map(function (m) {
        return '<b class="warnname">already on the sheet: ' + esc(m.pid) + (m.name ? " " + esc(m.name) : "") + " (row " + esc(m.sheet_row) + ")</b>" +
          (m.wiki ? ' <a href="' + esc(m.wiki) + '" target="_blank" rel="noopener">its wiki ↗</a>' : "");
      });
      if (ex.wiki_staged) out.push('<a href="' + esc(ex.wiki_staged) + '" target="_blank" rel="noopener">staged wiki page ↗</a>');
      return out.length ? out.join(" · ") : "no pipeline of this name on the sheet";
    }
    function parseRows(s) {      // "357-400, 1141" -> [[357,400],[1141,1141]]; null when empty or unreadable
      var out = [];
      String(s || "").replace(/\s*[-–]\s*/g, "-").split(/[,;\s]+/).forEach(function (t) {
        var m = /^(\d+)(?:-(\d+))?$/.exec(t);
        if (m) { var a = +m[1], b = m[2] ? +m[2] : a; out.push([Math.min(a, b), Math.max(a, b)]); }
      });
      return out.length ? out : null;
    }
    var ROWS = {s: null, r: null};
    function rowRanges(s) { if (s !== ROWS.s) { ROWS.s = s; ROWS.r = parseRows(s); } return ROWS.r; }
    function inRows(rows, ranges) {
      return rows.some(function (r) { return ranges.some(function (g) { return r >= g[0] && r <= g[1]; }); });
    }
    // a validity concern no change answers: it names columns, and no line proposes a value on them
    function unanswered(it) {
      return it.kind === "concern" && Object.keys(it.contested || {}).length > 0 && !(it.rival_lines || []).length;
    }
    // concern linking (review_data._attach_rivals): a concern's candidate that differs from the proposal is a rival the reviewer can take instead
    function rivalsOf(l) {
      return (l.rivals || []).filter(function (r) { return r.cols && Object.keys(r.cols).length; });
    }
    function rivalConcern(r) { return A.ITEM_BY_KEY[r.key]; }
    // the rivals still worth offering: the concern has not been dismissed
    function liveRivals(l) {
      return rivalsOf(l).filter(function (r) { var it = rivalConcern(r); return !(it && it.call === "dismissed"); });
    }
    // the open concerns that agree with this line's proposed value on `col` (accepting resolves them)
    function agreesOn(l, col) {
      return (l.rivals || []).filter(function (r) {
        var it = rivalConcern(r);
        return (r.agrees || []).indexOf(col) >= 0 && !(it && it.call);
      });
    }
    function rowLabel(l) {
      if (l.kind === "new_row") return "new row";
      if (l.kind === "oo") {
        return (l.style_only ? l.pid + (l.pipeline_name ? " " + l.pipeline_name : "") + " · " : "") +
          "owners tab row " + (l.sheet_row == null ? "?" : l.sheet_row) +
          (l.tracker_sheet_row ? " (tracker row " + l.tracker_sheet_row + ")" : "");
      }
      return l.sheet_row == null ? "row not in snapshot" : "row " + l.sheet_row;
    }
    function segRow(l) { return l.tracker_sheet_row || l.sheet_row; }
    // the machine record that followed a person's call: a push wrote the line, or a refresh found it in the sheet
    function appliedText(l) {
      var a = l.applied;
      if (!a) return "";
      if (routeAdded(l)) return " · " + addedText(l);
      return a.by === "push" ? " · written to the sheet " + timeOf(a.at) : " · in backend " + timeOf(a.at);
    }
    function decisionText(l) {
      if (l.reviewed && l.decision === "suggest") {
        return (l.rival ? "concern's candidate taken: " : "suggested: ") + (blankv(l.suggested_value) ? "(note only)" : l.suggested_value) + " by " + (l.decided_by || "?") + " " + timeOf(l.decided_at) +
          (blankv(l.decision_note) ? "" : " \u2014 " + l.decision_note);
      }
      if (l.reviewed && l.decision) return (VERB[l.decision] || l.decision) + " by " + (l.decided_by || "?") + " " + timeOf(l.decided_at) +
        (gap(l) ? " \u2014 made before the Status [ref] record joined this card: press " + l.decision + " again to cover it" : "") + appliedText(l);
      if (l.decision && l.decided_by === "backend sync") return "in backend (synced by backend sync, not reviewed)";
      if (l.decision && l.decided_by === "push") return "written to the sheet by push " + timeOf(l.decided_at) + " (the accept it wrote was undone or re-keyed since)";
      if (l.decision && l.decided_by) return "pre-filled by " + l.decided_by + " (not reviewed)";
      if (routeAdded(l)) return addedText(l) + ": nothing to decide";
      return "";
    }

    // ---- country and fuel ----
    function countryStatus() { return (D().scope && D().scope.country_status) || []; }
    function hiddenCountries() { return countryStatus().filter(function (c) { return c.hidden; }).map(function (c) { return c.country; }); }
    // the tracker-wide scope is the country "*" (owner-style stores: one card per spelling)
    function cname(k) { return k === "*" ? "tracker-wide (owner spellings)" : k; }
    function countries() {
      var hid = hiddenCountries();
      return ((D().scope && D().scope.countries) || []).filter(function (c) { return hid.indexOf(c) < 0; });
    }
    // the batch countries as checkboxes (any ticked country matches; none ticked = every country), each with its live count under the other filters
    function renderCountries() {
      var box = $("f-country"), all = countries(), hid = hiddenCountries(), fs = FS();
      renderFuel();
      renderScope();
      box.hidden = all.length < 2 && !hid.length;
      if (box.hidden) return;
      var q = fs.q.trim().toLowerCase(), c = {};
      all.forEach(function (k) { c[k] = 0; });
      A.cards().forEach(function (p) {
        var n = 0;
        p.lines.forEach(function (l) { if (A.match(l, p, fs, "country", q)) n++; });
        p.items.forEach(function (it) { if (A.match(it, p, fs, "country", q)) n++; });
        p._countries.forEach(function (k) { if (k in c) c[k] += n; });
      });
      var was = box.querySelector("details"), open = was && was.open, n = fs.country.length;
      box.innerHTML = '<details class="cdrop"' + (open ? " open" : "") + '><summary>country</summary><div class="cmenu"><input type="search" class="csearch" placeholder="find a country" value="' + esc(CQ) + '"><button type="button" class="ctoggle"></button>' + all.map(function (k) {
        return '<label class="check"><input type="checkbox" value="' + esc(k) + '"' + (!n || fs.country.indexOf(k) >= 0 ? " checked" : "") +
          "> " + esc(cname(k)) + " (" + c[k] + ")</label>";
      }).join("") + "</div></details>" + (hid.length ? '<span class="cdone" title="every change and asked item in these countries has a decision, so the build left them out (review_data.py --include-done shows them)">all decided, hidden: ' +
        esc(hid.map(cname).join(", ")) + "</span>" : "");
      filterCountryMenu();
    }
    // fuel: the same checkbox dropdown (none ticked = no filter in the data model, all ticked = same thing)
    function renderFuel() {
      var box = $("f-fuel"), was = box.querySelector("details"), open = was && was.open, fs = FS(), n = fs.fuel.length;
      box.innerHTML = '<details class="cdrop fdrop"' + (open ? " open" : "") + '><summary>fuel</summary><div class="cmenu">' +
        FUELS.map(function (k) {
          return '<label class="check"><input type="checkbox" value="' + k + '"' + (!n || fs.fuel.indexOf(k) >= 0 ? " checked" : "") + "> " + k + "</label>";
        }).join("") + "</div></details>";
    }
    // header: the ticked fuels as boxes, then every batch country, alphabetical; countries the filter leaves out are grayed, and a click ticks or unticks that country
    function renderScope() {
      var d = D(), fs = FS(), list = countries().slice();
      if (!list.length && d.scope && d.scope.country) list = [d.scope.country];
      list.sort(function (a, b) { return cname(a).localeCompare(cname(b)); });
      var on = function (sel, k) { return !sel.length || sel.indexOf(k) >= 0; };
      $("scope").innerHTML = FUELS.filter(function (k) { return on(fs.fuel, k); }).map(function (k) {
        return '<span class="cbox fbox" data-tip="fuel filter: ' + k + ' pipelines">' + k + "</span>";
      }).join("") + list.map(function (k) {
        return '<span class="cbox' + (on(fs.country, k) ? "" : " off") + '" data-kind="country" data-v="' + esc(k) + '" data-tip="country filter: ' + esc(cname(k)) + ' pipelines (' + A.cards().filter(function (p) { return p._countries.indexOf(k) >= 0; }).length + ' in this batch; click to ' + (on(fs.country, k) ? "remove" : "add") + ')">' + esc(cname(k)) + "</span>";
      }).join("");
    }
    function toggleScope(e) {
      var b = e.target.closest && e.target.closest(".cbox[data-kind=country]");
      if (!b) return;
      var fs = FS(), v = b.getAttribute("data-v"), all = countries();
      var sel = fs.country.length ? all.filter(function (k) { return fs.country.indexOf(k) >= 0; }) : all.slice();
      sel = sel.indexOf(v) >= 0 ? sel.filter(function (k) { return k !== v; }) : sel.concat([v]);
      fs.country = sel.length === all.length ? [] : sel.length ? sel : [NO_COUNTRY];
      A.changed();
    }
    // the select-all button acts on the countries the search leaves visible
    function toggleLabel() {
      var b = document.querySelector("#f-country .ctoggle"); if (!b) return;
      var boxes = Array.prototype.slice.call(document.querySelectorAll("#f-country .cmenu label:not([hidden]) input"));
      b.textContent = boxes.length && boxes.every(function (i) { return i.checked; }) ? "deselect all" : "select all";
    }
    function toggleCountries() {
      var fs = FS(), all = countries(), sel = fs.country.length ? all.filter(function (k) { return fs.country.indexOf(k) >= 0; }) : all.slice();
      var vis = Array.prototype.map.call(document.querySelectorAll("#f-country .cmenu label:not([hidden]) input"), function (i) { return i.value; });
      var allOn = vis.length && vis.every(function (k) { return sel.indexOf(k) >= 0; });
      sel = allOn ? sel.filter(function (k) { return vis.indexOf(k) < 0; }) : sel.concat(vis.filter(function (k) { return sel.indexOf(k) < 0; }));
      fs.country = sel.length === all.length ? [] : sel.length ? sel : [NO_COUNTRY];
      A.changed();
    }
    function filterCountryMenu() {
      var q = CQ.trim().toLowerCase();
      Array.prototype.forEach.call(document.querySelectorAll("#f-country .cmenu label"), function (l) {
        l.hidden = !!q && l.textContent.toLowerCase().indexOf(q) < 0;
      });
      toggleLabel();
    }

    // ---- line bodies ----
    var CONCERN_BODY = ["recommendation", "action", "detail", "summary", "researcher_notes", "staged_note"];   // review_data._CONCERN_BODY
    function concernText(it) {
      for (var i = 0; i < CONCERN_BODY.length; i++) {
        var t = it[CONCERN_BODY[i]];
        if (typeof t === "string" && t.trim()) return t.length > 240 ? t.slice(0, 240) + "\u2026" : t;
      }
      return "";
    }
    // context under a value row: the open validity concerns on `col` that the line's own chips do not already answer
    function concernNote(p, col, l) {
      var covered = {};
      ((l && l.rivals) || []).forEach(function (r) { if ((col in (r.cols || {})) || (r.agrees || []).indexOf(col) >= 0) covered[r.key] = 1; });
      var open = (p._cont[col] || []).filter(function (it) { return !covered[it.key] && !it.call; });
      var h = "";
      if (l && agreesOn(l, col).length) h += '<div class="concern-inline">a validity concern offers this same value: accepting dismisses it</div>';
      open.forEach(function (it) {
        var cand = (it.contested || {})[col], t = concernText(it);
        h += '<div class="concern-inline">a validity concern (' + esc(it.concern_type || "concern") + ") also questions this cell" +
          (cand ? ", offering " + esc(cand) : "") + (t ? ": " + esc(t) : "") + " · it stays an item to call</div>";
      });
      return h;
    }
    // the rival rows under a value row: the concern's candidate on `c`, then its reasoning
    function rivalRows(l, c) {
      return rivalsOf(l).filter(function (r) { return c in r.cols; }).map(function (r) {
        var it = rivalConcern(r), done = it && it.call === "dismissed";
        var why = [r.concern_type ? "concern (" + r.concern_type + ")" : "concern", r.text].filter(Boolean).join(": ");
        var refs = (r.refs || []).map(shortLink).join(" ");
        return '<tr class="rival' + (done ? " done" : "") + '"><td class="f">concern candidate</td><td></td><td><span class="newv c-rival">' + esc(r.cols[c]) + "</span>" + copyBtn(r.cols[c]) + "</td>" +
          '<td class="t">' + tag("rival") + "</td></tr>" +
          '<tr class="note rival"><td></td><td colspan="3"><div class="concern-inline">' + esc(why) + (refs ? " &middot; " + refs : "") +
          (done ? " &middot; dismissed" : "") + "</div></td></tr>";
      }).join("");
    }
    // one value row: field | now | proposed | tag. has=false means context only (not proposed).
    function valueRow(l, p, c, was, now, has) {
      var wasH = blankv(was) ? "" : "<span>" + esc(was) + "</span>";
      var nowH, t = "", same = false;
      if (!has || (!blankv(was) && String(was).trim() === String(now).trim())) { nowH = wasH; same = true; }
      else if (blankv(now)) { nowH = '<span class="newv c-' + tierOf(l) + '">(clear)</span>'; t = "clear"; }
      else { t = blankv(was) ? "fill" : "change"; nowH = '<span class="newv c-' + tierOf(l) + '">' + esc(now) + "</span>" + copyBtn(now); }
      var r = '<tr class="' + (same ? "same" : "") + '"><td class="f">' + esc(c) + "</td><td>" + wasH + "</td><td>" + nowH + '</td><td class="t">' + tag(t) + "</td></tr>";
      if (c in p._cont) { var cn = concernNote(p, c, l); if (cn) r += '<tr class="note"><td></td><td colspan="3">' + cn + "</td></tr>"; }
      if (has) r += rivalRows(l, c);
      return r;
    }
    function valueRows(l, p, skipCol) {
      var pv = l.proposed_values || {}, cols = Object.keys(pv), now = l.current || {}, ctx = false;
      if (!cols.length) {          // nothing proposed: the current values this [ref] covers, for context
        cols = (l.value_cols || []).filter(function (c) { return !blankv(now[c]); }).slice(0, 8);
        ctx = true;
      }
      return cols.map(function (c) {
        if (c === skipCol) return "";
        if (!ctx && blankv(pv[c]) && blankv(now[c])) return "";
        return valueRow(l, p, c, now[c], pv[c], !ctx);
      }).join("");
    }
    // the [ref] row: the cell now, and the cell it would be (new URLs tinted with a check mark, kept ones muted)
    function refRow(l) {
      var col = l.ref_col || "[ref]";
      var was = splitUrls(l.current_ref), prop = l.proposed_refs || [];
      var cell = l.ref_cell_text ? splitUrls(l.ref_cell_text) : prop.slice();
      var nowH = was.length ? "<ul>" + was.map(function (u) {
        return '<li class="' + (cell.length && cell.indexOf(u) < 0 ? "dropped" : "") + '">' + shortLink(u) + "</li>";
      }).join("") + "</ul>" : "";
      var propH, t;
      if (l.kind === "status" && l.class_out === "STALE" && !cell.length) { propH = '<span class="muted">none (stale-status flag)</span>'; t = ""; }
      else if (!cell.length) {
        propH = '<span class="muted">' + esc({DEAD_LINK: "link gone (404/410), no replacement found", REF_BLOCKED: "could not be fetched from here, no replacement found", REF_UNSUPPORTED: "page loads but does not support the value"}[l.class_out] || "no URL proposed") + "</span>";
        t = "";
      } else {
        var added = cell.filter(function (u) { return was.indexOf(u) < 0; });
        var dropped = was.filter(function (u) { return cell.indexOf(u) < 0; });
        t = !was.length ? "fill" : (dropped.length ? (added.length ? "replace" : "drop") : (added.length ? "add" : ""));
        if (l.class_out === "REVERIFIED" && !added.length && !dropped.length) t = "re-verified";
        propH = !added.length && !dropped.length ? "<ul>" + cell.map(function (u) { return '<li class="kept">' + shortLink(u) + "</li>"; }).join("") + "</ul>"
          : "<ul>" + cell.map(function (u) {
            var isNew = was.indexOf(u) < 0;
            return isNew ? '<li><span class="newref c-' + tierOf(l) + '">' + shortLink(u) + "</span>" + copyBtn(u) + " " + vmark(u, l) + "</li>"
                         : '<li class="kept">' + shortLink(u) + "</li>";
          }).join("") + "</ul>";
      }
      return '<tr class="ref"><td class="f">' + esc(col) + "</td><td>" + nowH + "</td><td>" + propH + '</td><td class="t">' + tag(t) + "</td></tr>";
    }
    function lineCols(l) {
      var c = l.column || "";
      if (l.kind === "status") return "Status";
      if (l.kind === "route") return "Route";
      return String(l.ref_col || c).replace(/\s*\[ref\]$/, "") || c;
    }
    function lineBody(l, p) {
      if (l.kind === "new_row") return newRowBody(l);
      if (l.kind === "route") return routeBody(l, p);
      if (l.kind === "status") return statusBody(l, p);
      return pairTable(valueRows(l, p) + refRow(l));   // ref, fill, oo
    }
    function statusBody(l, p) {
      var cs = l.current_status || "", ps = l.proposed_status || "";
      var rows = valueRow(l, p, "Status", cs, ps, !blankv(ps)) + valueRows(l, p, "Status") + refRow(l);
      var facts = [];
      if (l.evidence_date) facts.push(chip("evidence " + l.evidence_date));
      if (l.class_out === "STALE") facts.push(chip("stale flag", "warn"));
      if (l.publishers < 2) facts.push(chip("single source", "single", "fewer than 2 distinct publishers: a status change stays green only on 2+ (rule 4)"));
      else facts.push(chip(l.publishers + " publishers"));
      return pairTable(rows) + '<div class="facts">' + facts.join(" ") + "</div>";
    }
    function geoPath(l) { return l.geometry_file ? "/geo/" + encodeURI(String(l.dir).replace(/^batches\//, "") + "/" + l.geometry_file) : ""; }
    // the candidate as a file: the loopback server serves it at /geo/; the single-file page saves it from the dataset (Store.saveFile)
    function geoDownload(l) {
      var name = String(l.geometry_file || "").split("/").pop();
      if (A.Store.saveFile) return l.geo && l.geo.candidate ? '<button type="button" class="ghost" data-geosave="' + esc(l.key) + '">download geojson</button> <code>' + esc(name) + "</code>" : "";
      var geo = geoPath(l);
      return geo ? '<a href="' + esc(geo) + '" download="' + esc(name) + '">download geojson</a> <code>' + esc(name) + "</code>" : "";
    }
    function routeBody(l) {
      var dl = geoDownload(l);
      var was = l.current_route_accuracy, sug = l.suggested_route_accuracy;
      var g = l.geo || {}, pair = !!(g.candidate && g.current && !routeAdded(l));
      var rows = [
        ["current route length", pair && g.current_length_km != null ? g.current_length_km + " km" : ""],
        ["candidate length", l.length_km == null ? "" : l.length_km + " km"],
        ["sheet length", l.sheet_length_km == null ? "" : l.sheet_length_km + " km"],
        ["ratio", l.length_ratio == null ? "" : String(l.length_ratio)]
      ].filter(function (r) { return r[1] !== ""; }).map(function (r) { return '<div class="k">' + r[0] + '</div><div class="v">' + esc(r[1]) + "</div>"; });
      rows.push('<div class="k">RouteAccuracy</div><div class="v">' + (blankv(was) ? "" : '<span class="was">' + esc(was) + "</span>") +
        (blankv(sug) ? "" : '<span class="arrow">→</span><span class="newv">' + esc(sug) + "</span>" + copyBtn(sug)) + "</div>");
      rows.push('<div class="k">QC</div><div class="v">' + (l.qc_passed ? chip("✓ passed", "ok") : chip("✗ did not pass", "bad")) + "</div>");
      rows.push('<div class="k">geometry</div><div class="v">' + (dl || '<span class="muted">none</span>') + "</div>");
      // a route GEM already maps: the one it has and the candidate side by side (plan step 3)
      var map = !g.candidate || !window.ReviewGeo ? "" : pair ? window.ReviewGeo.pairSlot(l.key, g, {currentLabel: "now (routes repo)"})
        : window.ReviewGeo.mapSlot(l.key, g, {show: "candidate", label: "proposed"});
      var warn = l.route_disagree ? '<div class="dtxt warn-txt"><span class="k">route and sheet disagree:</span> ' + esc(l.route_disagree) + "</div>" : "";
      var foot = routeAdded(l) ? addedText(l) + "; the sheet's route columns say mapped." : pair ? "accepting records approval for the §8 apply with --replace; it writes no cell." : "accepting records approval for the §8 apply; it writes no cell.";
      return map + warn + '<div class="chg">' + rows.join("") + '</div><div class="faint" style="margin-top:4px">' + esc(foot) + "</div>";
    }
    function newRowBody(l) {
      var vals = l.proposed_values || {}, refs = l.proposed_refs || {};
      var tr = Object.keys(vals).filter(function (c) { return !blankv(vals[c]); }).map(function (c) {
        return "<tr><td>" + esc(c) + "</td><td>" + esc(vals[c]) + copyBtn(vals[c]) + "</td></tr>";
      });
      Object.keys(refs).forEach(function (c) {
        var us = Array.isArray(refs[c]) ? refs[c] : [refs[c]];
        if (!us.length) return;
        tr.push("<tr><td>" + esc(c) + "</td><td>" + us.map(function (u) { return urlLink(u) + copyBtn(u); }).join("<br>") + "</td></tr>");
      });
      var h = l["class"] === "matched_existing"
        ? '<div class="row1">' + chip("matches existing " + (l.matched_project_id || ""), "newrow") + ' <span class="faint">candidate data for a pipeline already tracked</span></div>' : "";
      return h + '<table class="rowdata">' + tr.join("") + "</table>";
    }
    // how the route or value was made: the paragraph, the facts, the map pictures and the control points (plan, "Geo")
    function provenanceHtml(pv) {
      var G = window.ReviewGeo, h = "";
      if (pv.text) h += '<p class="rprov">' + esc(pv.text) + "</p>";
      var facts = (pv.facts || []).filter(function (f) { return f && f.length >= 2; });
      if (facts.length) h += '<table class="rfacts"><tbody>' + facts.map(function (f) {
        var v = f[2] && /^https?:\/\//i.test(f[2]) ? '<a href="' + esc(f[2]) + '" target="_blank" rel="noopener">' + esc(f[1]) + "</a>" : esc(f[1]);
        return "<tr><th>" + esc(f[0]) + "</th><td>" + v + "</td></tr>";
      }).join("") + "</tbody></table>";
      if (G && G.imageBlock) h += G.imageBlock(pv.images || []);
      if (G && G.controlPointTable) h += G.controlPointTable(pv.control_points || []);
      return h;
    }
    function detailsHtml(l) {
      var d = [];
      if (l.provenance) d.push(provenanceHtml(l.provenance));
      if (l.notes) d.push('<div class="dtxt"><span class="k">researcher notes:</span> ' + esc(l.notes) + "</div>");
      (l.verifications || []).forEach(function (v) {
        if (v.note) d.push('<div class="dtxt"><span class="k">' + esc(v.url) + ":</span> " + esc(v.note) + "</div>");
      });
      (l.covers || []).forEach(function (c) {
        if (c.notes) d.push('<div class="dtxt"><span class="k">researcher notes (' + esc(c.ref_col || "refs") + " record):</span> " + esc(c.notes) + "</div>");
        (c.verifications || []).forEach(function (v) {
          d.push('<div class="dtxt"><span class="k">' + esc(v.url) + " (" + esc(c.ref_col || "refs") + " record):</span> " + esc(v.note) + "</div>");
        });
      });
      if (l.staleness_rule) d.push('<div class="dtxt"><span class="k">staleness rule:</span> ' + esc(l.staleness_rule) + "</div>");
      (l.covers || []).forEach(function (c) {
        d.push('<div class="dtxt"><span class="k">also decides:</span> the refs-leg record for ' + esc(c.ref_col || "Status [ref]") + " (" +
          esc(A.KIND_LABEL[c.kind] || c.kind) + " · " + esc(c.class_out || "?") + (c.dir !== l.dir ? " · " + esc(origDir(c.dir)) : "") +
          (c.tier && c.tier !== l.tier ? " · its confidence " + esc(c.tier) : "") + "); its refs are in the table</div>");
      });
      var misc = ["batch " + origDir(l.dir), "class " + (l.class_in || "?") + " → " + (l.class_out || "?"),
                  "default " + (l["default"] || "hold"),
                  "link live: " + (l.link_live == null ? "unknown" : l.link_live)];
      if (l.source_language) misc.push("lang " + l.source_language);
      if (l.also_in && l.also_in.length) misc.push("also in " + l.also_in.map(origDir).join(", "));
      if (l.kind === "oo") misc.push("owners tab row " + l.sheet_row + (l.tracker_sheet_row ? ", tracker row " + l.tracker_sheet_row : ""));
      d.push('<div class="dtxt"><span class="k">record:</span> ' + esc(misc.join(" · ")) + "</div>");
      return '<details data-more><summary>' + (l.provenance ? "how this route was made, notes &amp; record" : "notes &amp; record") + '</summary>' + d.join("") + "</details>";
    }
    // "major · fill", "major · status, change", "minor · refs only", "minor · re-verified"
    function sevChip(l) {
      if (!l.severity) return chip("severity unknown", "", "this line was staged before severity existed in the dataset: rebuild it (see the banner)");
      var s = sevOf(l), ops = (l.ops || []).filter(function (o) { return o !== "refs"; });
      var what = ops.length ? ops.join(", ").replace("new_row", "new row") : (VERDICT_LABEL[l.class_out] || "refs only");
      return chip(s + " · " + what, s, SEV_TIP[s]);
    }
    // one mark per proposed URL: ✓ when it loads, states the value and names the pipeline; else the failed checks
    function vmark(u, l) {
      var v = null;
      (l.verifications || []).forEach(function (x) { if (x.url === u) v = x; });
      if (!v) return chip("unchecked", "", "no verification record for this URL: url_verifier did not check it at staging, so whether it loads, states the value or names the pipeline is unknown");
      var bad = [];
      if (!v.ok) bad.push("load");
      if (!v.contains_value) bad.push("value");
      if (!v.name_found) bad.push("name");
      var tip = "URL verifier checks:\n" +
        (v.ok ? "✓" : "✗") + " loads: the page fetched and its text is readable\n" +
        (v.contains_value ? "✓" : "✗") + " states value: the proposed value (or a unit equivalent) is on the page\n" +
        (v.name_found ? "✓" : "✗") + " names pipeline: the pipeline's name is on the page";
      return bad.length ? chip("✗ " + bad.join(", "), "bad", tip, v.note) : chip("✓", "ok", tip, v.note);
    }

    // ---- items ----
    var BODY = ["recommendation", "action", "detail", "summary", "monitor_reason", "researcher_notes", "staged_note", "staleness_rule", "corridor_desc"];
    var CONCERN_ISSUE = {existence: "its existence is in doubt", duplicate: "it may duplicate another row",
                         classification: "its classification may be wrong", attribution: "its owner / operator attribution may be wrong",
                         spec: "a spec value (capacity, length, diameter, dates) may be off",
                         ref_unverified: "a recorded reference could not be checked against the value: a person should open it"};
    function concernHead(it) {
      var issue = CONCERN_ISSUE[it.concern_type], v = it.verdict || "";
      if (!issue) return (it.concern_type || "concern") + (v ? " \u2014 " + v : "");
      if (/^confirmed/.test(v)) return "pipeline is real, but " + issue;
      return "open doubt: " + issue;
    }
    function itemHead(it) {
      switch (it.kind) {
        case "concern": return concernHead(it);
        case "confirmed": return (it.ref_col && it.ref_col.indexOf("__") !== 0 ? it.ref_col : "existence / status") + (it.verdict ? " \u2014 " + it.verdict : "");
        case "unresolved": return (it.primary_value_col || it.ref_col || "") + " unresolved";
        case "routeqc": return (it.check || "route QC") + (it.severity ? " (" + it.severity + ")" : "");
        case "route_suggestion": return "route " + (it.class_out === "ROUTE_PARTIAL" ? "partial" : "suggested");
        case "monitor": return it.name || "monitor";
        case "flag": return it.check || "flag";
        case "escalation": return it.title || "escalation";
        default: return (it.ref_col || "") + " " + (it.class_in || "") + " → " + (it.class_out || "");
      }
    }
    // the item body, then the contested columns and the changes that carry this concern's candidate
    function itemBody(it) {
      var h = "", used = {};
      if (it.kind === "routeqc" && (it.measured || it.expected)) {
        h += '<div class="body">measured: ' + esc(it.measured || "") + " &middot; expected: " + esc(it.expected || "") + "</div>";
        used.measured = used.expected = 1;
      }
      if (it.kind === "route_suggestion") {
        h += '<div class="body">' + esc(it.start_name || "?") + " → " + esc(it.end_name || "?") + "</div>";
        used.start_name = used.end_name = 1;
      }
      var src = null;
      BODY.forEach(function (k) { if (!src && !blankv(it[k]) && typeof it[k] === "string") src = k; });
      if (src) {
        var t = it[src], cut = t.length > 500;
        h += '<div class="body">' + esc(cut ? t.slice(0, 500) + "\u2026" : t) + "</div>";
        if (!cut) used[src] = 1;
      }
      var cont = it.contested || {};
      Object.keys(cont).forEach(function (c) {
        h += '<div class="concern-inline">' + chip("contested", "cont") + " <b>" + esc(c) + "</b>: " + (cont[c] ? esc(cont[c]) : "<i>no detail recorded</i>") + "</div>";
        // a candidate the owner styler holds (two owners, a slash, a near-match spelling): no accept-candidate button, say why
        if ((it.held_candidates || {})[c]) h += '<div class="faint">not offered as a candidate: ' + esc(it.held_candidates[c]) + " Use suggest to enter the right value: two owners, the accurate one, or the team's spelling.</div>";
      });
      if (it.held_candidates) used.held_candidates = 1;
      (it.rival_lines || []).forEach(function (k) {
        var l = A.LINE_BY_KEY[k];
        if (!l) return;
        var taken = l.reviewed && l.decision === "suggest" && l.rival === it.key;
        var who = l.decided_by ? " by " + l.decided_by + " " + timeOf(l.decided_at) : "";
        h += '<div class="faint">' + (taken ? "candidate accepted on the " + esc(lineCols(l)) + " change" + esc(who)
          : "also a candidate on the " + esc(lineCols(l)) + " change (" + esc(rowLabel(l)) + ")" +
            (l.reviewed && l.decision ? ", " + esc((VERB[l.decision] || l.decision) + who) : "")) + "</div>";
      });
      return {html: h, used: used};
    }

    // ---- records ----
    // the concern calls a line save wrote alongside (dismissed when the accepted value resolves the concern, confirmed when its candidate was taken)
    function concernToast(saved) {
      var calls = (saved || []).filter(function (r) { return "call" in r; });
      if (!calls.length) return;
      var by = {};
      calls.forEach(function (r) { by[r.call] = (by[r.call] || 0) + 1; });
      toast(Object.keys(by).map(function (c) { return by[c] + " concern" + (by[c] === 1 ? "" : "s") + " " + c.replace("_", " "); }).join(", ") + " in the same save");
    }
    // take a concern's candidate instead of the proposal: a suggest with that value plus a confirmed call on the concern, in one save
    function acceptCandidate(l, rk, advance) {
      if (S.tab === "items") return toast("the Items tab takes calls, not change decisions: press i to go back to the changes");
      if (!l) return;
      var rivals = liveRivals(l);
      if (!rivals.length) return toast("no concern offers a different value on this change");
      if (!rk) {
        if (rivals.length > 1) return toast("two concerns offer candidates here: click the one to take");
        rk = rivals[0].key;
      }
      A.dropNoteSave();
      A.save(l, {key: l.key, decision: "suggest", rival: rk, note: A.noteBox(l) ? A.noteOf(l) : ""}, advance);
    }

    // ---- refresh backend ----
    function refreshBackend() {
      var Store = A.Store;
      if (!Store.caps.refresh) return toast("this server cannot refresh the backend (started with --no-build)");
      var dlg = $("dialog");
      dlg.setAttribute("data-kind", "refresh");
      dlg.innerHTML = "<h3>refresh backend</h3><p>this pulls the live sheet (read-only, about a minute), rebuilds this dataset from the new snapshot, " +
        "and marks changes the sheet already holds as <i>in backend</i> (a machine record, not a review). your decisions are kept.</p>" +
        '<p class="faint" id="rf-err"></p><div class="actions"><button type="button" class="ghost" id="dlg-cancel">cancel</button><button type="button" id="dlg-ok">pull and rebuild</button></div>';
      $("dlg-cancel").onclick = function () { dlg.close(); };
      $("dlg-ok").onclick = function () {
        var ok = $("dlg-ok"); ok.disabled = true; ok.textContent = "pulling\u2026"; $("dlg-cancel").disabled = true;
        var btn = $("sync"); btn.disabled = true;
        Store.refresh().then(function (r) {
          return Store.load().then(function (data) {
            dlg.close();
            A.reload(data);
            toast("refreshed: snapshot " + r.snapshot + ", " + r.lines + " changes, " + r.synced + " newly in backend");
          });
        }).catch(function (e) {
          ok.disabled = false; ok.textContent = "retry"; $("dlg-cancel").disabled = false;
          $("rf-err").textContent = "refresh failed: " + e.message; $("rf-err").className = "err";
        }).then(function () { btn.disabled = !Store.caps.refresh; });
      };
      dlg.showModal();
    }
    // ---- push accepted changes to the backend sheet (plan, show every cell, confirm, write) ----
    function pushChanges() {
      var Store = A.Store;
      if (!Store.caps.push || !Store.pushPlan) return toast("this page cannot push to the backend sheet");
      var dlg = $("dialog"), btn = $("push");
      dlg.setAttribute("data-kind", "push");
      dlg.innerHTML = "<h3>push changes</h3><p>reading your accepted changes and the live sheet (read-only, a minute or so)\u2026</p>" +
        '<p class="faint" id="pu-err"></p><div class="actions"><button type="button" class="ghost" id="dlg-cancel">cancel</button></div>';
      $("dlg-cancel").onclick = function () { dlg.close(); };
      btn.disabled = true;
      dlg.showModal();
      Store.pushPlan().then(function (pl) {
        var n = pl.cells.length;
        if (!n) {
          dlg.innerHTML = "<h3>push changes</h3><p>nothing to push: no accepted change is waiting." +
            (pl.skipped.length ? " " + pl.skipped.length + " accepted change(s) were skipped (" + pl.stale + " stale)." : "") +
            '</p><div class="actions"><button type="button" id="dlg-close">close</button></div>';
          $("dlg-close").onclick = function () { dlg.close(); };
          return;
        }
        var nrep = pl.cells.filter(function (c) { return c.replaces; }).length;
        var rows = pl.cells.map(function (c) {
          return "<tr" + (c.replaces ? ' class="replaces" title="this cell holds the value the reviewer saw; the accepted change replaces it"' : "") + "><td>" + esc(c.ProjectID) + "</td><td>" + esc(c.column) + (c.replaces ? " <b>replaces</b>" : "") + "</td><td>" + esc(c.cell) + "</td><td>" + esc(String(c.before).slice(0, 60)) +
            "</td><td>" + esc(String(c.after).slice(0, 140)) + "</td></tr>";
        }).join("");
        dlg.innerHTML = "<h3>push " + n + " cell" + (n === 1 ? "" : "s") + " to the backend sheet</h3>" +
          "<p>this writes to the <b>live</b> sheet. a backup of the old values is saved first, and every cell is read back after. " +
          "refs are added to a cell, never replacing what is there." + (nrep ? " <b>" + nrep + " cell" + (nrep === 1 ? "" : "s") + " replace a value</b> the reviewer saw and accepted a change to." : "") + "</p>" +
          (pl.skipped.length ? '<p class="faint">' + pl.skipped.length + " accepted change(s) skipped" + (pl.stale ? " (" + pl.stale + " stale: the sheet changed since they were decided)" : "") + ".</p>" : "") +
          '<div style="max-height:45vh;overflow:auto"><table class="sum"><thead><tr><th>project</th><th>column</th><th>cell</th><th>now</th><th>will be</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
          '<p class="faint" id="pu-err"></p><div class="actions"><button type="button" class="ghost" id="dlg-cancel">cancel</button><button type="button" id="dlg-ok">write ' + n + " cell" + (n === 1 ? "" : "s") + "</button></div>";
        $("dlg-cancel").onclick = function () { dlg.close(); };
        $("dlg-ok").onclick = function () {
          var ok = $("dlg-ok"); ok.disabled = true; ok.textContent = "writing\u2026"; $("dlg-cancel").disabled = true; dlg.dataset.busy = "1";
          Store.push(pl.token).then(function (r) {
            return Store.load().then(function (data) {
              dlg.close();
              A.reload(data);
              toast("pushed " + r.cells + " cell" + (r.cells === 1 ? "" : "s") + " to the backend sheet" +
                    (r.refresh_error ? " (backend refresh failed: " + r.refresh_error + ")" : r.refreshed ? "; backend refreshed" : ""));
            });
          }).then(function (x) { delete dlg.dataset.busy; return x; }, function (e) { delete dlg.dataset.busy; throw e; }).catch(function (e) {
            ok.disabled = true; ok.textContent = "not written"; $("dlg-cancel").disabled = false;
            $("pu-err").textContent = "push failed: " + e.message; $("pu-err").className = "err";
          });
        };
      }).catch(function (e) {
        $("pu-err").textContent = "could not plan the push: " + e.message; $("pu-err").className = "err";
      }).then(function () { btn.disabled = false; });
    }
    // live drift check (gas.js liveCheck): lines whose watched backend cells differ from the published ones
    function setLive(res) {
      var hit = {};
      ((res && res.changed) || []).forEach(function (c) { if (c.cols.length) hit[c.t + "|" + c.pid + "|" + c.row] = c.cols; });
      var n = 0;
      A.cards().forEach(function (p) {
        p.lines.forEach(function (l) {
          l.live = null;
          if (l.kind === "new_row" || l.sheet_row == null) return;
          var cols = hit[(l.tab === "operators_owners" ? "oo" : "tracker") + "|" + (l.pid || p.pid) + "|" + l.sheet_row];
          if (!cols) return;
          var mine = (l.value_cols || []).concat(l.ref_col ? [l.ref_col] : [], l.current_status !== undefined ? ["Status"] : [],
                                                 l.current_route_accuracy !== undefined ? ["RouteAccuracy"] : []);
          var diff = cols.filter(function (c) { return mine.indexOf(c[0]) >= 0; });
          if (diff.length) { l.live = diff; n++; }
        });
      });
      return n;
    }
    function staleCheck() {
      if (A.LINES.some(function (l) { return !l.severity; })) A.setSticky(STALE);
      else if (A.STICKY === STALE) A.setSticky("");
    }

    var HELP = [["j / k", "next / previous change still to decide (runs on into the next pipeline)"], ["K", "previous change, including ones you just decided"], ["J", "next pipeline"],
                ["a / h / r", "accept / hold / reject the change; saved at once, then on to the next open change"], ["c", "accept the concern's candidate instead of the proposal (a suggest with that value; the concern is confirmed in the same save)"], ["s", "suggest a different value: inline form on the change (value + note; enter saves, esc cancels); routed to an update worklist by update_seed.py"],
                ["i", "switch the card between changes and items; calls save on change"],
                ["u", "undo: the change goes back to undecided"], ["o", "open the change's first ref (new tab)"], ["d", "show / hide the change's details"],
                ["/", "search"], ["?", "this help"]];
    // "how to": a plain-language page on what the app shows and what each call does; the README holds the detail
    var INFO_HTML =
      "<h3>how this works</h3>" +
      "<p>This app shows <b>proposed changes</b> to the GEM pipeline backend sheet (GOIT oil, GGIT gas). " +
      "Nothing here is in the backend yet. Your job is to say yes or no to each one.</p>" +
      "<h4>what you see</h4>" +
      "<ul>" +
      "<li><b>Left list:</b> pipelines with something to decide. Click one to open it.</li>" +
      "<li><b>Card:</b> that pipeline's proposed <b>changes</b>, one per cell. Each change shows the cell as it is <b>now</b> and the <b>proposed</b> value, " +
      "plus the source links (refs) that back it.</li>" +
      "<li><b>Major / minor:</b> a <b>major change</b> moves a data point: it fills a blank, clears a value the sources do not support, changes a value, " +
      "or is a status, route or new-row decision. A <b>minor change</b> leaves the value exactly as it is and only adds (or re-checks) source links. " +
      "The card opens on the major changes; the minor ones have their own tab and an <b>accept all minor changes</b> button.</li>" +
      "<li><b>Color:</b> green means well sourced, yellow means one source or partial, and red means weak. Green changes default to accept; the rest default to hold.</li>" +
      "<li><b>Items</b> tab: concerns and notes the researcher raised. They take a call and a note, but they never write to the sheet.</li>" +
      "</ul>" +
      "<h4>your four calls</h4>" +
      "<ul>" +
      "<li><b>accept:</b> yes, put this into the backend.</li>" +
      "<li><b>hold:</b> not sure yet, leave it open.</li>" +
      "<li><b>reject:</b> no, do not apply this.</li>" +
      "<li><b>suggest:</b> something else is right, so type the value or a note. It goes to a research to-do list, not into the sheet.</li>" +
      "</ul>" +
      "<h4>what happens when you accept</h4>" +
      "<ol>" +
      "<li>Your click is saved at once in the decision log. The backend sheet is <b>not</b> touched at that moment.</li>" +
      "<li>Later, a <b>push</b> takes every accepted change and writes it into the backend sheet, cell by cell.</li>" +
      "<li>A new ref is <b>added next to</b> the refs already in the cell. It never replaces one.</li>" +
      "<li>A value goes in only if the cell still looks like the <b>now</b> side. If the sheet changed since you decided, the change is flagged and skipped until someone re-checks it.</li>" +
      "</ol>" +
      "<p>So an accept means it will be in the database. A hold or a reject means it will not.</p>" +
      "<h4>good to know</h4>" +
      "<ul>" +
      "<li><b>Undo:</b> click the pressed button again, or press <kbd>u</kbd>. Nothing is deleted; the log just records the undo.</li>" +
      "<li>A <b>rival candidate</b> means a concern on this pipeline proposes a different value for the same cell. It is shown under the proposal. " +
      "<b>accept</b> takes the proposal and closes the concern, while <b>accept candidate</b> takes the concern's value instead (it goes to the research list, like a suggest) and confirms the concern.</li>" +
      "<li>A grayed change is already decided or already in the backend. A bright change still needs you.</li>" +
      "<li>Press <kbd>?</kbd> for the keyboard shortcuts.</li>" +
      "</ul>";

    var CONF = "confidence level (rule 4)";
    return {
      name: "pipelines",
      cards_key: "pipelines",
      words: {card: "pipeline", cards: "pipelines", line: "change", lines: "changes"},
      searchPlaceholder: "name / project id / country",
      pidTip: "click to copy the ProjectID",
      references: false,
      suggestRef: false,
      progressItems: false,
      // the vocabularies: the built page's tracker block (TrackerConfig.page_block) wins where it has them
      line_kinds: TB.line_kinds || ["ref", "fill", "status", "oo", "route", "new_row"],
      item_kinds: TB.item_kinds || ["concern", "routeqc", "route_suggestion", "monitor", "flag", "escalation", "unresolved", "confirmed", "other"],
      item_calls: TB.item_calls || {concern: ["confirmed", "dismissed", "needs_research"]},
      other_calls: TB.other_calls || ["noted", "todo", "dismissed"],
      info_kinds: TB.info_kinds || ["confirmed"],
      kind_label: KIND_LABEL,
      call_help: {confirmed: "the concern stands", dismissed: "the concern is closed", needs_research: "goes to a research / update worklist",
                  noted: "seen, nothing to do", todo: "to do later"},
      call_hint: {concern: "confirmed: it stands; dismissed: closed; needs research: to an Update worklist. A concern with a candidate on a change is also answered from that change: accept the proposal dismisses it, accept candidate confirms it",
                  other: ""},
      sev_tip: SEV_TIP,
      tier_tip: {high: CONF, medium: CONF, low: CONF},
      hideFields: ["decision_note", "also_in", "sheet_row", "sheet_row_moved", "contested", "default", "rivals", "rival_lines", "rival",
                   "project_id", "wiki", "pipeline_name", "segment_name", "value_cols", "values", "primary_value_col", "primary_value", "countries"],
      QK: {decision: "d", kind: "k", severity: "sev", tier: "t", class_out: "c", dir: "dir", column: "col", q: "q",
           contested: "cont", owners: "owners", country: "cty", fuel: "fuel", by: "by", drift: "drift"},
      routeEmpty: "all",
      expose: {setLive: setLive},

      slots: {
        "header-buttons": '<button id="sync" class="ghost" hidden>&#8635; refresh backend</button><button id="push" class="ghost" hidden data-tip="write the accepted changes into the backend sheet">&#8682; push changes</button>',
        "filters": '<span id="f-fuel" class="countries" role="group" aria-label="fuel"></span><span id="f-country" class="countries" role="group" aria-label="country" hidden></span>' +
          '<label data-after="f-kind" data-tip="major: the data point moves (fill, clear, change, status, route, new row); minor: the value stands and only references are added">severity <select id="f-severity"></select></label>',
        "filters-more": '<label data-before="f-column">class <select id="f-class_out"><option value="">any</option></select></label>' +
          '<label class="check" data-tip="decided changes whose backend cells have changed since the call was made"><input type="checkbox" id="f-drift" aria-description="decided changes whose backend cells have changed since the call was made"> sheet changed since decided</label>' +
          '<label class="check" data-tip="validity concerns no change answers: nothing is proposed on the columns they question (selects the concern kind)"><input type="checkbox" id="f-contested" aria-description="validity concerns no change answers: nothing is proposed on the columns they question"> unanswered concerns</label>' +
          '<label class="check"><input type="checkbox" id="f-owners"> owners tab</label>'
      },

      onInit: function () {
        // the second filter row of the original page: "more filters" and "reset"
        var first = document.querySelector(".filters .row2"), r2 = document.createElement("div");
        r2.className = "row2";
        r2.appendChild($("f-more"));
        r2.appendChild($("f-reset"));
        first.parentNode.insertBefore(r2, first.nextSibling);
        // the loopback server's refresh and push routes; the Google page and the single-file page bring their own (or none)
        var St = A.Store;
        if (!window.GasStore && !window.StaticStore && St._json) {
          if (!St.refresh) St.refresh = function () {
            if (!St.caps.refresh) return Promise.reject(new Error("this server cannot refresh the backend (started with --no-build)"));
            return fetch("/api/refresh", {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"}).then(St._json);
          };
          if (!St.pushPlan) St.pushPlan = function () {
            return fetch("/api/push/plan", {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"}).then(St._json);
          };
          if (!St.push) St.push = function (token) {
            return fetch("/api/push", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({token: token})}).then(St._json);
          };
        }
        $("sync").onclick = refreshBackend;
        $("push").onclick = pushChanges;
        A.FS = A.defaults();
        document.addEventListener("click", function (e) {
          Array.prototype.forEach.call(document.querySelectorAll("#f-country details, #f-fuel details"), function (d) {
            if (d.open && !d.contains(e.target)) d.open = false;
          });
        });
      },

      // ---- filters ----
      defaults: function () {
        return {severity: "", class_out: "", row: "", contested: false, owners: false, country: [], fuel: ["gas"], drift: false};
      },
      prepare: function (p) {
        // column -> the validity concerns naming it (context under a value row)
        p._cont = {};
        p.items.forEach(function (it) {
          if (it.kind === "concern") Object.keys(it.contested || {}).forEach(function (col) { (p._cont[col] = p._cont[col] || []).push(it); });
        });
        p.lines.forEach(function (l) { l._rows = [l.sheet_row, l.tracker_sheet_row].filter(function (x) { return x != null; }); });
        var segs = p.segments || [];
        p._hay = [p.name, p.pid, p.country, p.status].concat(segs.map(function (s) { return s.sheet_row + " " + s.segment; }))
          .concat(p.name_card ? p.lines.map(function (l) { return l.pid + " " + (l.pipeline_name || "") + " " + (l.countries || ""); })
            .concat(p.name_card.aliases || [], p.name_card.entity_id || [], p.name_card.basis || []) : [])
          .join(" ").toLowerCase();
        p._rows = segs.map(function (s) { return s.sheet_row; });
        p._countries = p.scope_countries || [];
        p._commodity = p.commodity || (D().scope || {}).commodity;
      },
      match: function (o, p, fs, skip) {
        var item = !!o._item;
        if (item && INFO[o.kind]) return false;
        // (a landed line is left out of the undecided view by the core, through `counted` below)
        if (skip !== "severity" && fs.severity && (item || sevOf(o) !== fs.severity)) return false;
        if (fs.class_out && o.class_out !== fs.class_out) return false;
        if (fs.contested && !(item && unanswered(o))) return false;
        if (fs.owners && (item || o.kind !== "oo")) return false;
        if (fs.drift && (item || !(o.drift || o.live))) return false;
        if (fs.row) {
          var ranges = rowRanges(fs.row);
          if (!ranges) return false;
          if (!inRows(item ? (o.sheet_row != null ? [o.sheet_row] : []) : o._rows, ranges)) return false;
        }
        var cty = fs.country || [], fuel = fs.fuel || [];
        if (skip !== "country" && cty.length && !p._countries.some(function (c) { return cty.indexOf(c) >= 0; })) return false;
        if (fuel.length && p._commodity !== "both" && fuel.indexOf(p._commodity) < 0) return false;
        return true;
      },
      facetVal: function (o, facet) { return facet === "severity" ? sevOf(o) : o[facet]; },
      renderChips: function () {
        renderCountries();
        A.facetSelect("f-severity", "severity", SEV, A.SEV_LABEL);
      },
      fillFilters: function () {
        // only values some listed record carries: info items (confirmed) are never listed, so their classes and batches stay out
        var listed = A.LINES.concat(A.ITEMS.filter(function (i) { return !INFO[i.kind]; }));
        function fill(id, values, label) {
          var s = $(id);
          s.innerHTML = '<option value="">any</option>';
          values.forEach(function (v) { var o = document.createElement("option"); o.value = v; o.textContent = label(v); s.appendChild(o); });
          A.fitSelect(s);
        }
        fill("f-class_out", A.uniq(listed.map(function (l) { return l.class_out; })), classLabel);
        fill("f-dir", (D().dirs || []).filter(function (d) { return listed.some(function (o) { return o.dir === d; }); }), origDir);
      },
      selectFilters: ["severity", "class_out"],
      initFilters: function () {
        // "unanswered concerns" is an item filter: it selects the concern kind, and clears when the kind leaves
        $("f-kind").onchange = function () {
          var fs = FS();
          fs.kind = this.value;
          if (fs.kind !== "concern") { fs.contested = false; $("f-contested").checked = false; }
          A.changed();
        };
        $("f-owners").onchange = function () { FS().owners = this.checked; A.changed(); };
        $("f-contested").onchange = function () { var fs = FS(); fs.contested = this.checked; if (fs.contested) fs.kind = "concern"; A.changed(); };
        $("scope").onclick = toggleScope;
        $("f-fuel").onchange = function () {
          var fs = FS();
          fs.fuel = Array.prototype.map.call(this.querySelectorAll("input:checked"), function (i) { return i.value; });
          if (fs.fuel.length === FUELS.length) fs.fuel = [];
          else if (!fs.fuel.length) fs.fuel = [NO_COUNTRY];   // nothing ticked: nothing matches
          A.changed();
        };
        $("f-country").onclick = function (e) { if (e.target.classList.contains("ctoggle")) { e.stopPropagation(); toggleCountries(); } };
        $("f-country").oninput = function (e) {
          if (e.target.classList.contains("csearch")) { CQ = e.target.value; filterCountryMenu(); }
        };
        $("f-country").onchange = function (e) {
          if (e.target.classList.contains("csearch")) return;
          var fs = FS();
          fs.country = Array.prototype.map.call(this.querySelectorAll("input[type=checkbox]:checked"), function (i) { return i.value; });
          if (fs.country.length === this.querySelectorAll("input[type=checkbox]").length) fs.country = [];
          else if (!fs.country.length) fs.country = [NO_COUNTRY];   // all ticked = no filter
          A.changed();
        };
        // "sheet changed" only ever matches decided lines: leave the undecided-only default
        $("f-drift").onchange = function () { var fs = FS(); fs.drift = this.checked; if (fs.drift && fs.decision === "undecided") fs.decision = ""; A.changed(); };
      },
      syncControls: function () {
        var fs = FS(), s = $("f-class_out");
        s.value = fs.class_out;
        if (s.value !== fs.class_out) { fs.class_out = ""; s.value = ""; }
        ["contested", "owners", "drift"].forEach(function (f) { $("f-" + f).checked = fs[f]; });
      },
      activeChips: function (add, where) {
        var fs = FS();
        if (where === "before") {
          if (fs.class_out) add("class_out", "class: " + classLabel(fs.class_out), true);
          return;
        }
        if (fs.drift) add("drift", "sheet changed since decided", true);
        if (fs.contested) add("contested", "unanswered concerns", true);
        if (fs.owners) add("owners", "owners tab", true);
      },
      // lines the sheet already holds are not waiting on a call (progress and tab counts); the decision filter (default undecided) hides them like any decided line
      counted: function (l) { return !landed(l); },
      routeArray: function (f, vs) {
        return vs.filter(function (c) { return c === NO_COUNTRY || (f === "fuel" ? FUELS : countries()).indexOf(c) >= 0; });
      },
      // the route is also kept in this browser, per scope (same key as the standalone pipelines app, so saved routes carry over)
      routeKey: function (d) { return "review-route:" + (d && d.scope ? [d.scope.id || "", d.scope.country || "", d.scope.commodity || ""].join("|") : ""); },

      // ---- queue and card ----
      queueRow: function (p, i, x) {
        var rows = (p.segments || []).map(function (s) { return s.sheet_row; }).filter(function (r) { return r != null; });
        var where = p.pid.indexOf("new:") === 0 ? "new row" : (p.pid === "scope" ? "scope" :
          (p.name_card ? p.name_card.cells + " cell" + (p.name_card.cells === 1 ? "" : "s") + " on " + p.name_card.pids + " pipeline" + (p.name_card.pids === 1 ? "" : "s") :
          (rows.length ? "row " + rows[0] + (rows.length > 1 ? " +" + (rows.length - 1) : "") : "no row")));
        var ts = p._tsev || {}, parts = SEV.filter(function (s) { return ts[s]; }).map(function (s) { return ts[s] + " " + s; });
        var badge = p._todo ? '<span class="n todo">' + (parts.length ? parts.join(" &middot; ") : p._todo) + " to decide</span>"
          : (p._n ? '<span class="n">' + p._n + " &middot; done</span>" : (p._ni ? '<span class="n">' + p._ni + " item" + (p._ni === 1 ? "" : "s") + "</span>" : '<span class="n"></span>'));
        var sn = segNames(p);
        return '<div class="pname">' + esc(p.name || "(no name)") +
          (sn.length ? ' <span class="pseg">' + esc(sn[0]) + (sn.length > 1 ? " +" + (sn.length - 1) : "") + "</span>" : "") +
          '</div><div class="pmeta"><span>' + esc(p.pid.indexOf("new:") === 0 ? "candidate" : (p.name_card ? "owner spelling" : p.pid)) + " &middot; " + esc(where) +
          '</span><span class="grow"></span>' + badge + "</div>" + (x.dots ? '<div class="dots">' + x.dots + "</div>" : "");
      },
      cardContext: function (p) {
        var isNew = p.pid.indexOf("new:") === 0, isScope = p.pid === "scope", nc = p.name_card;
        return [(isNew || isScope) && "<b>" + esc(isNew ? "new candidate, not in the sheet" : "scope-level") + "</b>",
                nc && "<b>owner spelling, tracker-wide</b>",
                nc && esc(nc.cells + " cell" + (nc.cells === 1 ? "" : "s") + " on " + nc.pids + " pipeline" + (nc.pids === 1 ? "" : "s") + (nc.clears ? ", " + nc.clears + " cleared" : "")),
                nc && nc.basis.length && "basis: " + esc(nc.basis.join(", ")),
                nc && nc.entity_id.length && "entity: " + esc(nc.entity_id.join(", ")),
                nc && nc.aliases.length && "aliases: " + esc(nc.aliases.join(", ")),
                p.country && esc(p.country), p.status && "status: " + esc(p.status),
                p.wiki && '<a href="' + esc(p.wiki) + '" target="_blank" rel="noopener">wiki ↗</a>',
                p.existing && existingHtml(p.existing),
                A.tierSummary(p)];
      },
      cardSub: function (p) {
        if (p.pid.indexOf("new:") !== 0) return segNames(p).join(" / ");
        // a new pipeline card lists its segment name below the title, blank when the candidate has none
        var nr = (p.lines || []).filter(function (l) { return l.kind === "new_row"; })[0];
        var seg = String((nr && nr.proposed_values && nr.proposed_values.SegmentName) || (nr && nr.segment_name) || "").trim();
        return segNames(p).join(" / ") || seg;
      },
      showPid: function (p) { return !(p.pid.indexOf("new:") === 0 || p.pid === "scope" || p.name_card); },
      bulkButtons: function (p) {
        return (function () {
          var minor = p.lines.filter(function (l) { return sevOf(l) === "minor"; });
          var on = minor.some(function (l) { return !cur(l); });
          var why = !minor.length ? "no minor changes on this pipeline" : "every minor change is already decided";
          return '<button type="button" class="bulk b-accept' + (on ? "" : " off") + '" data-bulk="bulk-minor"' + (on ? "" : ' aria-disabled="true" data-why="' + esc(why) + '"') +
            tipAttrs(on ? "accept every undecided minor change on this pipeline (refs only, the values stand; rival candidates left to decide by hand) that the filters show" : why) + ">accept all minor changes</button>";
        })() +
          '<button type="button" class="bulk b-accept" data-bulk="bulk-high"' + tipAttrs("accept every undecided high-confidence change on this pipeline, major or minor (rival candidates left to decide by hand) that the filters show") + ">accept all high-conf changes</button>" +
          (function () {
            var nonHigh = p.lines.filter(function (l) { return tierOf(l) !== "high"; });
            var on = nonHigh.some(function (l) { return !cur(l); });
            var why = !nonHigh.length ? "all suggestions are high-confidence" : "every medium- and low-confidence suggestion is already decided";
            return '<button type="button" class="bulk b-hold' + (on ? "" : " off") + '" data-bulk="bulk-all"' + (on ? "" : ' aria-disabled="true" data-why="' + esc(why) + '"') +
              tipAttrs(on ? "accept every undecided change on this pipeline, any confidence level (rival candidates left to decide by hand) that the filters show" : why) + ">accept all changes</button>";
          })();
      },
      // a line with a live rival candidate is left to decide by hand
      bulkTargets: function (mode, l) { return liveRivals(l).length ? "rival" : null; },
      bulkSkip: {rival: " with a rival candidate (decide those by hand)", uncounted: " already in the backend sheet"},
      // lines grouped by segment when the ProjectID spans several sheet rows
      groupLines: function (p, keep) {
        var segs = p.segments || [];
        if (segs.length <= 1) return null;
        var groups = segs.map(function (s) {
          return {html: "row " + esc(s.sheet_row) + (s.segment ? ' <span class="seg">' + esc(s.segment) + "</span>" : ""),
                  lines: keep.filter(function (l) { return segRow(l) === s.sheet_row; })};
        });
        var rest = keep.filter(function (l) { return !segs.some(function (s) { return s.sheet_row === segRow(l); }); });
        if (rest.length) groups.push({label: "other rows", lines: rest});
        return groups;
      },
      dimmed: dimmed,
      lineClass: function (l) { return (l.kind === "new_row" ? " newcard" : "") + (routeAdded(l) ? " added" : ""); },

      // ---- lines ----
      lineChips: function (l, base) {
        var chips = [], t = tierOf(l);
        if (l.kind === "oo" || l.kind === "new_row") chips.push(chip(KIND_LABEL[l.kind], l.kind === "new_row" ? "newrow" : "oo"));
        chips.push(l.kind === "new_row" ? chip(t === "untiered" ? "unrated" : t, t === "untiered" ? "" : t) : base[0]);
        chips.push(base[1]);
        var rivals = liveRivals(l);
        var agree = (l.rivals || []).filter(function (r) { return r.agrees && r.agrees.length && agreesOn(l, r.agrees[0]).length; });
        if (agree.length) chips.push(chip("concern agrees", "ok", "an open concern's candidate on " + agree.map(function (r) { return r.agrees.join(", "); }).join("; ") + " equals this proposed value; accepting it records a dismissed call on the concern"));
        if (rivals.length) chips.push(chip("rival candidate", "cont", "a validity concern proposes a different value for this cell: take it with accept candidate (c), or accept the proposal and the concern is dismissed"));
        if (l.in_backend) chips.push(chip("in backend", "", "the snapshot already holds this value and these refs"));
        if (routeAdded(l)) chips.push(chip(("already added " + String(l.applied.at || "").slice(0, 10)).trim(), "ok", "this geometry is in the routes repo" + (l.applied.commit ? " (commit " + l.applied.commit + ")" : "") + " and the sheet's route columns say mapped: nothing to decide"));
        if (l.route_disagree) chips.push(chip("route and sheet disagree", "warn", l.route_disagree));
        if (l.applied && l.applied.by === "push") chips.push(chip("pushed " + timeOf(l.applied.at), "ok", "push.py wrote this line to the backend sheet (cells read back after the write); the next backend refresh shows it as in backend"));
        if (l.drift && cur(l)) chips.push(chip("sheet changed since decided", "warn", "the backend cells this call was judged against have changed since (it was decided on " + (l.drift.decided_snapshot || "an earlier snapshot") + "): look again, then press the call again to confirm it against the current sheet"));
        if (l.live) chips.push(chip("sheet changed live", "warn", "the backend sheet, read just now, differs from what this change was judged against: " + l.live.map(function (c) { return c[0] + " was " + (c[1] || "blank") + ", is now " + (c[2] || "blank"); }).join("; ") + ". publish again to rebuild the proposal against the new values"));
        if (l.sheet_row_moved) chips.push(chip("row re-resolved", "", "the record's sheet_row was stale; this is the live row"));
        return chips;
      },
      lineTitle: function (l) { return l.kind === "new_row" ? (l.name || "candidate") : lineCols(l); },
      lineWhere: rowLabel,
      lineButtons: function (l) {
        var dis = !A.Store.caps.decide, rivals = liveRivals(l);
        return rivals.map(function (r) {
          var on = cur(l) === "suggest" && l.rival === r.key;
          return '<button type="button" class="b-candidate" data-candidate="' + esc(r.key) + '"' + (dis ? ' aria-disabled="true"' + tipAttrs(A.NOT_YET)
            : tipAttrs("record the concern's candidate (" + r.value + ") as the suggested value and confirm the concern; it goes to the Update worklist, never straight to the sheet")) +
            ' aria-pressed="' + on + '">accept candidate' + (rivals.length > 1 ? " " + esc(r.value) : "") + "</button>";
        }).join("");
      },
      suggestPressed: function (l) { return cur(l) === "suggest" && !l.rival; },
      decisionText: decisionText,
      lineBody: lineBody,
      lineDetails: detailsHtml,
      sevChip: sevChip,
      vmark: vmark,

      // ---- items ----
      itemHead: itemHead,
      itemBody: itemBody,
      itemClass: function (it) { return Object.keys(it.contested || {}).length ? " conts" : ""; },
      kindClass: function () { return ""; },
      itemChips: function (it) { return it.tier ? A.tierChip(it) : ""; },
      itemWhere: function (it) { return it.sheet_row == null ? "" : "row " + it.sheet_row; },
      hideField: function (k) { return /_norm$/.test(k); },
      fieldLabel: function (k) { return k; },
      // every kind group starts collapsed on a freshly opened pipeline (Baird 2026-10-02)
      openLoneGroup: false,
      groupCount: function (items) { return "(" + items.length + ")"; },

      // ---- records ----
      // machine is given when the page's store chose r by its speaker rules (static_store.js speak): r is then the record that speaks for the line and machine
      // the line's latest machine record, or null. Without it (a save, gas.js) records land one at a time and a machine record is recognized here.
      applyRecord: function (r, l, it, remote, machine) {
        if ("call" in r) {
          if (!it) return false;
          it.call = r.undecided ? null : r.call;
          it.call_note = r.undecided ? null : r.note;
          it.reviewed = !r.undecided && !MACHINE[r.reviewer];
          it.decided_by = r.undecided ? null : r.reviewer;
          it.decided_at = r.undecided ? null : r.ts;
          return true;
        }
        if (!l) return false;
        if (remote && S.pipe >= 0 && l._p === S.pipe) S.stay[r.key] = true;   // lines on the open card stay in view
        if (machine !== undefined) {
          // the store already let a person's live call speak over any machine record; the browser holds only part of the log, so no machine record here leaves applied as built
          if (machine) l.applied = {by: machine.reviewer, at: machine.ts};
        } else if (MACHINE[r.reviewer]) {
          // a machine record (push.py after a write, a backend sync) marks the line applied; a person's standing call keeps speaking for it
          l.applied = {by: r.reviewer, at: r.ts};
          if (l.reviewed) return true;
        }
        l.decision = r.undecided ? null : r.decision;
        l.reviewed = !r.undecided && !MACHINE[r.reviewer];
        l.decided_by = r.undecided ? null : r.reviewer;
        l.decided_at = r.undecided ? null : r.ts;
        l.suggested_value = r.suggested_value || "";
        l.decision_note = r.note || "";
        l.rival = r.undecided ? null : (r.rival || null);
        // a call made against other backend cells than this dataset shows (publish.py `basis`) is marked, never dropped
        l.drift = (!r.undecided && r.basis && l.basis && r.basis !== l.basis) ? {decided_snapshot: r.snapshot || "", decided_basis: r.basis} : null;
        if (l.covers) {          // the server wrote the same call to every covered record
          l.covers.forEach(function (c) { c.decision = l.decision; c.decided_by = l.decided_by; c.decided_at = l.decided_at; });
          l.uncovered = [];
        }
        return true;
      },
      afterSave: concernToast,
      // the note box appears once the line has an accept, hold or reject, or a taken candidate (a suggestion has the note in its own form)
      noteBox: function (l) { var d = cur(l); return d === "accept" || d === "hold" || d === "reject" || (d === "suggest" && !!l.rival); },
      noteRecord: function (l, rec) {
        delete rec.reference;
        if (rec.decision === "suggest" && l.rival) { delete rec.suggested_value; rec.rival = l.rival; }
        return rec;
      },
      suggestPrefill: function (l) {
        if (l.kind === "ref") return l.ref_cell_text || (l.proposed_refs || []).join(", ");
        if (l.kind === "status") return l.proposed_status || "";
        if (l.kind === "fill" || l.kind === "oo") return null;   // the core's rule: the proposed value of the line's column
        if (l.kind === "new_row") return l.name || "";
        return "";
      },
      firstRef: function (l) {
        var refs = l.proposed_refs;
        if (l.kind === "new_row") {
          var out = "";
          Object.keys(refs || {}).forEach(function (c) { if (!out && refs[c] && refs[c].length) out = refs[c][0]; });
          return out;
        }
        if (l.kind === "route") return window.REVIEW_STATIC ? (refs && refs[0]) || "" : geoPath(l);
        return (refs && refs[0]) || splitUrls(l.current_ref)[0] || "";
      },
      openRef: function (u, l) {
        if (l.kind === "route" && A.Store.showGeo) { A.Store.showGeo(l.dir + "/" + l.geometry_file); return true; }
        if (A.Store.open) { A.Store.open(u); return true; }
        return false;
      },
      onCardClick: function (e) {
        var ga = e.target.closest("[data-geo]");
        if (ga) { e.preventDefault(); if (A.Store.showGeo) A.Store.showGeo(ga.getAttribute("data-geo")); return true; }
        var gs = e.target.closest("button[data-geosave]");
        if (gs) {
          var gl = A.LINE_BY_KEY[gs.getAttribute("data-geosave")];
          if (gl && gl.geo) A.Store.saveFile(String(gl.geometry_file || gl.pid + ".geojson").split("/").pop().replace(/\.geojson$/, "") + ".geojson.json",
            JSON.stringify(gl.geo.candidate), "application/geo+json").then(function (n) { A.toast(n + " saved"); }, function (err) { A.toast(err.message); });
          return true;
        }
        var cb = e.target.closest("button[data-candidate]");
        if (!cb) return false;
        var ln = cb.closest(".line");
        if (ln) A.setLine(+ln.getAttribute("data-i"), true);
        if (!A.Store.caps.decide) { A.notYet(); return true; }
        if (cb.getAttribute("aria-pressed") === "true") { A.undoCurrent(); return true; }
        acceptCandidate(A.LINES[S.line], cb.getAttribute("data-candidate"), false);
        return true;
      },

      // ---- keys, help, info ----
      keys: {c: function () { if (S.tab !== "items") acceptCandidate(A.LINES[S.line], null, true); }},
      help: function () { return HELP; },
      info: INFO_HTML,

      // ---- lifecycle ----
      onBoot: function (d) {
        staleCheck();
        renderScope();
        var dirs = d.dirs || [], scope = d.scope || {}, St = A.Store;
        delete document.querySelector(".top h1").dataset.tip;   // core sets a batch-list tip; not useful here
        $("sync").hidden = !St.caps.refresh;          // shipped hidden: the Google page and a --no-build server cannot refresh
        $("sync").dataset.tip = "pull the live sheet (~1 min), rebuild, and mark changes it already holds";
        $("push").hidden = !St.caps.push;
      },
      afterReload: function () { staleCheck(); renderScope(); }
    };
  });
})();
