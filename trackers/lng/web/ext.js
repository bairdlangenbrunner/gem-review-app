/* LNG carriers extension for the shared review app (gem-review-app). Loads after review_core/web/app.js and registers everything LNG-only through ReviewApp.define: vessel cards, the value / ref / new-row lines, the "notes & record" details, the suggest form (kind and refs), Name and Other names as a strict pair, conflict items, the how-to and keyboard text, and the sync and push buttons. The page's store gets the same suggest rules the Python side has through StaticStore.extend. */
(function () {
  "use strict";
  if (!window.ReviewApp || !window.ReviewApp.define) return;
  var TB = (window.REVIEW_STATIC || {}).tracker || {};
  var KINDS = ["value", "cosmetic"];
  var VALUE_KINDS = ["fill", "change", "delete"];      // a line that moves a cell value (the dataset's kind; "ref" and "new_row" are the others)
  var URL_RE = /^https?:\/\/\S+$/;

  function urlList(raw) {
    var out = [];
    (typeof raw === "string" ? raw.split(/[\s,]+/) : (raw || [])).forEach(function (u) {
      u = String(u == null ? "" : u).trim();
      if (u && out.indexOf(u) < 0) out.push(u);
    });
    return out;
  }
  // a suggest replaces a cell value: not on a new row, a ref line or a ref-only line
  function suggestable(l) { return VALUE_KINDS.indexOf(l.kind) >= 0 && (l.flags || []).indexOf("ref_only") < 0; }

  // ---- the single-file page's store: the same suggest rules as trackers/lng/config.py ----
  if (window.StaticStore && window.StaticStore.extend) {
    window.StaticStore.extend({
      lineRequest: function (i, r, e, api) {
        if (r.undo || r.undecided || r.decision !== "suggest") return r;
        if (!suggestable(e.obj)) throw api.refuse("record " + i + ": nothing to suggest on a " + e.obj.kind + " line; accept, hold or reject it");
        var kind = r.suggest_kind || "value";
        if (KINDS.indexOf(kind) < 0) throw api.refuse("record " + i + ": suggest_kind " + JSON.stringify(kind) + " is not one of " + KINDS.join(", "));
        if (!String(r.suggested_value == null ? "" : r.suggested_value).trim()) throw api.refuse("record " + i + ": a suggestion needs a value");
        if (!String(r.note == null ? "" : r.note).trim()) throw api.refuse("record " + i + ": a suggestion needs a note");
        var raw = r.suggested_refs;
        if (raw != null && typeof raw !== "string" && !Array.isArray(raw)) throw api.refuse("record " + i + ": suggested_refs must be a list of URLs");
        var refs = urlList(raw);
        refs.forEach(function (u) { if (!URL_RE.test(u)) throw api.refuse("record " + i + ": suggested ref " + JSON.stringify(u) + " is not an http(s) URL"); });
        var out = {};
        Object.keys(r).forEach(function (k) { out[k] = r[k]; });
        out.suggest_kind = kind;
        out.suggested_refs = refs;
        return out;
      },
      // every line record carries both fields, empty unless it is a suggest
      lineRecord: function (i, r, e, rec) {
        var sug = rec.decision === "suggest" && !rec.undecided;
        rec.suggest_kind = sug ? (r.suggest_kind || "value") : "";
        rec.suggested_refs = sug ? (r.suggested_refs || []).slice() : [];
        return [rec];
      },
      // the log's last suggest per line puts its kind and refs back on the line
      overlay: function (data, last) {
        (data[TB.cards_key || "vessels"] || data.cards || []).forEach(function (p) {
          (p.lines || []).forEach(function (l) {
            var rec = last[l.key], sug = !!(rec && l.reviewed && l.decision === "suggest");
            l.suggest_kind = sug ? (rec.suggest_kind || "value") : "";
            l.suggested_refs = sug ? (rec.suggested_refs || []).slice() : [];
          });
        });
      }
    });
  }

  window.ReviewApp.define(function (A) {
    // the "record issues" link is off for now
    try { var ri = document.getElementById("issues-link"); if (ri) ri.hidden = true; } catch (e) { /* ignore */ }
    var $ = A.$, esc = A.esc, chip = A.chip, blankv = A.blankv;
    var MACHINES = TB.machine_reviewers || ["backend sync", "§5 regrade"];
    var VERB = {accept: "accepted", hold: "held", reject: "rejected", suggest: "suggested"};

    // ---- small helpers ----
    function has(l, f) { return (l.flags || []).indexOf(f) >= 0; }
    function batchOf(dir) {
      var b = ((A.D && A.D.batches) || []).filter(function (x) { return x.dir === dir; })[0];
      return b || {dir: dir, label: dir, apply_order: "?"};
    }
    function rowLabel(p) { return p.new ? "new row" : p.live_row == null ? "row gone" : "row " + p.live_row; }
    function link(u) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + "</a>"; }
    function list(urls) { return urls.map(link).join(", "); }
    function short(v, n) { v = String(v == null ? "" : v); return v.length > n ? v.slice(0, n - 1) + "…" : v; }
    // a record a machine or a directed session write made, not a reviewer's click
    function machineCall(l) {
      return !!(l.reviewed && l.decision && (MACHINES.indexOf(l.decided_by) >= 0 || /^accepted by claude session/i.test(String(l.decision_note || ""))));
    }

    // ---- linked pairs: Name and Other names are decided together; the loose ones are asked about ----
    var STRICT = {"Name": "Other names", "Other names": "Name"};
    var LOOSE = {"Price": "Price currency", "Price currency": "Price", "Capacity": "Capacity units", "Capacity units": "Capacity"};
    function baseCol(c) { return String(c || "").replace(/ \[ref\]$/, ""); }
    function pairKind(a, b) {
      if (!a || !b || a === b) return null;
      if (STRICT[a] === b) return "strict";
      if (LOOSE[a] === b || (baseCol(a) === baseCol(b))) return "loose";
      return null;
    }
    function partnerLines(l) {
      var card = A.cards()[l._p], out = [];
      if (!card || l.kind === "new_row") return out;
      (card.lines || []).forEach(function (x) {
        if (x === l || x.kind === "new_row" || has(x, "in_backend")) return;
        var rel = (l.links || []).indexOf(x.key) >= 0 || (l.row_id && x.row_id === l.row_id);
        var k = rel ? pairKind(l.column, x.column) : null;
        if (k) out.push({line: x, strict: k === "strict"});
      });
      return out;
    }

    // ---- chips ----
    var FLAG_TEXT = {
      preserve_ref: ["cosmetic", "spelling or style only; the cell's [ref] stays"],
      append_ref: ["appends", "added to what the cell already holds, nothing is replaced"],
      ref_only: ["ref only", "adds links; the value is untouched"],
      igu_pdf_only: ["only source: IGU", "the IGU World LNG Report PDF is the sole source"],
      in_backend: ["in the backend", "the sheet already holds this value and its links"],
      value_in_backend: ["value in the backend", "the sheet holds this value, but not every proposed link"],
      applied: ["already applied", "this batch is in the sheet; changing the call does not unapply it"]
    };
    // the same cell proposed by another batch: quiet when the values agree, a warning when they do not
    function overlapChips(l) {
      return (l.links || []).map(function (k) { return A.LINE_BY_KEY[k]; }).filter(function (q) {
        return q && q.column === l.column && q.kind !== "ref" && l.kind !== "ref";
      }).map(function (q) {
        var b = batchOf(q.dir).label;
        return q.proposed === l.proposed ? chip("same value in batch " + b, "", "batch " + b + " proposes the same value for this cell")
          : chip("batch " + b + " differs", "warn", "batch " + b + " proposes “" + short(q.proposed, 80) + "” for this cell; the later batch wins at push");
      });
    }
    // only worth saying once a person has decided the two sides differently
    function pairSplit(l) {
      var d = A.cur(l);
      return !!d && partnerLines(l).some(function (p) { var e = A.cur(p.line); return e && e !== d; });
    }
    function lineChips(l, base) {
      var out = base.slice();
      if (l.derivable) out.push(chip("derived", "", "computed from other cells, no page checked"));
      (l.flags || []).forEach(function (f) {
        if (FLAG_TEXT[f]) out.push(chip(FLAG_TEXT[f][0], f === "applied" ? "warn" : "", FLAG_TEXT[f][1]));
      });
      out = out.concat(overlapChips(l));
      if (pairSplit(l)) out.push(chip("pair split", "warn", "its linked line has a different call"));
      return out;
    }

    // ---- line body ----
    // the same marks the other trackers' links carry (app.js vmark): ✓ when the gate fetched the page and found this vessel's value on it,
    // ✗ when a check failed, "unchecked" when nothing was recorded. A "(URL log)" verdict is the research step's own log of the page,
    // kept per link and not tied to this cell's value, so it gets a neutral "page read" chip, never the ✓. The raw verdict is in the tooltip.
    function verdictChip(r) {
      var v = r.verdict;
      if (v && typeof v === "object") v = v.status || v.reason || "";
      v = String(v || "").trim();
      if (!v) return chip("unchecked", "", "no check recorded for this link: whether it loads or states the value is unknown");
      var log = /\(URL log\)$/i.test(v), raw = "\n\nrecorded: " + v;
      if (/^(FAIL|DROP|REMOVED|dead|banned|blocked)/i.test(v)) {
        var what = /dead|unreachable|blocked|banned|404|403|timeout/i.test(v) ? "load" : "value";
        return chip("✗ " + what, "bad", (what === "load" ? "the page did not load or its source is banned" : "the page loaded but does not state the proposed value for this vessel") + raw);
      }
      if (log) return chip("page read", "", "the research step logged this page as read, but no check tied it to this vessel's value: open it before accepting" + raw);
      if (/^(PASS|OK|verified|✓)/i.test(v)) return chip("✓", "ok", "link checks:\n✓ loads: the page fetched and its text is readable\n✓ states value: the proposed value for this vessel is on the page" + raw);
      return chip("unchecked", "", "the check did not say pass or fail" + raw);
    }
    function row(field, was, now, tag) {
      return '<tr class="' + (tag ? "" : "same") + '"><td class="f">' + esc(field) + "</td><td>" + was + "</td><td>" + now + '</td><td class="t">' + A.tag(tag) + "</td></tr>";
    }
    function valueRow(l) {
      var was = l.current, now = l.proposed, same = !blankv(was) && String(was).trim() === String(now).trim(), t, nowH;
      if (same) { nowH = esc(now); t = ""; }
      else if (blankv(now)) { nowH = '<span class="newv c-' + A.tierOf(l) + '">(clear)</span>'; t = "clear"; }
      else { t = blankv(was) ? "fill" : "change"; nowH = A.newvHtml(was, now, "c-" + A.tierOf(l)) + A.copyBtn(now); }
      return row(l.column, blankv(was) ? "" : "<span>" + esc(was) + "</span>", nowH, t);
    }
    function refRow(l) {
      var col = l.ref_column || "[ref]", curr = l.current_refs || [], prop = l.refs || [];
      var added = prop.filter(function (r) { return curr.indexOf(r.url) < 0; });
      var nowH = curr.length ? "<ul>" + curr.map(function (u) { return "<li>" + A.shortLink(u) + "</li>"; }).join("") + "</ul>" : "";
      var propH, t = "";
      if (!prop.length) propH = curr.length ? "<ul>" + curr.map(function (u) { return '<li class="kept">' + A.shortLink(u) + "</li>"; }).join("") + "</ul>" : '<span class="muted">no link proposed</span>';
      else {
        t = !curr.length ? "fill" : added.length ? "add" : "";
        propH = "<ul>" + curr.map(function (u) { return '<li class="kept">' + A.shortLink(u) + "</li>"; }).join("") +
          added.map(function (r) { return '<li><span class="newref c-' + A.tierOf(l) + '">' + A.shortLink(r.url) + "</span>" + A.copyBtn(r.url) + " " + verdictChip(r) + "</li>"; }).join("") + "</ul>";
      }
      return row(col, nowH, propH, t);
    }
    // a new row's tables, as the pipelines and GOGPT pages draw theirs: every column the candidate has a value for, in the sheet's column order
    // (columns the sheet does not have go last), each value with a copy button; then every "X [ref]" in the same order in one sources table, each link with a copy button and the gate's verdict
    function newRowTable(l) {
      var rd = l.row_data || {}, H = A.D.header || [], byUrl = {};
      (l.refs || []).forEach(function (r) { byUrl[r.url] = r; });
      var cols = H.concat(Object.keys(rd).filter(function (c) { return H.indexOf(c) < 0; })), tr = "", src = [];
      cols.forEach(function (c) {
        if (/ \[ref\]$/.test(c)) return;
        var v = rd[c], refs = String(rd[c + " [ref]"] || "").split(/,\s+|\s*\n\s*|\s+;\s+/).map(function (u) { return u.trim(); }).filter(Boolean);
        if (blankv(v) && !refs.length) return;
        tr += "<tr><td>" + esc(c) + "</td><td>" + (blankv(v) ? '<span class="muted">(blank)</span>' : esc(v) + A.copyBtn(v)) + "</td></tr>";
        if (refs.length) src.push([c + " [ref]", refs]);
      });
      return '<table class="rowdata">' + tr + "</table>" + A.sourcesTable(src, function (u) { return verdictChip(byUrl[u] || {}); });
    }
    function lineBody(l) {
      if (l.kind === "new_row") return (l.cluster_label ? '<div class="dtxt">' + esc(l.cluster_label) + "</div>" : "") + newRowTable(l);
      if (l.kind === "ref" || has(l, "ref_only")) {
        return A.pairTable(row(l.column || "", esc(l.cited_value || l.current || ""), '<span class="muted">value unchanged</span>', "") + refRow(l));
      }
      return A.pairTable(valueRow(l) + refRow(l));
    }
    // the "notes & record" details, in the core's markup (app.js detailsHtml): the researcher's note once, the grade's reason once, the links the cell holds now, and the record line
    function lineDetails(l) {
      var d = [], note = [l.why].concat(l.detail || []).map(function (t) { return String(t || "").trim(); }).filter(Boolean).join("\n");
      if (note) d.push('<div class="dtxt"><span class="k">researcher notes</span>' + A.linkText(note) + "</div>");
      var grade = l.derivable ? "derived from other cells, no page checked" : String(l.confidence_why || "").trim();
      if (grade) d.push('<div class="dtxt"><span class="k">grade</span>' + esc(grade) + "</div>");
      if (l.kind !== "new_row" && (l.current_refs || []).length) d.push('<div class="dtxt"><span class="k">current ' + esc(l.ref_column || "[ref]") + "</span>" + list(l.current_refs) + "</div>");
      var misc = ["batch " + batchOf(l.dir).label, "default " + (l.default || "hold"), "record " + (l.id || "?")];
      d.push('<div class="dtxt"><span class="k">record</span>' + esc(misc.join(" · ")) + "</div>");
      return '<details data-more><summary>notes &amp; record</summary>' + d.join("") + "</details>";
    }
    function decisionText(l) {
      if (l._applied && l.decision === "accept") return "accepted: this batch is already applied to the sheet";
      if (l.reviewed && l.decision === "suggest") {
        var refs = l.suggested_refs || [];
        return "suggested " + (l.suggest_kind || "value") + ": " + (blankv(l.suggested_value) ? "(note only)" : l.suggested_value) + " by " + (l.decided_by || "?") + " " + A.timeOf(l.decided_at) +
          (blankv(l.decision_note) ? "" : ". " + l.decision_note) + (refs.length ? ". refs: " + refs.join(", ") : "");
      }
      // a machine's or a session write's record: its note is the status line, not the reviewer's note box
      if (machineCall(l)) {
        var who = (l.decided_by || "?") + " " + A.timeOf(l.decided_at), note = blankv(l.decision_note) ? "" : String(l.decision_note).trim();
        if (/^accepted by claude session/i.test(note)) return note + " (logged as " + who + ")";
        return (VERB[l.decision] || l.decision) + " by " + who + (note ? ". " + note : "");
      }
      return null;
    }
    function noteBox(l) {
      var d = A.cur(l);
      return (d === "accept" || d === "hold" || d === "reject") && !l._applied && !machineCall(l);
    }

    // ---- suggest: a value and a note are both required, with its kind and the refs that support it ----
    function suggestForm(l, prior) {
      var v = prior ? (l.suggested_value || "") : (l.proposed || ""), kind = prior ? (l.suggest_kind || "value") : "value";
      var refs = prior ? (l.suggested_refs || []) : (l.refs || []).map(function (r) { return r.url; }).filter(Boolean);
      var note = prior ? (l.decision_note || "") : A.noteOf(l);
      return {
        html: '<label class="stack">suggested value<textarea class="lng-sv" rows="3">' + esc(v) + "</textarea></label>" +
          '<fieldset class="stack"><label><input type="radio" name="lng-kind" value="value"' + (kind !== "cosmetic" ? " checked" : "") + "> a different value (its links are checked at push)</label>" +
          '<label><input type="radio" name="lng-kind" value="cosmetic"' + (kind === "cosmetic" ? " checked" : "") + "> spelling or style only (the cell's [ref] stays)</label></fieldset>" +
          '<label class="stack">links for the value, one URL per line<textarea class="lng-sr" rows="3" spellcheck="false" placeholder="https://...">' + esc(refs.join("\n")) + "</textarea></label>" +
          '<label class="stack">note (required)<textarea class="lng-sn" rows="2">' + esc(note) + "</textarea></label>",
        read: function (f) {
          var val = f.querySelector(".lng-sv").value, n = f.querySelector(".lng-sn").value.trim(), urls = urlList(f.querySelector(".lng-sr").value);
          var picked = f.querySelector("input[name=lng-kind]:checked"), k = picked && picked.value ? picked.value : "value";
          if (!val.trim()) return "a suggestion needs a value";
          if (!n) return "a suggestion needs a note";
          if (k === "value" && val.trim() === String(l.proposed || "").trim()) return "that is the proposed value; accept it instead";
          var bad = urls.filter(function (u) { return !URL_RE.test(u); });
          if (bad.length) return "not a URL: " + bad[0];
          return {suggested_value: val, suggest_kind: k, suggested_refs: urls, note: n};
        }
      };
    }

    // ---- kinds and items ----
    var KIND_LABEL = {fill: "fill a blank", change: "change a value", "delete": "clear a value", ref: "source link only", new_row: "new row",
                      conflict: "conflict", flag: "discovery flag", manual: "manual review", proposed_bucket: "proposed row", duplicate: "possible duplicate"};
    var USED = {title: 1, detail: 1, urls: 1, live_rows: 1, row_ids: 1, conflict_index: 1, conflict_match: 1, conflict_decision: 1, backend_resolved: 1, logged_call: 1, pid: 1};
    function itemBody(it) {
      var h = "";
      if (it.detail) h += '<div class="body">' + A.linkText(it.detail) + "</div>";
      if (it.logged_call && it.logged_call !== it.conflict_decision)
        h += '<div class="body">' + chip("the logged call is " + it.logged_call + ", the conflicts file says " + (it.conflict_decision || "nothing") + ": click the call again", "warn",
          "rebuilding the batch reset the conflicts file; clicking the call writes it there again") + "</div>";
      if (it.backend_resolved) h += '<div class="body"><span class="k">backend</span>' + esc(it.backend_resolved) + "</div>";
      if ((it.urls || []).length) h += '<div class="body">' + it.urls.map(function (u) { return A.urlLink(u); }).join("<br>") + "</div>";
      return {html: h, used: USED};
    }

    // ---- the how-to and keyboard text ----
    function help(rows) {
      return rows.filter(function (r) { return r[0] !== "i"; }).map(function (r) {
        if (r[0] === "s") return ["s", "suggest a different value: a form on the change (value, kind, links, note; Cmd/Ctrl+Enter saves, esc cancels)"];
        if (r[0] === "d") return ["d", "show / hide the change's notes and record"];
        return r;
      });
    }
    function info(savedWhere) {
      return "<h3>how this works</h3>" +
        "<p>This page shows the <b>changes a research batch proposes</b> for the LNG carrier tracker's backend sheet. " +
        "Nothing here is in the sheet until it is pushed. Your job is to say yes or no to each change.</p>" +
        "<h4>what you see</h4><ul>" +
        "<li><b>Left list:</b> the vessels with something to decide, each with its sheet row, yard and owner. Click one to open it.</li>" +
        "<li><b>Card:</b> that vessel's proposed changes, one per cell. Each shows the cell as it is <b>now</b>, the <b>proposed</b> value, and the source links that back it. " +
        "A mark on each link says what the automatic check found: <b>✓</b> the page loads and states this value for this vessel, <b>✗ load</b> it did not load, <b>✗ value</b> it loaded but does not state the value, " +
        "<b>page read</b> the researcher read it but no check tied it to this value, <b>unchecked</b> nothing was recorded.</li>" +
        "<li><b>New row:</b> a vessel the sheet does not have yet, with every column the research fills and its sources. It is added by hand, never pushed.</li>" +
        "<li><b>Color:</b> green means a live page states the value for this vessel. Yellow means it is held for a decision: one generic match, an archived page, or a doubt the researcher wrote down. Red means no link passed the check. " +
        "Green starts as accept and the rest as hold, but nothing is written until you click.</li>" +
        "<li><b>Chips:</b> <b>in the backend</b>, the sheet already holds the value and its links. <b>value in the backend</b>, the value is there but a link is not. <b>already applied</b>, the batch was applied to the sheet, so the line shows as accepted. " +
        "<b>cosmetic</b>, spelling or style only and the cell's [ref] stays. <b>appends</b>, added to what the cell holds. <b>only source: IGU</b>, the IGU World LNG Report PDF is the sole source. <b>derived</b>, computed from other cells with no page checked. " +
        "<b>same value in batch N</b> or <b>batch N differs</b>, another batch proposes this cell too; the later batch wins at push.</li>" +
        "<li><b>Filters:</b> decision, kind (fill a blank, change a value, clear a value, source link only, new row) and search sit in the bar at the top. <b>more filters</b> holds column, batch, confidence and decided by, and <b>reset</b> clears them all. " +
        "<b>hide done</b> drops the vessels with nothing left to decide.</li>" +
        "<li><b>Items:</b> conflicts (the research disagrees with a value already in the sheet), discovery flags, manual-review entries and possible duplicates sit at the end of their vessel's card, or on the <b>items with no vessel</b> card. " +
        "A conflict takes accept, hold, reject or resolved; the others take resolved or needs research. Their calls are logged, never pushed.</li>" +
        "</ul><h4>your four calls</h4><ul>" +
        "<li><b>accept:</b> yes, write this to the sheet at the next push.</li>" +
        "<li><b>hold:</b> not sure yet, leave it open.</li>" +
        "<li><b>reject:</b> no, do not write this.</li>" +
        "<li><b>suggest:</b> something else is right. Type the value, say whether it is a different value or spelling and style only, add the links that support it and a note. " +
        "The push lists it with the accepted lines and writes it when a link states the suggested value; otherwise it goes into a fix batch for a researcher.</li>" +
        "</ul><h4>what happens when you accept</h4><ol>" +
        "<li>Your click is saved at once in the decision log" + savedWhere + ". The sheet is <b>not</b> touched at that moment.</li>" +
        "<li><b>push changes</b> in the top bar (on the local server only) lists every cell it would write, by row and column, writes them on one confirmation, and reads each one back. " +
        "On the shared page the calls are saved and brought into the batch later, and the next push counts them.</li>" +
        "<li>A value is written only if the cell is still blank, still <b>unknown</b>, or still what the line set out to correct. If the sheet moved, the line is listed under <b>not pushed</b>.</li>" +
        "<li>A new link is added next to the links already in the cell. A cosmetic suggestion keeps the cell's links.</li>" +
        "</ol><p>So an accept means it will be in the sheet after the next push. A hold or a reject means it will not.</p>" +
        "<h4>good to know</h4><ul>" +
        "<li><b>Name</b> and <b>Other names</b> are decided together: a call on one asks about the other, and the answer is both or neither. Price and Price currency, Capacity and Capacity units, and a value and its [ref] line ask as well.</li>" +
        "<li><b>Undo:</b> click the pressed button again, or press <kbd>u</kbd>. Nothing is deleted; the log records the undo.</li>" +
        "<li><b>sync backend</b> pulls the sheet again, rebuilds the page and marks what the sheet already holds; a held line the sheet now holds becomes an accept by <b>backend sync</b>. Your own calls stay.</li>" +
        "<li>A grayed change is decided or already in the sheet. A bright change still needs you.</li>" +
        "<li>Press <kbd>?</kbd> for the keyboard shortcuts.</li>" +
        "</ul>";
    }

    // ---- sync and push (the loopback server's routes; the single-file page has neither) ----
    function livingNote(l) {
      if (!l) return "";
      if (l.error) return " Living workbook not updated: " + l.error;
      if (!l.written) return " Living workbook already up to date.";
      return " Living workbook: " + l.written + " processed cell" + (l.written === 1 ? "" : "s") + " updated.";
    }
    function refreshBackend() {
      var Store = A.Store;
      if (!Store.caps.refresh) return A.toast("this server cannot refresh the backend");
      var dlg = $("dialog");
      dlg.setAttribute("data-kind", "refresh");
      dlg.innerHTML = "<h3>sync with the backend</h3><p>this pulls the live sheet (read-only), rebuilds the review data from it, accepts the lines the sheet already holds and settles the items it answers. Your own calls are kept.</p>" +
        '<p class="faint" id="rf-err"></p><div class="actions"><button type="button" class="ghost" id="dlg-cancel">cancel</button><button type="button" id="dlg-ok">pull and rebuild</button></div>';
      $("dlg-cancel").onclick = function () { dlg.close(); };
      $("dlg-ok").onclick = function () {
        var ok = $("dlg-ok"), btn = $("sync");
        ok.disabled = true; ok.textContent = "pulling…"; $("dlg-cancel").disabled = true; btn.disabled = true;
        return Store.refresh().then(function (r) {
          return Store.load().then(function (data) {
            dlg.close();
            A.reload(data);
            A.toast("synced: " + (r.accepted || []).length + " lines now in the backend, " + (r.resolved || []).length + " items settled");
          });
        }).catch(function (e) {
          ok.disabled = false; ok.textContent = "retry"; $("dlg-cancel").disabled = false;
          $("rf-err").textContent = "sync failed: " + e.message; $("rf-err").className = "err";
        }).then(function () { btn.disabled = !Store.caps.refresh; });
      };
      dlg.showModal();
    }
    function planTable(ws) {
      var by = {}, order = [];
      ws.forEach(function (w) { if (!by[w.batch]) { by[w.batch] = []; order.push(w.batch); } by[w.batch].push(w); });
      return order.map(function (b) {
        return "<h4>batch " + esc(by[b][0].label || b) + " · " + by[b].length + '</h4><table class="sum"><thead><tr><th>row</th><th>vessel</th><th>column</th><th>now</th><th>will be</th></tr></thead><tbody>' +
          by[b].map(function (w) {
            return "<tr><td>" + esc(w.live_row) + "</td><td>" + esc(w.name) + "</td><td>" + esc(w.column) + (w.suggest ? " " + chip("suggested", "", "a person's suggestion, not the batch's proposal") : "") +
              "</td><td>" + (esc(String(w.old == null ? "" : w.old).slice(0, 80)) || "<i>blank</i>") + "</td><td>" + esc(String(w.new == null ? "" : w.new).slice(0, 140)) + "</td></tr>";
          }).join("") + "</tbody></table>";
      }).join("");
    }
    function pushChanges() {
      var Store = A.Store;
      if (!Store.caps.push || !Store.pushPlan) return A.toast("this page cannot push to the backend sheet");
      var dlg = $("dialog"), btn = $("push"), batch = A.FS.dir || null;
      var scope = batch ? " of batch " + batchOf(batch).label : "";
      dlg.setAttribute("data-kind", "push");
      dlg.innerHTML = "<h3>push changes" + esc(scope) + "</h3><p>reading your calls and the live sheet (read-only)…</p>" +
        '<p class="faint" id="pu-err"></p><div class="actions"><button type="button" class="ghost" id="dlg-cancel">cancel</button></div>';
      $("dlg-cancel").onclick = function () { dlg.close(); };
      btn.disabled = true;
      dlg.showModal();
      Store.pushPlan(batch).then(function (pl) {
        var n = pl.writes.length, m = (pl.applied_writes || []).length, k = (pl.skipped || []).length, u = pl.unclicked || 0;
        var ns = pl.writes.filter(function (w) { return w.suggest; }).length;
        var unclicked = u ? u + " pre-filled accept" + (u === 1 ? "" : "s") + " nobody clicked " + (u === 1 ? "is" : "are") + " not pushed; click accept on a line to push it." : "";
        if (!n && !m) {
          dlg.innerHTML = "<h3>push changes" + esc(scope) + "</h3><p>nothing to push: every line you accepted or suggested is already in the backend." +
            (k ? " " + k + " line" + (k === 1 ? " stays" : "s stay") + " on the by-hand path." : "") + (unclicked ? " " + esc(unclicked) : "") +
            '</p><div class="actions"><button type="button" id="dlg-close">close</button></div>';
          $("dlg-close").onclick = function () { dlg.close(); };
          return;
        }
        dlg.innerHTML = "<h3>push " + n + " cell" + (n === 1 ? "" : "s") + esc(scope) + " to the backend sheet</h3>" +
          "<p>this writes to the <b>live</b> sheet, then reads every cell back. Rejects and holds write nothing." +
          (ns ? " " + ns + " cell" + (ns === 1 ? "" : "s") + " come from suggestions; their links are the ones that state the suggested value." : "") +
          (unclicked ? " " + esc(unclicked) : "") + (batch ? "" : " Pick a batch under more filters to push one batch at a time.") + "</p>" +
          '<div style="max-height:45vh;overflow:auto">' + planTable(pl.writes) +
          (m ? "<details><summary>" + m + " more from batches already applied: the sheet differs, likely a later hand edit</summary>" + planTable(pl.applied_writes) + "</details>" : "") +
          (k ? "<details><summary>" + k + " line" + (k === 1 ? "" : "s") + " not pushed (by-hand path)</summary><ul>" + pl.skipped.map(function (x) {
            return "<li>" + (x.live_row ? "row " + esc(x.live_row) + " · " : "") + esc(x.column) + (x.decision === "suggest" ? " (suggested)" : "") + ": " + esc(x.why) + "</li>";
          }).join("") + "</ul></details>" : "") + "</div>" +
          (m ? '<label class="check"><input type="checkbox" id="push-applied"> also overwrite the ' + m + " cell" + (m === 1 ? "" : "s") + " from applied batches</label>" : "") +
          '<p class="faint" id="pu-err"></p><div class="actions"><button type="button" class="ghost" id="dlg-cancel">cancel</button><button type="button" id="dlg-ok">write ' + n + " cell" + (n === 1 ? "" : "s") + "</button></div>";
        $("dlg-cancel").onclick = function () { dlg.close(); };
        // the one write: fired only from this click, with the token of the plan the person saw
        $("dlg-ok").onclick = function () {
          var inc = !!($("push-applied") && $("push-applied").checked);
          if (!n && !inc) return;
          var ok = $("dlg-ok"); ok.disabled = true; ok.textContent = "writing…"; $("dlg-cancel").disabled = true; dlg.dataset.busy = "1";
          return Store.push(inc ? pl.token_all : pl.token, inc, batch).then(function (r) {
            return Store.load().then(function (data) {
              dlg.close();
              A.reload(data);
              var bad = (r.mismatches || []).length;
              A.toast(r.written + " cell" + (r.written === 1 ? "" : "s") + " written and read back" +
                (bad ? "; " + bad + " did NOT land (" + r.mismatches.slice(0, 5).map(function (w) { return "row " + w.live_row + " " + w.column; }).join(", ") + (bad > 5 ? ", …" : "") + ")" : ".") +
                (r.error ? " " + r.error : "") + livingNote(r.living));
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

    return {
      name: "lng",
      cards_key: "vessels",
      words: {card: "vessel", cards: "vessels", line: "change", lines: "changes"},
      searchPlaceholder: "name / IMO / builder / owner / hull",
      // a change the backend already holds (value and refs: the in_backend flag) is not waiting on a call, whether or not anyone clicked it: the undecided view, progress and tab counts leave it out, as the old LNG page did. Any other decision view still lists it.
      counted: function (l) { return (l.flags || []).indexOf("in_backend") < 0; },
      bulkSkip: {uncounted: " already in the backend"},
      pidTip: "click to copy the sheet row",
      references: false,
      suggestRef: false,
      bulkFiltered: false,
      line_kinds: TB.line_kinds || ["fill", "change", "delete", "ref", "new_row"],
      item_kinds: TB.item_kinds || ["conflict", "flag", "manual", "proposed_bucket", "duplicate"],
      item_calls: TB.item_calls || {conflict: ["accept", "hold", "reject", "resolved"]},
      other_calls: TB.other_calls || ["resolved", "needs_research"],
      kind_label: KIND_LABEL,
      kind_tip: {conflict: "the research disagrees with a value already in the sheet; decided by hand, and the call is kept in the batch's conflicts file",
                 flag: "something the discovery pass raised", manual: "an entry the researcher marked for a person to check",
                 proposed_bucket: "a row the discovery pass proposes to add or drop", duplicate: "the same vessel may be entered twice; the duplicate is removed by hand"},
      call_help: {accept: "the research value stands; it is applied by hand", hold: "leave it open", reject: "the sheet's value stands",
                  resolved: "dealt with", needs_research: "goes back for more research"},
      help: help,
      info: info,
      slots: {
        "header-buttons": '<button id="sync" class="ghost" hidden>&#8635; sync backend</button>' +
          '<button id="push" class="ghost" hidden data-tip="write the accepted lines and suggestions to the live backend sheet, after you confirm the list">&#8682; push changes</button>'
      },

      onInit: function () {
        var St = A.Store;
        if (!window.GasStore && !window.StaticStore && St._json) {
          var post = function (url, body) { return fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)}).then(St._json); };
          if (!St.refresh) St.refresh = function () {
            if (!St.caps.refresh) return Promise.reject(new Error("this server cannot refresh the backend"));
            return post("/api/refresh", {});
          };
          if (!St.pushPlan) St.pushPlan = function (batch) { return post("/api/push/plan", {batch: batch || null}); };
          if (!St.push) St.push = function (token, includeApplied, batch) { return post("/api/push", {token: token, include_applied: !!includeApplied, batch: batch || null}); };
        }
        $("sync").onclick = refreshBackend;
        $("push").onclick = pushChanges;
      },
      onBoot: function () {
        var St = A.Store;
        $("sync").hidden = !St.caps.refresh;
        $("sync").dataset.tip = "pull the live sheet, rebuild, and settle what the backend already holds";
        $("push").hidden = !St.caps.push;
      },

      // ---- cards ----
      // a change from a batch already applied to the backend is an accept, on the page only: shown and filtered as accepted, never undecided, with no reviewer
      // (decided_by stays empty, so the "decided by" filter lists people only). Nothing is written for it (no log record, no decisions.csv change), so a push
      // still counts only real clicks. A person's own call on the line speaks over it.
      prepare: function (p) {
        p.lines.forEach(function (l) {
          if (l.reviewed || (l.flags || []).indexOf("applied") < 0) return;
          l.reviewed = true; l.decision = "accept"; l.decided_by = null; l.decided_at = null; l._applied = true;
        });
        // the same cell proposed with the same value by two batches, both settled: one block is enough, the chip on it names the other batch
        var seen = {};
        p.lines.forEach(function (l) {
          l._dup = false;
          if (l.kind === "new_row" || l.kind === "ref" || !l.reviewed) return;
          var k = [l.column, l.current, l.proposed].join("\u0000");
          if (seen[k]) l._dup = true; else seen[k] = true;
        });
        p._hay += " " + [p.imo, p.shipbuilder, p.shipowner, p.hull, p.status, p.live_row].filter(function (x) { return x != null && x !== ""; }).join(" ").toLowerCase();
      },
      flatCard: function () { return true; },
      showPid: function (p) { return p.live_row != null; },
      pidText: function (p) { return String(p.live_row); },
      cardSub: function (p) { return p.pid === "items" ? "" : p.live_row == null ? (p.new ? "new vessel" : "row gone") : ""; },
      cardContext: function (p) {
        var o = function (v, t) { return v ? A.only(String(v), t || String(v), null, "show only " + v) : ""; };
        return [A.tierSummary(p), p.imo ? "IMO " + o(p.imo) : "", o(p.shipbuilder), o(p.shipowner), p.hull ? "hull " + esc(p.hull) : "",
                p.status ? esc(p.status) : "", p.delivery_year ? "delivery " + esc(p.delivery_year) : ""];
      },

      // ---- lines ----
      lineTitle: function (l) { return l.column || "new row · cluster " + l.cluster_id; },
      // the left-hand queue row: the vessel's name, its sheet row, yard and owner, and the count to decide (the flat card has no major / minor, so the badge does not either)
      queueRow: function (p, i, x) {
        var meta = [rowLabel(p), p.shipbuilder, p.shipowner].filter(Boolean).join(" · ");
        var badge = p._todo ? x.badge.replace(/<span class="n todo">.*<\/span>$/, '<span class="n todo">' + p._todo + " to decide</span>") : x.badge;
        return '<div class="pname">' + esc(p.name || "(no name)") + '</div><div class="pmeta"><span class="lng-qmeta">' + esc(meta) + "</span>" + badge + "</div>" +
          (x.dots ? '<div class="dots">' + x.dots + "</div>" : "");
      },
      lineWhere: function (l) { var p = A.cards()[l._p]; return (p ? rowLabel(l.kind === "new_row" ? {new: true} : p) : ""); },
      lineClass: function (l) { return l._dup ? " lng-dup" : ""; },
      lineChips: lineChips,
      lineBody: lineBody,
      lineDetails: lineDetails,
      decisionText: decisionText,
      noteBox: noteBox,
      lineActions: function (l) {
        return {buttons: [["accept", "accept", ""], ["hold", "hold", ""], ["reject", "reject", ""]], suggest: suggestable(l)};
      },
      partners: partnerLines,
      suggestForm: suggestForm,
      snapshot: function (l) { return l.suggest_kind ? {suggest_kind: l.suggest_kind, suggested_refs: (l.suggested_refs || []).slice()} : null; },
      // the page's own record types: the core copies the common fields, the LNG ones are copied here
      applyRecord: function (r, l) {
        if (l && !("call" in r)) {
          var sug = r.decision === "suggest" && !r.undecided;
          l.suggest_kind = sug ? (r.suggest_kind || "value") : "";
          l.suggested_refs = sug ? (r.suggested_refs || []).slice() : [];
        }
        return false;
      },

      // ---- items ----
      itemWhere: function (it) { return (it.live_rows || []).length ? (it.live_rows.length > 1 ? "rows " : "row ") + it.live_rows.join(", ") : ""; },
      itemChips: function (it) { return it.backend_resolved ? chip("settled in the backend", "ok", it.backend_resolved) : ""; },
      itemBody: itemBody,

      progressHtml: function () {
        var c = {}, pre = 0;
        A.LINES.forEach(function (l) {
          var d = A.cur(l);
          if (d) c[d] = (c[d] || 0) + 1;
          else if (l.prefill === "accept") pre++;
        });
        var t = ["accept", "hold", "reject", "suggest"].filter(function (d) { return c[d]; }).map(function (d) { return c[d] + " " + d; }).join(" · ");
        return "<p>" + (t ? "decided: " + esc(t) : "no changes decided yet") + "</p>" +
          (pre ? "<p>" + pre + " green line" + (pre === 1 ? " starts" : "s start") + " as accept but nobody has clicked " + (pre === 1 ? "it" : "them") + "; the push writes only a clicked accept.</p>" : "");
      }
    };
  });
})();
