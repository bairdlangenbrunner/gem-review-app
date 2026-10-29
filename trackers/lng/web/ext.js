/* LNG carriers extension for the shared review app (gem-review-app). Loads after review_core/web/app.js and registers everything LNG-only through ReviewApp.define: vessel cards, fill / ref / new-row lines, the suggest form (kind and refs), Name and Other names as a strict pair, conflict items, and the sync and push buttons. The page's store gets the same suggest rules the Python side has through StaticStore.extend. */
(function () {
  "use strict";
  if (!window.ReviewApp || !window.ReviewApp.define) return;
  var TB = (window.REVIEW_STATIC || {}).tracker || {};
  var KINDS = ["value", "cosmetic"];
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
  function suggestable(l) { return l.kind === "fill" && (l.flags || []).indexOf("ref_only") < 0; }

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
    var $ = A.$, esc = A.esc, chip = A.chip, blankv = A.blankv;

    // ---- small helpers ----
    function has(l, f) { return (l.flags || []).indexOf(f) >= 0; }
    function batchOf(dir) {
      var b = ((A.D && A.D.batches) || []).filter(function (x) { return x.dir === dir; })[0];
      return b || {dir: dir, label: dir, apply_order: "?"};
    }
    function rowLabel(p) { return p.new ? "new row" : p.live_row == null ? "row gone" : "row " + p.live_row; }
    function link(u) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + "</a>"; }
    function list(urls) { return urls.map(link).join(", "); }

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
      preserve_ref: ["cosmetic", "the value is rewritten, the cell's [ref] is kept"],
      append_ref: ["appends", "added to what the cell already holds, nothing is replaced"],
      ref_only: ["ref only", "adds refs; the value is untouched"],
      igu_pdf_only: ["only source: IGU", "the IGU report PDF is the sole ref"],
      in_backend: ["in the backend", "the pulled backend already holds this value and its refs"],
      value_in_backend: ["value in the backend", "the backend holds this value, but not every proposed ref"],
      applied: ["already applied", "this batch is in the backend; changing the decision does not unapply it"]
    };
    var CONF_TEXT = {G: "green: a live page states this value for this vessel", Y: "yellow: held for a decision", R: "red: no ref survived the gate"};
    // the same cell proposed by another batch: quiet when the values agree, a warning when they do not
    function overlapChips(l) {
      return (l.links || []).map(function (k) { return A.LINE_BY_KEY[k]; }).filter(function (q) {
        return q && q.column === l.column && q.kind !== "ref" && l.kind !== "ref";
      }).map(function (q) {
        var b = batchOf(q.dir), n = "batch " + b.apply_order;
        return q.proposed === l.proposed ? chip("also in " + n, "", b.label + " proposes the same value")
          : chip(n + " differs", "warn", b.label + " proposes " + JSON.stringify(q.proposed) + "; the later batch wins on apply");
      });
    }
    // only worth saying once a person has decided the two sides differently
    function pairSplit(l) {
      var d = A.cur(l);
      return !!d && partnerLines(l).some(function (p) { var e = A.cur(p.line); return e && e !== d; });
    }
    function lineChips(l, base) {
      var out = base.slice();
      if (!l.reviewed && l.prefill) out.push(chip("pre-filled: " + l.prefill, "", "what the batch's decisions file holds for this line; nobody has decided it yet, and push writes only a clicked accept"));
      if (l.derivable) out.push(chip("derived", "", "computed from other cells, not researched"));
      (l.flags || []).forEach(function (f) {
        if (FLAG_TEXT[f]) out.push(chip(FLAG_TEXT[f][0], f === "applied" ? "warn" : "", FLAG_TEXT[f][1]));
      });
      out = out.concat(overlapChips(l));
      if (pairSplit(l)) out.push(chip("pair split", "warn", "its linked line has a different decision"));
      return out;
    }

    // ---- line body ----
    function verdictChip(r) {
      var v = r.verdict;
      if (v && typeof v === "object") v = v.status || v.reason || "";
      v = String(v || "");
      if (!v) return chip("unchecked", "", "no verdict recorded for this link");
      return chip(v, /^(verified|ok|✓)/i.test(v) ? "ok" : /fail|✗|bad/i.test(v) ? "bad" : "", v);
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
    function newRowRows(l) {
      var rd = l.row_data || {}, cols = (A.D.header || []).concat(Object.keys(rd).filter(function (c) { return (A.D.header || []).indexOf(c) < 0; })), h = "";
      cols.forEach(function (c) {
        if (/ \[ref\]$/.test(c)) return;
        var v = rd[c], refs = String(rd[c + " [ref]"] || "").split(/,\s+/).filter(Boolean);
        if (blankv(v) && !refs.length) return;
        h += row(c, "", esc(v == null ? "" : v) + (refs.length ? '<div class="lng-cites">' + refs.map(function (u) { return A.shortLink(u); }).join(", ") + "</div>" : ""), "new");
      });
      return h;
    }
    function lineBody(l) {
      var h = "";
      if (l.kind === "new_row") h = (l.cluster_label ? '<div class="dtxt">' + esc(l.cluster_label) + "</div>" : "") + A.pairTable(newRowRows(l));
      else if (l.kind === "ref" || has(l, "ref_only")) {
        h = A.pairTable(row(l.column || "", esc(l.cited_value || l.current || ""), '<span class="muted">value unchanged</span>', "") + refRow(l));
      } else h = A.pairTable(valueRow(l) + refRow(l));
      if (l.why) h += '<div class="dtxt lng-why"><span class="k">why</span>' + A.linkText(l.why) + "</div>";
      return h;
    }
    function lineDetails(l) {
      var d = [];
      (l.detail || []).forEach(function (t) { d.push('<div class="dtxt">' + A.linkText(t) + "</div>"); });
      if (l.confidence_why) d.push('<div class="dtxt"><span class="k">grade:</span> ' + esc((CONF_TEXT[l.confidence] || l.confidence || "") + ". " + l.confidence_why) + "</div>");
      if (l.kind !== "new_row" && (l.current_refs || []).length) d.push('<div class="dtxt"><span class="k">current ' + esc(l.ref_column || "[ref]") + ":</span> " + list(l.current_refs) + "</div>");
      if (l.note) d.push('<div class="dtxt"><span class="k">note:</span> ' + A.linkText(l.note) + "</div>");
      d.push('<div class="dtxt"><span class="k">record:</span> ' + esc(["batch " + batchOf(l.dir).label, "default " + (l.default || "hold"), "id " + (l.id || "?")].join(" · ")) + "</div>");
      return '<details data-more><summary>details</summary>' + d.join("") + "</details>";
    }
    function decisionText(l) {
      if (!(l.reviewed && l.decision === "suggest")) return null;
      var refs = l.suggested_refs || [];
      return "suggested " + (l.suggest_kind || "value") + ": " + (blankv(l.suggested_value) ? "(note only)" : l.suggested_value) + " by " + (l.decided_by || "?") + " " + A.timeOf(l.decided_at) +
        (blankv(l.decision_note) ? "" : ". " + l.decision_note) + (refs.length ? ". refs: " + refs.join(", ") : "");
    }

    // ---- suggest: a value and a note are both required, with its kind and the refs that support it ----
    function suggestForm(l, prior) {
      var v = prior ? (l.suggested_value || "") : (l.proposed || ""), kind = prior ? (l.suggest_kind || "value") : "value";
      var refs = prior ? (l.suggested_refs || []) : (l.refs || []).map(function (r) { return r.url; }).filter(Boolean);
      var note = prior ? (l.decision_note || "") : A.noteOf(l);
      var strict = partnerLines(l).filter(function (p) { return p.strict; });
      return {
        html: '<label class="stack">suggested value<textarea class="lng-sv" rows="3">' + esc(v) + "</textarea></label>" +
          '<fieldset class="stack"><label><input type="radio" name="lng-kind" value="value"' + (kind !== "cosmetic" ? " checked" : "") + "> value: a different fact; the refs are checked against it</label>" +
          '<label><input type="radio" name="lng-kind" value="cosmetic"' + (kind === "cosmetic" ? " checked" : "") + "> cosmetic: spelling or style, the same fact; the cell's [ref] is kept</label></fieldset>" +
          '<label class="stack">refs for the value, one URL per line<textarea class="lng-sr" rows="3" spellcheck="false" placeholder="https://...">' + esc(refs.join("\n")) + "</textarea></label>" +
          '<label class="stack">note (required)<textarea class="lng-sn" rows="2">' + esc(note) + "</textarea></label>" +
          '<p class="faint">Nothing is written to the sheet from here. The line is recorded as a suggestion; push changes lists it with the accepted lines.</p>' +
          (strict.length ? '<p class="faint">Linked: ' + strict.map(function (p) { return esc(p.line.column) + " is " + esc(A.cur(p.line) || "not reviewed"); }).join(", ") + ". Decide the partner yourself.</p>" : "") +
          (has(l, "applied") ? '<p class="faint">This batch is already applied: a suggestion unapplies nothing.</p>' : ""),
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

    // ---- items ----
    var KIND_LABEL = {conflict: "conflict", flag: "discovery flag", manual: "manual review", proposed_bucket: "proposed bucket", duplicate: "possible duplicate"};
    var USED = {title: 1, detail: 1, urls: 1, live_rows: 1, row_ids: 1, conflict_index: 1, conflict_match: 1, conflict_decision: 1, backend_resolved: 1, logged_call: 1, pid: 1};
    function itemBody(it) {
      var h = "";
      if (it.detail) h += '<div class="body">' + A.linkText(it.detail) + "</div>";
      if (it.logged_call && it.logged_call !== it.conflict_decision)
        h += '<div class="body">' + chip("call " + it.logged_call + " is in the log but conflicts.csv says " + (it.conflict_decision || "nothing"), "warn",
          "apply_batch.py rewrote conflicts.csv; choose the call again to rewrite it") + "</div>";
      if (it.backend_resolved) h += '<div class="body"><span class="k">backend</span>' + esc(it.backend_resolved) + "</div>";
      if ((it.urls || []).length) h += '<div class="body">' + it.urls.map(function (u) { return A.urlLink(u); }).join("<br>") + "</div>";
      return {html: h, used: USED};
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
          (ns ? " " + ns + " cell" + (ns === 1 ? "" : "s") + " come from suggestions; their refs are the ones that pass the gate against the suggested value." : "") +
          (unclicked ? " " + esc(unclicked) : "") + (batch ? "" : " Pick a batch in the batch filter first to push one batch at a time.") + "</p>" +
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
      pidTip: "click to copy the row",
      references: false,
      suggestRef: false,
      bulkFiltered: true,
      line_kinds: TB.line_kinds || ["fill", "ref", "new_row"],
      item_kinds: TB.item_kinds || ["conflict", "flag", "manual", "proposed_bucket", "duplicate"],
      item_calls: TB.item_calls || {conflict: ["accept", "hold", "reject", "resolved"]},
      other_calls: TB.other_calls || ["resolved", "needs_research"],
      kind_label: KIND_LABEL,
      kind_tip: {conflict: "research disagrees with a non-blank backend value; decided by hand, and the call goes into conflicts.csv",
                 flag: "something the discovery pass raised", manual: "an entry the researcher marked for manual review",
                 proposed_bucket: "a proposed-bucket row action", duplicate: "the same vessel may be entered twice; the duplicate is deleted by hand"},
      call_help: {accept: "the research value stands (applied by hand)", hold: "leave it open", reject: "keep the backend value",
                  resolved: "dealt with", needs_research: "goes back for more research"},
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
      prepare: function (p) { p._hay += " " + [p.imo, p.shipbuilder, p.shipowner, p.hull, p.status, p.live_row].filter(function (x) { return x != null && x !== ""; }).join(" ").toLowerCase(); },
      flatCard: function () { return true; },
      showPid: function (p) { return p.live_row != null; },
      pidText: function (p) { return "row " + p.live_row; },
      cardSub: function (p) { return p.pid === "items" ? "" : p.live_row == null ? (p.new ? "new vessel" : "row gone") : ""; },
      cardContext: function (p) {
        var o = function (v, t) { return v ? A.only(String(v), t || String(v), null, "show only " + v) : ""; };
        return [A.tierSummary(p), p.imo ? "IMO " + o(p.imo) : "", o(p.shipbuilder), o(p.shipowner), p.hull ? "hull " + esc(p.hull) : "",
                p.status ? esc(p.status) : "", p.delivery_year ? "delivery " + esc(p.delivery_year) : ""];
      },

      // ---- lines ----
      lineTitle: function (l) { return l.column || "new row · cluster " + l.cluster_id; },
      lineWhere: function (l) { var p = A.cards()[l._p]; return (p ? rowLabel(l.kind === "new_row" ? {new: true} : p) : "") + " · batch " + batchOf(l.dir).label; },
      lineChips: lineChips,
      lineBody: lineBody,
      lineDetails: lineDetails,
      decisionText: decisionText,
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
          (pre ? "<p>" + pre + " pre-filled accept" + (pre === 1 ? "" : "s") + " nobody has clicked; push writes only a clicked accept.</p>" : "");
      }
    };
  });
})();
