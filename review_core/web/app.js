/* Shared review app front end (gem-review-app). Vanilla JS, no modules, no build step. All I/O goes through Store.
   The page shows the edits a research batch staged for a GEM tracker and records one call per edit (accept, hold, reject, suggest).
   Nothing here writes a GEM database. Each tracker's ext.js adds its own pieces through ReviewApp.define(); without one the page still works. */
(function () {
  "use strict";
  var T0 = performance.now();
  var T = {};                // the tracker definition (ReviewApp.define); every hook is optional
  var TB = (window.REVIEW_STATIC || {}).tracker || {};   // the tracker's plain settings, when the page was built with them
  var W = {card: "card", cards: "cards", line: "change", lines: "changes"};   // the words for a card and a line (T.words)

  // ---- Store adapter: the local loopback server; the Apps Script page (gas.js) or the single-file page (static_store.js) supply their own ----
  var NOT_YET = "this server cannot record decisions";
  var LOOPBACK = {
    caps: {decide: false},
    _json: function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : "HTTP " + r.status);
        return body;
      });
    },
    load: function () { return fetch("/api/data", {cache: "no-store"}).then(LOOPBACK._json); },
    whoami: function () {
      return fetch("/api/whoami").then(LOOPBACK._json).then(function (b) {
        if (b.caps) { var c = {}; Object.keys(b.caps).forEach(function (k) { c[k] = !!b.caps[k]; }); LOOPBACK.caps = c; }
        return b.reviewer;
      });
    },
    _post: function (url, records) {
      if (!LOOPBACK.caps.decide) return Promise.reject(new Error(NOT_YET));
      return fetch(url, {method: "POST", headers: {"Content-Type": "application/json"},
                         body: JSON.stringify(records)}).then(LOOPBACK._json).then(function (b) { return b.saved; });
    },
    decide: function (records) { return LOOPBACK._post("/api/decide", records); },
    item: function (records) { return LOOPBACK._post("/api/item", records); }
  };
  var Store = window.GasStore || window.StaticStore || LOOPBACK;
  var STATIC = Store.mode === "static";
  window.Store = Store;

  // ---- state ----
  var D = null;              // the dataset (the tracker's review_data.py)
  var ME = "";
  var LINES = [];            // every line, flat; l._i is its index, l._p its card index
  var ITEMS = [];            // every item, flat; it._p its card index
  var FS = defaults();       // filter state (what the chips and controls show)
  var S = {
    visible: [],             // card indexes passing the filter
    pipe: -1,                // index into the cards
    line: -1,                // selected line index (LINES)
    pin: -1,                 // a card opened by link that the filters would hide
    shown: [],               // line indexes drawn on the current card, in order
    stay: {},                // line keys decided this session: kept in view even if the filter would drop them
    saving: {},              // line / item keys with a save in flight
    tab: "major",            // the card's tab: "major" | "minor" | "items" | "all"
    moreTabs: false,         // T.collapseTabs: the minor, items and everything tabs are open (they start folded behind a + next to major)
    panel: null,             // a tracker panel drawn in the card instead of a card (T.cardPanel)
    igOpen: {},              // item group id -> item details open state (survives a re-render; reset per card)
    notes: {},               // line key -> note typed in the line's note box, not saved yet (goes with the next call)
    history: [],             // [{label, snaps}]: the lines as they were before each save this session, newest last ("undo last")
    linkSkip: null           // "one" | "both": the answer kept when "don't ask again this session" was ticked on the linked-pair question
  };
  var ITEM_BY_KEY = {};
  var LINE_BY_KEY = {};
  // the vocabularies: the tracker's ext.js (T) wins, then the built page's tracker block (TB), then these defaults
  var ITEM_CALLS = {};       // item kind -> calls; every tracker supplies these (T.item_calls or the page block)
  var OTHER_CALLS = ["noted", "todo", "dismissed"];
  var NOTE_REQUIRED = {};    // "kind:call" pairs that need a note saying why
  var CALL_LABEL = {needs_research: "needs research"};
  var CALL_HELP = {confirmed: "the concern stands", dismissed: "the concern is closed", needs_research: "goes back to the researcher",
                   noted: "seen, nothing to do", todo: "to do later"};
  var CALL_HINT = {};
  var VERB = {accept: "accepted", hold: "held", reject: "rejected", suggest: "suggested"};
  var $ = function (id) { return document.getElementById(id); };
  var LINE_KINDS = [];       // empty: taken from the data
  var ITEM_KINDS = [];
  var KINDS_GIVEN = {line: false, item: false};   // true once the tracker names its kinds; otherwise they come from the data on every load
  var KIND_LABEL = {fill: "fill a blank", change: "change a value", "delete": "clear a value", new_row: "new row",
                    concern: "question about existing data", other: "other"};
  var KIND_TIP = {};
  var ITEM_FACETS = [];      // filter keys whose counts include items (T.itemFacets)
  function kindLabel(o) { return T.kindLabel ? T.kindLabel(o, KIND_LABEL) : (KIND_LABEL[o.kind] || o.kind); }
  function kindTip(o) { return T.kindTip ? T.kindTip(o, KIND_TIP) : KIND_TIP[o.kind] || ""; }
  var DEC = ["undecided", "accept", "hold", "reject", "suggest"];
  // severity (review_data.py): a MAJOR change moves a cell value; a MINOR change leaves the value as it is and only adds a Data Source link.
  var SEV = ["major", "minor"];
  var SEV_LABEL = {major: "major changes", minor: "minor changes"};
  var SEV_TIP = {major: "major change: a cell value moves. A blank is filled, a value is changed or cleared, or a row is added",
                 minor: "minor change: the value was checked again and stands. Only a Data Source link is added"};
  function sevOf(l) { return l.severity || "major"; }
  var TIER_TIP = {};

  function defaults() {
    var d = {decision: "undecided", kind: "", tier: "", dir: "", column: "", q: "", by: ""};
    var x = T.defaults ? T.defaults() : {};
    Object.keys(x).forEach(function (k) { d[k] = x[k]; });
    return d;
  }
  // items sit beside the edits when their kind is picked, or when the tracker says so (T.itemsInView,
  // which also sees the item and its card when the question is about one item: GOGPT keeps the
  // items of an addition or watch card in view whatever the filters say)
  function itemsInView(fs, o, p) { return !!(isItemKind(fs.kind) || (T.itemsInView && T.itemsInView(fs, o, p))); }
  // the cards: the dataset's generic list, else the tracker's own key
  function cards() { return D ? (D.cards || D[T.cards_key || TB.cards_key] || []) : []; }
  // the tab a card opens on: its major changes, or the minor ones when it has no major change
  function defaultTab(p) { return p && p.lines.some(function (l) { return sevOf(l) === "major"; }) ? "major" : "minor"; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c];
    });
  }
  // escaped text with each http(s) link turned into a clickable one (notes name their sources by link),
  // and each name of a file on the researcher's own computer grayed with a tip, since nobody else can open it
  // (the same pattern as LOCAL_PATH_RE in the researcher's state_gate.py, which stops such notes before staging)
  var URL_RE = /https?:\/\/[^\s<]+[^\s<.,;:)'"]/g;
  var LOCAL_PATH_RE = /(?<![\w\/.])(?:(?:work|batches|data|upstream|scripts|tmp)\/[^\s<]+[^\s<.,;:)'"]|\/Users\/[^\s<]+[^\s<.,;:)'"]|~\/[^\s<]+[^\s<.,;:)'"]|\/tmp\/[^\s<]+[^\s<.,;:)'"])|\b[\w-]+\.(?:xlsx|xls|csv|json|zip|parquet)\b/gi;
  var LOCAL_TIP = "a file on the researcher's own computer: it can't be opened from here, so ask them for the web address or the steps to get it";
  function localText(t) {
    return t.replace(LOCAL_PATH_RE, function (f) { return '<span class="localpath" title="' + LOCAL_TIP + '">' + f + "</span>"; });
  }
  function linkText(s) {
    var t = esc(s), out = "", last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(t))) {
      out += localText(t.slice(last, m.index)) + '<a href="' + m[0] + '" target="_blank" rel="noopener">' + m[0] + "</a>";
      last = m.index + m[0].length;
    }
    return out + localText(t.slice(last));
  }
  function isItemKind(k) { return ITEM_KINDS.indexOf(k) >= 0; }
  function blankv(v) { return v == null || String(v).trim() === ""; }
  // "batches/us-md/staging" -> "us-md"
  function dirLabel(d) {
    var parts = String(d || "").split("/").filter(Boolean);
    if (parts.length && parts[parts.length - 1] === "staging") parts.pop();
    return parts.length ? parts[parts.length - 1] : String(d || "");
  }
  function tierOf(l) { return l.tier === "high" || l.tier === "medium" || l.tier === "low" ? l.tier : "untiered"; }
  function cur(l) { return l.reviewed && l.decision ? l.decision : null; }
  // drawn grayed once decided (hold stays bright: still open)
  // a held line grays out too: it has a decision, even if the question stays open
  function grayed(l) { return settled(l) || cur(l) === "hold"; }
  function settled(l) { var d = cur(l); return d === "accept" || d === "reject" || d === "suggest"; }
  function dstate(o) {
    var d = o._item ? o.call : cur(o);
    return d ? d : "undecided";
  }
  // a line the tracker leaves out of the count (T.counted; pipelines: changes the backend already holds). One predicate for the
  // badge, the progress, the tab counts, the undecided view and its facet count, "card done", "next undecided" and bulk accept.
  function counted(o) { return !!o._item || !(T.counted && T.counted(o) === false); }
  // open and waiting on a call: undecided and counted
  function isOpen(o) { return dstate(o) === "undecided" && counted(o); }
  var TODAY = (function () {
    try { return new Intl.DateTimeFormat("en-CA", {timeZone: "America/New_York"}).format(new Date()); } catch (e) { return ""; }
  })();
  // today's decisions show HH:MM, older ones their date too (the log keeps every decision ever made)
  function timeOf(iso) {
    var s = String(iso || "").replace("T", " ");
    return !TODAY || s.slice(0, 10) === TODAY ? s.slice(11, 16) : s.slice(0, 16);
  }
  function decisionText(l) {
    if (T.decisionText) { var td = T.decisionText(l); if (td != null) return td; }
    if (l.reviewed && l.decision === "suggest") {
      return "suggested: " + (blankv(l.suggested_value) ? "(note only)" : l.suggested_value) + " by " + (l.decided_by || "?") + " " + timeOf(l.decided_at) +
        (blankv(l.decision_note) ? "" : ". " + l.decision_note) + (blankv(l.reference) ? "" : ". source: " + l.reference);
    }
    if (l.reviewed && l.decision) return (VERB[l.decision] || l.decision) + " by " + (l.decided_by || "?") + " " + timeOf(l.decided_at);
    return "";
  }

  // ---- theme ----
  // theme = a palette (the "theme" menu in the header, drawn like the filter menus; "" = the default look) x a mode (light / dark button; unset = follow the system).
  function initTheme() {
    var root = document.documentElement, pick = $("theme-pick"), mq = matchMedia("(prefers-color-scheme: dark)");
    var opts = Array.prototype.slice.call(pick.querySelectorAll("[data-pal]"));
    var pal = "", mode = "";
    function store(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* ignore */ } }
    function eff() { return mode || (mq.matches ? "dark" : "light"); }
    function apply() {
      if (!pal && !mode) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", pal ? pal + "-" + eff() : mode);
      opts.forEach(function (b) { b.setAttribute("aria-checked", b.dataset.pal === pal); });
    }
    try {
      pal = localStorage.getItem("review-palette") || "";
      mode = localStorage.getItem("review-mode") || "";
    } catch (e) { /* storage blocked: follow the system theme */ }
    apply();
    opts.forEach(function (b) { b.onclick = function () { pal = b.dataset.pal; store("review-palette", pal); apply(); pick.open = false; }; });
    $("theme").onclick = function () { mode = eff() === "dark" ? "light" : "dark"; store("review-mode", mode); apply(); };
    if (mq.addEventListener) mq.addEventListener("change", function () { if (!mode) apply(); });
  }

  // ---- derived data, once per load ----
  function prepare() {
    LINES = []; ITEMS = []; LINE_BY_KEY = {}; ITEM_BY_KEY = {};
    if (!KINDS_GIVEN.line) LINE_KINDS = [];
    if (!KINDS_GIVEN.item) ITEM_KINDS = [];
    if (T.onReload) T.onReload(D);
    var lk = {}, ik = {};
    cards().forEach(function (p, pi) {
      p.items = (p.items || []).filter(function (it) { return !ITEM_KINDS.length || isItemKind(it.kind); });
      p.items.forEach(function (it) {
        it._item = true; it._p = pi; it._i = ITEMS.length; ITEM_BY_KEY[it.key] = it; ik[it.kind] = 1;
        ITEMS.push(it);
      });
      p.lines = p.lines || [];
      p.lines.forEach(function (l) {
        l._p = pi; l._i = LINES.length; LINE_BY_KEY[l.key] = l; lk[l.kind] = 1;
        LINES.push(l);
      });
      p._hay = [p.name, p.pid].join(" ").toLowerCase();
      if (T.prepare) T.prepare(p, pi);
    });
    // no vocabulary from the tracker: take the kinds the data has
    if (!LINE_KINDS.length) LINE_KINDS = Object.keys(lk);
    if (!ITEM_KINDS.length) ITEM_KINDS = Object.keys(ik);
  }

  // ---- filters ----
  // One matcher for lines and items. `skip` names a facet to ignore (for faceted chip counts).
  function match(o, p, fs, skip, q) {
    var item = !!o._item;
    if (skip !== "kind") {
      if (fs.kind) { if (o.kind !== fs.kind) return false; }
      // a facet that puts items in view (T.itemFacets) counts them too
      else if (item && !itemsInView(fs, o, p) && ITEM_FACETS.indexOf(skip) < 0) return false;
    }
    if (skip !== "decision" && fs.decision && dstate(o) !== fs.decision && !(!item && S.stay[o.key])) return false;
    // a line the tracker does not count is not waiting on a call: the undecided view leaves it out (any other decision view lists it)
    if (skip !== "decision" && fs.decision === "undecided" && !item && !counted(o) && !S.stay[o.key]) return false;
    if (skip !== "tier" && fs.tier && (item || tierOf(o) !== fs.tier)) return false;
    if (fs.dir && o.dir !== fs.dir) return false;
    if (fs.column && (item || colKey(o.column) !== fs.column)) return false;
    if (fs.by && (o.reviewed ? o.decided_by : "") !== fs.by) return false;
    if (T.match && !T.match(o, p, fs, skip)) return false;
    if (q && p._hay.indexOf(q) < 0) return false;
    return true;
  }
  function pipeMatches(p) {
    var q = FS.q.trim().toLowerCase(), n = 0, todo = 0, ni = 0, tsev = {major: 0, minor: 0};
    p.lines.forEach(function (l) {
      if (!match(l, p, FS, null, q)) return;
      n++;
      if (isOpen(l)) { todo++; if (sevOf(l) in tsev) tsev[sevOf(l)]++; }   // shown but not counted (T.counted); a severity outside major / minor (GOGPT's check lines) is in the total only
    });
    p.items.forEach(function (it) { if (match(it, p, FS, null, q)) ni++; });
    p._n = n; p._todo = todo; p._ni = ni; p._tsev = tsev;
    if (T.tally) T.tally(p);
    return n + ni;
  }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function refilter(keep) {
    var all = cards(), sel = all[S.pipe];
    S.visible = [];
    var nl = 0, ni = 0;
    all.forEach(function (p, i) {
      var m = pipeMatches(p);
      nl += p._n; ni += p._ni;
      if (m || i === S.pin) S.visible.push(i);
    });
    S.countText = nl + " " + (nl === 1 ? W.line : W.lines) + (ni ? " + " + plural(ni, "item") : "") +
      " on " + S.visible.length + " " + (S.visible.length === 1 ? W.card : W.cards);
    if (S.visible.indexOf(S.pipe) < 0) {
      var keepIn = S.visible.filter(function (i) { return !queueHides(i); });
      S.pipe = keepIn.length ? keepIn[0] : S.visible.length ? S.visible[0] : -1;
    }
    if (all[S.pipe] !== sel) { S.line = -1; S.tab = defaultTab(all[S.pipe]); S.igOpen = {}; }
    renderChips();
    renderActive();
    renderProgress();
    renderQueue();
    renderCard();
    if (keep !== true) writeRoute(false);
  }
  function facetVal(o, facet) {
    if (facet === "decision") return dstate(o);
    if (facet === "kind") return o.kind;
    if (facet === "tier") return tierOf(o);
    return T.facetVal ? T.facetVal(o, facet) : o[facet];
  }
  function facetCounts(facet, values) {
    var q = FS.q.trim().toLowerCase(), c = {};
    values.forEach(function (v) { c[v] = 0; });
    // the "undecided" option counts what that view will list: lines the tracker does not count are left out (the same rule as match)
    function tally(o, p, v) { if (facet === "decision" && v === "undecided" && !counted(o)) return; if (match(o, p, FS, facet, q) && v in c) c[v]++; }
    // items count under kind (and the facets that put them in view) always, and under decision when the filters let items through
    var items = facet === "kind" || ITEM_FACETS.indexOf(facet) >= 0 || (facet === "decision" && itemsInView(FS));
    cards().forEach(function (p) {
      p.lines.forEach(function (l) { tally(l, p, facetVal(l, facet)); });
      if (items) p.items.forEach(function (it) { tally(it, p, facetVal(it, facet)); });
    });
    return c;
  }
  // size a dropdown to its longest option (plus room for the arrow) so the boxes stay snug; counts are padded to three digits so the width does not jump as the filters change
  function fitSelect(s) {
    var n = 0;
    Array.prototype.forEach.call(s.options, function (o) { n = Math.max(n, o.textContent.replace(/\(\d+\)$/, "(000)").length); });
    s.style.width = (n + 3.5) + "ch";
  }
  // a facet dropdown: "any" plus one option per value with its live count ("accept (3)")
  function facetSelect(id, facet, values, labels, totals) {
    var s = $(id);
    if (!s) return;
    var counts = facetCounts(facet, values), h = '<option value="">any</option>';
    values.forEach(function (v) {
      if (totals && !totals[v] && FS[facet] !== v) return;      // a kind this dataset does not have
      h += '<option value="' + esc(v) + '"' + (FS[facet] === v ? " selected" : "") + ">" + esc(labels[v] || v) + " (" + counts[v] + ")</option>";
    });
    s.innerHTML = h;
    s.value = FS[facet];
    fitSelect(s);
  }
  // a click outside an open dropdown (a filter menu, the theme menu) closes it
  function closeDrops(e) {
    Array.prototype.forEach.call(document.querySelectorAll(".filters details.cdrop, .who details.cdrop"), function (d) {
      if (d.open && !d.contains(e.target)) d.open = false;
    });
  }
  // everyone with a live decision in this dataset
  function fillBy() {
    var seen = {}, s = $("f-by");
    LINES.concat(ITEMS).forEach(function (o) { if (o.reviewed && o.decided_by) seen[o.decided_by] = (seen[o.decided_by] || 0) + 1; });
    if (FS.by && !seen[FS.by]) seen[FS.by] = 0;
    s.innerHTML = '<option value="">anyone</option>' + Object.keys(seen).sort().map(function (k) {
      return '<option value="' + esc(k) + '">' + esc(k) + " (" + seen[k] + ")</option>";
    }).join("");
    s.value = FS.by;
    fitSelect(s);
  }
  function renderChips() {
    if (T.renderChips) T.renderChips();
    fillBy();
    facetSelect("f-decision", "decision", DEC, {});
    var tot = {};
    LINES.forEach(function (l) { tot[l.kind] = 1; });
    ITEMS.forEach(function (i) { tot[i.kind] = 1; });
    facetSelect("f-kind", "kind", LINE_KINDS.concat(ITEM_KINDS.filter(function (k) { return !INFO_KINDS[k]; })), KIND_LABEL, tot);
    var tt = {};
    LINES.forEach(function (l) { tt[tierOf(l)] = 1; });
    facetSelect("f-tier", "tier", ["high", "medium", "low", "untiered"], {untiered: "unrated"}, tt);
  }
  // a tracker may rename the column filter (T.columnNoun) and what a column shows as in it (T.columnText)
  // a tracker may fold several columns into one filter entry (T.columnKey)
  function colKey(v) { return T.columnKey ? T.columnKey(v) : v; }
  function colText(v) { return T.columnText ? T.columnText(v) : v; }
  function fillSelect(id, values) {
    var s = $(id);
    values.forEach(function (v) { var o = document.createElement("option"); o.value = v; o.textContent = id === "f-dir" ? dirLabel(v) : id === "f-column" ? colText(v) : v; s.appendChild(o); });
  }
  function uniq(arr) { return arr.filter(function (x, i) { return x && arr.indexOf(x) === i; }).sort(); }
  function fillFilters() {
    ["f-column", "f-dir"].forEach(function (id) { $(id).innerHTML = '<option value="">any</option>'; });
    var cols = uniq(LINES.map(function (l) { return colKey(l.column); })), order = D.columns || [];
    cols.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib);
    });
    $("f-column-label").textContent = T.columnNoun || "column";
    fillSelect("f-column", cols);
    var LISTED = LINES.concat(ITEMS);
    fillSelect("f-dir", (D.dirs || []).filter(function (d) { return LISTED.some(function (o) { return o.dir === d; }); }));
    if (T.fillFilters) T.fillFilters();
  }
  function initFilters() {
    fillFilters();
    $("filters").addEventListener("click", function (e) {
      var c = e.target.closest("button[data-clear]");
      if (c) { clearOne(c.getAttribute("data-clear")); changed(); }
    });
    ["decision", "kind", "tier", "column", "dir"].concat(T.selectFilters || []).forEach(function (f) {
      if ($("f-" + f)) $("f-" + f).onchange = function () { FS[f] = this.value; changed(); };
    });
    // "decided by" only ever matches decided lines: leave the undecided-only default
    $("f-by").onchange = function () { FS.by = this.value; if (FS.by && FS.decision === "undecided") FS.decision = ""; changed(); };
    $("f-q").oninput = function () { FS.q = this.value; changed(true); };
    $("f-more").onclick = function () { toggleMore(); };
    $("f-active").onclick = function () { S.showActive = !S.showActive; renderActive(); };
    $("f-reset").onclick = function () { FS = defaults(); syncControls(); changed(); };
    if (T.initFilters) T.initFilters();
  }
  function changed(replace) { S.pin = -1; S.stay = {}; S.panel = null; refilter(true); writeRoute(replace === true); }
  function clearOne(id) {
    var d = defaults();
    FS[id] = d[id];
    syncControls();
  }
  function toggleMore(open) {
    var box = $("more-filters");
    box.hidden = open == null ? !box.hidden : !open;
    $("f-more").setAttribute("aria-expanded", String(!box.hidden));
    renderActive();
  }
  function syncControls() {
    ["column", "dir"].forEach(function (f) {
      $("f-" + f).value = FS[f];
      if ($("f-" + f).value !== FS[f]) { FS[f] = ""; $("f-" + f).value = ""; }
    });
    if (T.syncControls) T.syncControls();
    fillBy();
    $("f-q").value = FS.q;
  }
  // Every filter that is set is a removable chip, so a control tucked behind "more filters"
  // never filters silently. The chips stay folded behind an "active filters (n)" button until it is clicked.
  function renderActive() {
    var chips = [], n = 0;
    function chip(id, text, hidden) {
      chips.push('<span class="chip on">' + esc(text) + ' <button type="button" data-clear="' + id +
        '" aria-label="clear ' + esc(text) + '">&times;</button></span>');
      if (hidden) n++;
    }
    if (T.activeChips) T.activeChips(chip, "before");
    if (FS.column) chip("column", (T.columnNoun || "column") + ": " + colText(FS.column), true);
    if (FS.dir) chip("dir", "batch: " + dirLabel(FS.dir), true);
    if (FS.tier) chip("tier", "confidence: " + (FS.tier === "untiered" ? "unrated" : FS.tier), true);
    if (FS.by) chip("by", "decided by: " + FS.by, true);
    if (T.activeChips) T.activeChips(chip, "after");
    if (!chips.length) S.showActive = false;
    $("active-filters").innerHTML = chips.join(" ");
    $("active-filters").hidden = !S.showActive;
    $("f-active").hidden = !chips.length;
    $("f-active").textContent = "active filters" + (chips.length ? " (" + chips.length + ")" : "");
    $("f-active").setAttribute("aria-expanded", String(!!S.showActive));
    $("f-more").textContent = ($("more-filters").hidden ? "more filters" : "fewer filters") + (n ? " (" + n + ")" : "");
  }
  function renderProgress() {
    var total = 0, done = 0, sev = {major: {done: 0, total: 0}, minor: {done: 0, total: 0}};
    LINES.forEach(function (l) {
      if (!counted(l)) return;     // a line the tracker leaves out of the count (pipelines: landed changes)
      var sv = sev[sevOf(l)];
      total++; if (sv) sv.total++; if (cur(l)) { done++; if (sv) sv.done++; }
    });
    S.progress = {done: done, total: total, sev: sev};
  }
  function showProgress() {
    var dlg = $("dialog"), g = S.progress || {done: 0, total: 0, sev: {major: {done: 0, total: 0}, minor: {done: 0, total: 0}}};
    var items = ITEMS.length, calls = ITEMS.filter(function (it) { return it.call && it.reviewed; }).length;
    dlg.setAttribute("data-kind", "progress");
    dlg.innerHTML = "<h3>progress</h3><p>" + esc(S.countText || "") + " in view</p>" +
      '<div class="progress" aria-hidden="true"><div id="progress-bar" style="width:' + (g.total ? 100 * g.done / g.total : 0) + '%"></div></div>' +
      "<p>" + g.done + " of " + g.total + " " + W.lines + " decided &middot; major " + g.sev.major.done + " of " + g.sev.major.total +
      " &middot; minor " + g.sev.minor.done + " of " + g.sev.minor.total + "</p>" +
      (T.progressItems === false ? "" : "<p>" + calls + " of " + items + " items have a call" + (T.progressNote ? T.progressNote() : "") + "</p>") +
      (T.progressHtml ? T.progressHtml() : "") +
      '<div class="actions"><button type="button" id="dlg-close">close</button></div>';
    $("dlg-close").onclick = function () { dlg.close(); };
    dlg.showModal();
  }

  // ---- queue ----
  // "2 items", or "2 of 7 items" when a filter is hiding some of the card's items
  function itemCount(p) {
    var t = p.items.length;
    return p._ni < t ? p._ni + " of " + t + " items" : t + " item" + (t === 1 ? "" : "s");
  }
  // a card is done when it has decidable lines and none is left to decide (items and uncounted lines do not count); "hide done" drops it from the left pane (the open card stays so it does not vanish under the reviewer)
  function cardDone(p) {
    return p.lines.length > 0 && !p.lines.some(isOpen);
  }
  // "hide with items" drops every card that carries items to call (information-only items do not count)
  function cardHasItems(p) {
    return (p.items || []).some(function (it) { return !INFO_KINDS[it.kind]; });
  }
  // a card the queue pane leaves out (hide done / hide with items / not on the tracker's queue tab, T.queueShows), so j / k / J do not step onto it
  function queueHides(i) {
    var p = cards()[i];
    if (!p) return false;
    if (T.queueShows && !T.queueShows(p)) return true;      // even the open card: a tab with nothing in it lists nothing
    return i !== S.pipe && ((S.hideDone && cardDone(p)) || (S.hideItems && cardHasItems(p)));
  }
  function renderQueue() {
    if (T.renderQueue && T.renderQueue()) return;     // the tracker drew the pane itself (GOGPT checklist view)
    var h = [], all = cards(), prev = null;
    S.visible.forEach(function (i) {
      var p = all[i];
      if (queueHides(i)) return;
      // a section header before the first card of a new section (T.queueSection: GOGPT's plant edits / proposed additions / watch list)
      var sec = T.queueSection ? T.queueSection(p, prev, all.filter(function (x, j) { return S.visible.indexOf(j) >= 0 && !queueHides(j); })) : "";
      if (sec) h.push('<li class="qsec">' + sec + "</li>");
      prev = p;
      var dots = {};
      p.lines.forEach(function (l) { dots[tierOf(l)] = 1; });
      var dd = ["high", "medium", "low"].filter(function (t) { return dots[t]; })
        .map(function (t) { return '<span class="dot ' + t + '" data-tip="' + t + ' confidence" role="img" aria-label="' + t + ' confidence"></span>'; }).join("");
      var ts = p._tsev || {}, parts = SEV.filter(function (s) { return ts[s]; }).map(function (s) { return ts[s] + " " + s; });
      var badge = p._todo ? '<span class="n todo">' + (parts.length ? parts.join(" &middot; ") : p._todo) + " to decide</span>"
        : (p._n ? '<span class="n">' + p._n + " &middot; done</span>" : (p._ni ? '<span class="n">' + itemCount(p) + "</span>" : '<span class="n"></span>'));
      if (p._ni && p._todo) badge = '<span class="n">' + itemCount(p) + " &middot; </span>" + badge;
      var inner = T.queueRow ? T.queueRow(p, i, {badge: badge, dots: dd}) :
        '<div class="pname">' + esc(p.name || "(no name)") + '</div><div class="pmeta"><span>' + esc(p.pid) +
        '</span><span class="grow"></span>' + badge + '</div>' + (dd ? '<div class="dots">' + dd + "</div>" : "");
      h.push('<li data-i="' + i + '"' + (i === S.pipe ? ' class="sel"' : "") + ">" + inner + "</li>");
    });
    $("pipes").innerHTML = h.join("");
  }
  function selectPipe(i, lineIdx) {
    if (S.pipe !== i) S.igOpen = {};          // item groups collapse again on a new card
    S.panel = null;
    S.pipe = i;
    S.tab = defaultTab(cards()[i]);
    S.line = lineIdx == null ? -1 : lineIdx;
    // a link straight to a line: open the tab that holds it
    if (S.line >= 0 && LINES[S.line] && S.tab !== sevOf(LINES[S.line])) S.tab = sevOf(LINES[S.line]);
    // T.beforeSelect: the tracker may switch its queue tab to the one holding this card (true when it did)
    var tabMoved = T.beforeSelect ? T.beforeSelect(cards()[i]) : false;
    if (S.hideDone || S.hideItems || tabMoved || T.queueShows) renderQueue();     // the card just left can drop out of the list now that it is no longer open
    var prev = $("pipes").querySelector("li.sel");
    if (prev) prev.classList.remove("sel");
    var li = $("pipes").querySelector('li[data-i="' + i + '"]');
    if (li) { li.classList.add("sel"); li.scrollIntoView({block: "nearest"}); }
    renderCard();
    writeRoute(true);
  }

  // ---- card pieces ----
  function urlLink(u, long) {
    var t = u.length > (long || 78) ? u.slice(0, (long || 78) - 1) + "…" : u;
    if (!/^https?:\/\//i.test(u)) return esc(u);
    return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(t) + " ↗</a>";
  }
  function asList(v) {
    if (Array.isArray(v)) return v.filter(Boolean);
    return String(v || "").split(/,\s*(?=https?:\/\/)|\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  // `tip` shows in the #tip popover on hover / keyboard focus; `note` (optional) scrolls under it when long
  function chip(text, cls, tip, note) {
    return '<span class="chip' + (cls ? " " + cls : "") + '"' + (tip ? ' tabindex="0"' + tipAttrs(tip, note) : "") + ">" + esc(text) + "</span>";
  }
  function tipAttrs(tip, note) {
    return ' data-tip="' + esc(tip) + '"' + (note ? ' data-tip-note="' + esc(note) + '"' : "") +
      ' aria-description="' + esc(tip + (note ? ". note: " + note : "")) + '"';
  }
  function tierChip(l) {
    var t = tierOf(l);
    return chip(t === "untiered" ? "unrated" : t, t === "untiered" ? "" : t,
      t === "untiered" ? "no confidence rating on this record: defaults to hold" : (TIER_TIP[t] || t + " confidence"));
  }
  // major is the default and the value table already tags each edit fill, change or clear, so only a minor line gets a chip
  function sevChip(l) {
    if (T.sevChip) return T.sevChip(l);
    var s = sevOf(l);
    if (s !== "minor") return "";
    return chip("minor · " + (l.reverified ? "checked, stands" : (KIND_LABEL[l.kind] || l.kind)), s, SEV_TIP[s]);
  }
  // One mark per proposed URL: ✓ when it loads, states the value and names the card; else the failed checks.
  function vmark(u, l) {
    if (T.vmark) return T.vmark(u, l);
    var v = (l.verifications || {})[u], who = W.card;
    if (!v) return chip("unchecked", "", "no verification record for this link: url_verifier.py did not check it at staging, so whether it loads, states the value or names the " + who + " is unknown");
    var bad = [];
    if (!v.ok) bad.push("load");
    if (!v.contains_value) bad.push("value");
    if (!v.name_found) bad.push("name");
    var tip = "link checks:\n" +
      (v.ok ? "✓" : "✗") + " loads: the page fetched and its text is readable\n" +
      (v.contains_value ? "✓" : "✗") + " states value: the proposed value is on the page\n" +
      (v.name_found ? "✓" : "✗") + " names " + who + ": the " + who + "'s name is on the page";
    return bad.length ? chip("✗ " + bad.join(", "), "bad", tip, v.note) : chip("✓", "ok", tip, v.note);
  }
  // a URL shortened for the table: host + path, decoded, Wayback shown as "archive › <origin>"
  function shortUrl(u) {
    var s = String(u);
    try { s = decodeURI(s); } catch (e) { /* keep as is */ }
    s = s.replace(/^https?:\/\/(www\.)?/i, "");
    var wb = s.match(/^web\.archive\.org\/web\/\d+[a-z_]*\/(?:https?:\/\/)?(?:www\.)?(.*)$/i);
    if (wb) s = "archive › " + wb[1];
    s = s.replace(/\/$/, "");
    return s.length > 64 ? s.slice(0, 63) + "…" : s;
  }
  function shortLink(u) {
    if (!/^https?:\/\//i.test(u)) return esc(u);
    return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(shortUrl(u)) + "</a>";
  }
  function tag(t) { return t ? '<span class="tag tag-' + t + '">' + t + "</span>" : ""; }
  // a small button that copies `text` (a proposed value or link) to the clipboard; onCardClick handles it
  function copyBtn(text) {
    if (blankv(text)) return "";
    return ' <button type="button" class="copybtn" data-clip="' + esc(text) + '" aria-label="copy"' + tipAttrs("copy to clipboard") + ">⧉</button>";
  }
  // where the current text sits inside the proposed one (whitespace may reflow), or null when it doesn't
  function keptSpan(was, now) {
    var toks = String(was).trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    var m = new RegExp(toks.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("\\s+")).exec(now);
    return m ? [m.index, m.index + m[0].length] : null;
  }
  // a proposed value, tinted `cls`. When it keeps the current text and adds to it, only the added text is tinted.
  function newvHtml(was, now, cls) {
    var s = String(now), k = blankv(was) ? null : keptSpan(was, s);
    function hl(x) {
      var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(x);
      return m[2] ? m[1] + '<span class="newv ' + cls + '">' + esc(m[2]) + "</span>" + m[3] : x;
    }
    if (!k) return hl(s);
    return hl(s.slice(0, k[0])) + '<span class="keptv">' + esc(s.slice(k[0], k[1])) + "</span>" + hl(s.slice(k[1]));
  }
  // Characters that look like (or are hidden next to) plain ones: a change that only swaps these reads
  // as no change on screen, so the card names them. [character, its name, the plain form]
  var LOOKALIKE = [[" ", "a non-breaking space", " "], [" ", "a narrow non-breaking space", " "], [" ", "a thin space", " "],
    [" ", "a figure space", " "], [" ", "an en space", " "], [" ", "an em space", " "], ["\t", "a tab", " "],
    ["‐", "a Unicode hyphen", "-"], ["‑", "a non-breaking hyphen", "-"], ["‒", "a figure dash", "-"],
    ["–", "an en dash", "-"], ["—", "an em dash", "-"], ["−", "a minus sign", "-"], ["­", "a soft hyphen", ""],
    ["​", "a zero-width space", ""], ["‌", "a zero-width non-joiner", ""], ["‍", "a zero-width joiner", ""],
    ["⁠", "a word joiner", ""], ["﻿", "a byte order mark", ""],
    ["‘", "a curly opening quote", "'"], ["’", "a curly closing quote", "'"], ["“", "a curly opening double quote", '"'], ["”", "a curly closing double quote", '"']];
  function foldChars(s) {
    s = String(s == null ? "" : s);
    LOOKALIKE.forEach(function (x) { s = s.split(x[0]).join(x[2]); });
    return s.replace(/ {2,}/g, " ").trim();
  }
  function plainName(ch) { return ch === " " ? "a plain space" : ch === "-" ? "a plain hyphen" : ch === "'" ? "a straight quote" : ch === '"' ? "a straight double quote" : ""; }
  function codeOf(ch) { return "U+" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"); }
  // when `was` and `now` differ only by such characters (or runs of spaces), one plain sentence that says
  // which characters change; "" when the visible text differs too
  function charOnlyChange(was, now) {
    if (blankv(was) || blankv(now)) return "";
    var a = String(was).trim(), b = String(now).trim();
    if (a === b || foldChars(a) !== foldChars(b)) return "";
    var parts = [];
    LOOKALIKE.forEach(function (x) {
      var n = a.split(x[0]).length - 1, m = b.split(x[0]).length - 1;
      if (n > m) {
        var to = x[2] ? plainName(x[2]) : "";
        parts.push((n - m > 1 ? (n - m) + " of " : "") + x[1] + " (" + codeOf(x[0]) + ")" + (to ? " becomes " + to : " is removed"));
      } else if (m > n) parts.push(x[1] + " (" + codeOf(x[0]) + ") is added");
    });
    if (!parts.length) parts.push("the spacing changes");
    return "Same text as now. Only hidden characters change: " + parts.join("; ") + ".";
  }
  // one value row: field | now | proposed | tag
  function valueRow(c, was, now, reverified, l) {
    var wasH = blankv(was) ? "" : "<span>" + esc(was) + "</span>";
    var nowH, t = "", same = false, chars = charOnlyChange(was, now);
    if (!blankv(was) && String(was).trim() === String(now).trim()) { nowH = wasH; same = true; t = reverified ? "re-verified" : ""; }
    else if (blankv(now)) { nowH = '<span class="newv c-' + tierOf(l || {}) + '">(clear)</span>'; t = "clear"; }
    else if (chars) { t = "characters"; nowH = '<span class="newv c-' + tierOf(l || {}) + '">' + esc(now) + "</span>" + copyBtn(now) + '<div class="charnote">' + esc(chars) + "</div>"; }
    else { t = blankv(was) ? "fill" : "change"; nowH = newvHtml(was, now, "c-" + tierOf(l || {})) + copyBtn(now); }
    return '<tr class="' + (same ? "same" : "") + '"><td class="f">' + esc(c) + "</td><td>" + wasH + "</td><td>" + nowH + '</td><td class="t">' + tag(t) + "</td></tr>";
  }
  function valueRows(l) {
    var pv = l.proposed_values || {}, cols = Object.keys(pv), curv = l.current || {};
    if (!cols.length) cols = l.columns || [l.column];
    return cols.map(function (c) {
      if (!(c in pv) && blankv(curv[c])) return "";
      return valueRow(c, curv[c], c in pv ? pv[c] : curv[c], l.reverified, l);
    }).join("");
  }
  // the Data Source row: the cell now, and the cell it would be. Links are ADDED next to the ones
  // already there (the manual's merge rule: a Data Source is never replaced or deleted).
  function refRow(l) {
    var col = l.ref_col || "Data Source";
    var curr = asList(l.current_ref), prop = asList(l.proposed_refs);
    var added = prop.filter(function (u) { return curr.indexOf(u) < 0; });
    var nowH = curr.length ? "<ul>" + curr.map(function (u) { return "<li>" + shortLink(u) + "</li>"; }).join("") + "</ul>" : "";
    var propH, t;
    if (!prop.length) { propH = '<span class="muted">no link proposed' + (l.kind === "delete" ? " (the value is cleared; the links stay)" : "") + "</span>"; t = ""; }
    else {
      t = !curr.length ? "fill" : (added.length ? "add" : "");
      propH = "<ul>" + curr.map(function (u) { return '<li class="kept">' + shortLink(u) + "</li>"; }).join("") +
        added.map(function (u) { return '<li><span class="newref c-' + tierOf(l) + '">' + shortLink(u) + "</span>" + copyBtn(u) + " " + vmark(u, l) + "</li>"; }).join("") + "</ul>";
    }
    return '<tr class="ref"><td class="f">' + esc(col) + "</td><td>" + nowH + "</td><td>" + propH + '</td><td class="t">' + tag(t) + "</td></tr>";
  }
  function pairTable(rows) {
    return '<table class="pair"><thead><tr><th></th><th>now</th><th>proposed</th><th></th></tr></thead><tbody>' + rows + "</tbody></table>";
  }
  function lineBody(l) {
    if (T.lineBody) { var x = T.lineBody(l, cards()[l._p]); if (x != null) return x; }
    return pairTable(valueRows(l) + refRow(l));
  }
  function detailsHtml(l) {
    if (T.lineDetails) { var x = T.lineDetails(l); if (x != null) return x; }
    var d = [];
    if (l.action) d.push('<div class="dtxt"><span class="k">' + (T.actionLabel || "what to do in the GEM form") + '</span>' + linkText(l.action) + "</div>");
    if (l.notes) d.push('<div class="dtxt"><span class="k">researcher notes</span>' + linkText(l.notes) + "</div>");
    var vs = l.verifications || {};
    Object.keys(vs).forEach(function (u) {
      if (vs[u] && vs[u].note) d.push('<div class="dtxt"><span class="k">' + esc(u) + ":</span> " + esc(vs[u].note) + "</div>");
    });
    if (T.hideRecord) return '<details data-more><summary>notes</summary>' + d.join("") + "</details>";   // a tracker whose reviewers do not need the record line
    var misc = ["batch " + dirLabel(l.dir), "default " + (l.default || "hold"), "record " + (l.record_id || "?")];
    if (l.source_language && l.source_language !== "en") misc.push("source language " + l.source_language);
    if (l.lane) misc.push("lane " + l.lane);
    d.push('<div class="dtxt"><span class="k">record:</span> ' + esc(misc.join(" · ")) + "</div>");
    return '<details data-more><summary>notes &amp; record</summary>' + d.join("") + "</details>";
  }
  // The calls a line offers: [[decision, label, tip], ...] plus whether the suggest form is on.
  // A tracker's lineActions(line) replaces the default (GOGPT's "no suggested changes" line offers checked / hold for later).
  var DEFAULT_ACTIONS = {buttons: [["accept", "accept", ""], ["hold", "hold", ""], ["reject", "reject", ""]], suggest: true};
  function lineActions(l) {
    var a = T.lineActions ? T.lineActions(l) : null;
    return a || DEFAULT_ACTIONS;
  }
  function offers(l, decision) {
    var a = lineActions(l);
    if (decision === "suggest") return a.suggest !== false;
    return a.buttons.some(function (b) { return b[0] === decision; });
  }
  function lineHtml(l) {
    var chips = T.lineChips ? T.lineChips(l, [tierChip(l), sevChip(l)]) : [tierChip(l), sevChip(l)];
    var title = T.lineTitle ? T.lineTitle(l) : (l.column || "");
    var where = T.lineWhere ? T.lineWhere(l) : (l.row_label || "");
    var h = '<div class="row1"><span class="col">' + esc(title) + "</span> " + chips.filter(Boolean).join(" ") +
      '<span class="where">' + esc(where) + "</span></div>";
    h += lineBody(l);
    var dis = !Store.caps.decide, acts = lineActions(l);
    h += '<div class="controls">' + acts.buttons.map(function (b) {
      return '<button type="button" class="b-' + b[0] + '" data-decide="' + b[0] + '"' +
        (dis ? tipAttrs(NOT_YET) + ' aria-disabled="true"' : (b[2] ? tipAttrs(b[2]) : "")) +
        ' aria-pressed="' + (cur(l) === b[0]) + '">' + esc(b[1] || b[0]) + "</button>";
    }).join("") + (T.lineButtons ? T.lineButtons(l) : "") + (acts.suggest === false ? "" : '<button type="button" class="b-suggest" data-suggest="1"' + (dis ? ' aria-disabled="true"' + tipAttrs(NOT_YET) : "") +
      ' aria-pressed="' + (T.suggestPressed ? !!T.suggestPressed(l) : cur(l) === "suggest") + '">suggest</button>') + (cur(l) ? '<button type="button" class="ghost" data-undo="1">undo</button>' : "") +
      (noteBox(l) ? '<input type="text" class="dnote" data-dnote="' + l._i + '" autocomplete="off" placeholder="note: why (optional)" aria-label="note on this call, optional"' +
      ' value="' + esc(noteOf(l)) + '"' + (dis ? " disabled" : "") + ">" : "") +
      (T.lineControls ? T.lineControls(l) : "") +
      '<span class="dstat" id="dstat-' + l._i + '" role="status">' + esc(decisionText(l)) + "</span></div>";
    h += detailsHtml(l);
    return h;
  }

  // ---- items ----
  var HIDE = {call_note: 1, call_reference: 1, decided_by: 1, decided_at: 1, key: 1, dir: 1, record_id: 1, call: 1, reviewed: 1, kind: 1,
              links: 1, verifications: 1, _item: 1, _p: 1, _i: 1};
  var BODY_LABEL = {finding: "found", recommendation: "suggest", reason: "reason", lookup_result: "lookup result"};   // body keys and their labels (T.body adds or relabels)
  var LEAD_MAX = 480;        // the open body shows at most this much of a note that has no finding
  var ABBR = /\b(?:[A-Z]|Mr|Mrs|Ms|Dr|St|No|vs|approx|Inc|Co|Corp|Ltd|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|e\.g|i\.e)\.$/;
  // The first n sentences of a note, cut at a sentence end (never mid-word): {text, cut}
  function leadOf(t, n) {
    t = String(t || "").trim();
    var re = /[.!?]["')\]]?(?=\s+[A-Z0-9"(\[])/g, m, ends = [];
    while ((m = re.exec(t))) {
      var end = m.index + m[0].length;
      if (!ABBR.test(t.slice(0, end).replace(/["')\]]$/, ""))) ends.push(end);
    }
    var lead = t;
    if (ends.length >= n && ends[n - 1] < t.length) lead = t.slice(0, ends[n - 1]);
    if (lead.length > LEAD_MAX && ends.length && ends[0] < lead.length) lead = t.slice(0, ends[0]);
    if (lead.length > LEAD_MAX) lead = t.slice(0, LEAD_MAX).replace(/\s+\S*$/, "") + "\u2026";
    return {text: lead, cut: lead.length < t.length};
  }
  function bodyLine(k, t) { return '<div class="body"><span class="k">' + esc(BODY_LABEL[k] || k.replace(/_/g, " ")) + "</span>" + linkText(t) + "</div>"; }
  var INFO_KINDS = {};       // item kinds shown for information only: no call, not listed on the card
  function itemHead(it) { return T.itemHead ? T.itemHead(it) : (it.title || kindLabel(it)); }
  // The open body: what was found and what to do (finding, recommendation; reason and lookup result for watch and entity items), then the links.
  // The researcher note sits under a notes dropdown with the record line; without a finding its first two sentences open the body instead.
  function itemBody(it) {
    if (T.itemBody) { var x = T.itemBody(it); if (x) return x; }
    var h = "", used = {}, notes = typeof it.notes === "string" && !blankv(it.notes) ? it.notes : "", folded = !!notes;
    if (typeof it.finding === "string" && !blankv(it.finding)) { h += bodyLine("finding", it.finding); used.finding = 1; }
    else if (notes) {
      var lead = leadOf(notes, 2);
      h += '<div class="body">' + linkText(lead.text) + "</div>";
      if (!lead.cut) { used.notes = 1; folded = false; }
    }
    Object.keys(BODY_LABEL).forEach(function (k) {
      if (k === "finding" || blankv(it[k]) || typeof it[k] !== "string") return;
      h += bodyLine(k, it[k]);
      used[k] = 1;
    });
    var links = asList(it.links);
    if (links.length) {
      h += '<div class="body">' + links.map(function (u) {
        var v = (it.verifications || {})[u];
        return urlLink(u) + (v ? " " + vmark(u, it) : "");
      }).join("<br>") + "</div>";
    }
    var d = [];
    if (folded) { d.push('<div class="dtxt"><span class="k">researcher notes</span>' + linkText(notes) + "</div>"); used.notes = 1; }
    if (!T.hideRecord) d.push('<div class="dtxt"><span class="k">record:</span> ' + esc("batch " + dirLabel(it.dir) + " \u00b7 record " + (it.record_id || "?")) + "</div>");
    if (d.length) h += '<details data-more><summary>' + (folded ? (T.hideRecord ? "notes" : "notes &amp; record") : "record") + "</summary>" + d.join("") + "</details>";
    return {html: h, used: used};
  }
  function fieldRows(it, used) {
    var rows = [];
    Object.keys(it).forEach(function (k) {
      if (HIDE[k] || used[k] || k.charAt(0) === "_" || (T.hideField && T.hideField(k, it))) return;
      var v = it[k];
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
      var t;
      if (Array.isArray(v) && v.every(function (x) { return typeof x === "string"; })) t = v.map(function (x) { return /^https?:/.test(x) ? urlLink(x) : esc(x); }).join("<br>");
      else if (typeof v === "object") t = esc(JSON.stringify(v).slice(0, 400));
      else t = /^https?:\/\//.test(String(v)) ? urlLink(String(v)) : esc(v);
      rows.push("<tr><td>" + esc(T.fieldLabel ? T.fieldLabel(k) : k.replace(/_/g, " ")) + "</td><td>" + t + "</td></tr>");
    });
    return rows;
  }
  function itemHtml(it) {
    var b = itemBody(it), rows = fieldRows(it, b.used);
    var where = T.itemWhere ? T.itemWhere(it) : (it.where || W.card);
    var cls = T.itemClass ? T.itemClass(it) : "";
    var h = '<div class="item' + (it.call && it.reviewed ? " done" : "") + cls + '"><div class="row1">' + chip(kindLabel(it), T.kindClass ? T.kindClass(it) : "", kindTip(it)) +
      " <b>" + esc(itemHead(it)) + "</b> " + (T.itemChips ? T.itemChips(it) : "") +
      '<span class="where">' + esc(where) + "</span></div>";
    if (T.itemFacts) h += T.itemFacts(it);
    h += b.html;
    if (rows.length) h += "<details><summary>all fields</summary><table class=\"rowdata\">" + rows.join("") + "</table></details>";
    return h + itemControls(it) + "</div>";
  }
  function itemVocab(it) { return T.itemCalls ? T.itemCalls(it.kind, it) || ITEM_CALLS[it.kind] || OTHER_CALLS : ITEM_CALLS[it.kind] || OTHER_CALLS; }
  function callText(c) { return CALL_LABEL[c] || String(c || "").replace(/_/g, " "); }
  function itemStat(it) {
    return it.call && it.reviewed ? (callText(it.call) + " by " + (it.decided_by || "?") + " " + timeOf(it.decided_at)) : "";
  }
  function itemControls(it) {
    var dis = !Store.caps.decide, v = itemVocab(it);
    var opts = '<option value="">no call</option>' + v.map(function (c) {
      return '<option value="' + c + '"' + (it.call === c ? " selected" : "") + ' title="' + esc(CALL_HELP[c] || "") + '">' + esc(callText(c)) + "</option>";
    }).join("");
    var hint = CALL_HINT[it.kind] || CALL_HINT.other || "";
    var refs = T.references != null ? T.references : TB.references;
    return '<div class="icall"><label' + (dis ? tipAttrs(NOT_YET) : (hint ? tipAttrs(hint) : "")) + '>call <select data-icall="' + it._i + '"' + (dis ? " disabled" : "") + ">" + opts + "</select></label>" +
      '<input type="text" data-inote="' + it._i + '" placeholder="note' + (T.itemNoteHint ? T.itemNoteHint(it) : "") + '" value="' + esc(it.call_note || "") + '"' + (dis ? " disabled" : "") + ">" +
      (refs ? '<input type="url" data-iref="' + it._i + '" placeholder="source link, if you have one" value="' + esc(it.call_reference || "") + '"' + (dis ? " disabled" : "") + ">" : "") +
      (T.itemControls ? T.itemControls(it) : "") +
      '<span class="dstat" id="istat-' + it._i + '" role="status">' + esc(itemStat(it)) + "</span></div>";
  }
  function isOpenItem(it) { return !(it.call && it.reviewed); }
  // items grouped (T.itemGroup, else by kind), each group a collapsible section; `only` restricts to the items the filters let through
  function itemsHtml(p, only) {
    var q = FS.q.trim().toLowerCase(), list = p.items.filter(function (it) { return !INFO_KINDS[it.kind]; }), total = list.length;
    if (only) list = list.filter(function (it) { return match(it, p, FS, null, q); });
    var hidden = total - list.length;
    if (!list.length) return '<div class="hiddennote">' + (hidden ? hidden + " item" + (hidden === 1 ? " is" : "s are") + ' hidden by the filter. <a href="#" class="only" data-showall="1">show all</a>' : "nothing to decide on this " + W.card + ".") + "</div>";
    var G = T.itemGroup || {of: function (it) { return it.kind; }, order: function () { return ITEM_KINDS.slice(); },
                            label: function (g) { return KIND_LABEL[g] || g; }};
    var by = {}, order = G.order();
    list.forEach(function (it) { var g = G.of(it); (by[g] = by[g] || []).push(it); if (order.indexOf(g) < 0) order.push(g); });
    var h = '<section class="items">';
    order.forEach(function (g) {
      if (!by[g]) return;
      // every group starts collapsed on a freshly opened card unless it is the only one; a group the
      // reviewer opens stays open across re-renders of the SAME card (igOpen resets in selectPipe)
      var open = g in S.igOpen ? S.igOpen[g] : T.openLoneGroup !== false && order.filter(function (x) { return by[x]; }).length === 1;
      var nOpen = by[g].filter(isOpenItem).length;
      var cnt = T.groupCount ? T.groupCount(by[g], nOpen) : "(" + (nOpen ? nOpen + " open of " + by[g].length : by[g].length + ", all called") + ")";
      h += '<details class="igroup" data-g="' + esc(g) + '"' + (open ? " open" : "") + "><summary>" + esc(G.label(g)) +
        ' <span class="n">' + cnt + "</span></summary>" +
        by[g].map(itemHtml).join("") + "</details>";
    });
    if (hidden) h += '<div class="hiddennote">' + hidden + " more item" + (hidden === 1 ? " is" : "s are") + ' hidden by the filter. <a href="#" class="only" data-showall="1">show all</a></div>';
    return h + "</section>";
  }

  // ---- card ----
  function tierSummary(p) {
    var c = {high: 0, medium: 0, low: 0, untiered: 0};
    p.lines.forEach(function (l) { c[tierOf(l)]++; });
    return ["high", "medium", "low", "untiered"].filter(function (t) { return c[t]; })
      .map(function (t) { return chip(c[t] + " " + (t === "untiered" ? "unrated" : t), t === "untiered" ? "" : t); }).join(" ");
  }
  // the three bulk buttons on a card head: accept the minor changes, the high-confidence ones, or all of them.
  // A button is live only when a line it covers is open (isOpen), the same rule bulk accept uses to pick its lines.
  function bulkButtons(p) {
    var wc = W.card, wl = W.lines;
    return (function () {
        var minor = p.lines.filter(function (l) { return sevOf(l) === "minor"; });
        var on = minor.some(isOpen);
        var why = !minor.length ? "no minor " + wl + " on this " + wc : "no minor " + W.line + " on this " + wc + " is waiting on a call";
        return '<button type="button" class="bulk b-accept' + (on ? "" : " off") + '" data-bulk="bulk-minor"' + (on ? "" : ' aria-disabled="true" data-why="' + esc(why) + '"') +
          tipAttrs(on ? "accept every undecided minor " + W.line + " on this " + wc + " (the values stand, only links are added) that the filters show" : why) + '>accept all minor ' + wl + '</button>';
      })() +
      '<button type="button" class="bulk b-accept" data-bulk="bulk-high"' + tipAttrs("accept every undecided green (high confidence) " + W.line + " on this " + wc + ", major or minor, that the filters show") + '>accept all high-conf ' + wl + '</button>' +
      (function () {
        var nonHigh = p.lines.filter(function (l) { return tierOf(l) !== "high"; });
        var on = nonHigh.some(isOpen);
        var why = !nonHigh.length ? "every " + W.line + " is high confidence" : "no medium- or low-confidence " + W.line + " on this " + wc + " is waiting on a call";
        return '<button type="button" class="bulk b-hold' + (on ? "" : " off") + '" data-bulk="bulk-all"' + (on ? "" : ' aria-disabled="true" data-why="' + esc(why) + '"') +
          tipAttrs(on ? "accept every undecided " + W.line + " on this " + wc + ", any confidence level, that the filters show" : why) + '>accept all ' + wl + '</button>';
      })();
  }
  function renderCard() {
    var card = $("card");
    if (S.panel && T.cardPanel) { card.innerHTML = T.cardPanel(S.panel); S.shown = []; return; }
    if (S.pipe < 0) { card.innerHTML = '<div class="empty">nothing matches the filters.</div>'; S.shown = []; return; }
    var p = cards()[S.pipe], q = FS.q.trim().toLowerCase();
    var ctx = (T.cardContext ? T.cardContext(p) : [tierSummary(p)])
      .filter(Boolean).map(function (x) { return "<span>" + x + "</span>"; }).join("");
    var sub = T.cardSub ? T.cardSub(p) : "";
    // a flat card (T.flatCard: GOGPT's addition and watch cards) has no tabs: every line, then the items
    var flat = !!(T.flatCard && T.flatCard(p));
    var bulk = T.bulkButtons ? T.bulkButtons(p) : null;      // null: the tracker leaves the core buttons
    var h = '<div class="cardhead"><div class="headrow">' + "<h2>" + (T.showPid && !T.showPid(p) ? "" : '<span class="pid"' + tipAttrs(T.pidTip || "click to copy the id") + '>' + esc(T.pidText ? T.pidText(p) : p.pid) + "</span>") +
      '<a href="#" class="only" data-tab="all"' + tipAttrs("review everything on this " + W.card + ": every " + W.line + " (filters ignored) and every item") + '>' + esc(p.name || "(no name)") + "</a>" + copyBtn(p.name) +
      (sub ? '<span class="hseg">' + esc(sub) + "</span>" : "") + '</h2><div class="bulkbtns">' +
      (bulk == null ? bulkButtons(p) : bulk) +
      '</div></div><div class="ctx">' + ctx + "</div>";
    if (flat) {
      S.shown = [];
      h += '<div class="flatcard">';
      p.lines.forEach(function (l) {
        S.shown.push(l._i);
        h += '<div class="line tier-' + tierOf(l) + (cur(l) ? " d-" + cur(l) : "") + ((T.dimmed ? T.dimmed(l) : grayed(l)) ? " dim" : "") +
          (T.lineClass ? T.lineClass(l) : "") + (l._i === S.line ? " cur" : "") + '" id="line-' + l._i + '" data-i="' + l._i + '">' + lineHtml(l) + "</div>";
      });
      if (p.items.some(function (it) { return !INFO_KINDS[it.kind]; })) h += itemsHtml(p);
      card.innerHTML = h + "</div>";
      if (S.line < 0 || S.shown.indexOf(S.line) < 0) S.line = S.shown.length ? S.shown[0] : -1;
      var fel = S.line >= 0 && $("line-" + S.line);
      if (fel) fel.classList.add("cur");
      return;
    }
    var nOpenItems = p.items.filter(function (it) { return !it.call && !INFO_KINDS[it.kind]; }).length, nItems = p.items.filter(function (it) { return !INFO_KINDS[it.kind]; }).length;
    function todo(n, total) {
      if (!total) return "(0)";
      if (!n) return "(" + total + ", all decided)";
      return "(" + (n === total ? n : n + " of " + total) + " to decide)";
    }
    var bySev = {major: p.lines.filter(function (l) { return sevOf(l) === "major"; }), minor: p.lines.filter(function (l) { return sevOf(l) === "minor"; })};
    // T.collapseTabs: only the major tab shows until the + opens the rest; a card open on another tab shows them all
    var folded = !!T.collapseTabs && !S.moreTabs && S.tab === "major";
    var fold = !T.collapseTabs ? "" : '<button type="button" class="tabfold" data-tabfold="' + (folded ? "open" : "close") + '" aria-expanded="' + !folded + '"' +
      tipAttrs(folded ? "show the minor changes, items and everything tabs" : "hide the minor changes, items and everything tabs") + ">" + (folded ? "+" : "&minus;") + "</button>";
    h += '<div class="tabs" role="tablist">' + (folded ? ["major"] : SEV).map(function (s) {
      // the tab counts leave out the lines the tracker does not count (T.counted; pipelines: changes the backend already holds)
      var live = bySev[s].filter(counted);
      var openS = live.filter(function (l) { return !cur(l); }).length;
      var inView = live.filter(function (l) { return match(l, p, FS, null, FS.q.trim().toLowerCase()); }).length;
      var hid = live.length - inView;
      return '<button type="button" role="tab" data-tab="' + s + '" aria-selected="' + (S.tab === s) + '"' + tipAttrs(hid ? SEV_TIP[s] + ". The filters show " + inView + " of " + live.length + " here; the count below ignores them" : SEV_TIP[s]) + ">" +
        SEV_LABEL[s] + " " + todo(openS, live.length) + (hid ? ' <span class="n">&middot; ' + inView + " shown</span>" : "") + "</button>" + (s === "major" && folded ? fold : "");
    }).join("") + (folded ? "</div></div>" :
      '<button type="button" role="tab" data-tab="items" aria-selected="' + (S.tab === "items") + '"' + (p._ni < nItems && itemsInView(FS) ? tipAttrs("the filters show " + p._ni + " of this " + W.card + "'s " + nItems + " items here; this tab lists all of them, and the count ignores the filters") : "") + ">items " + todo(nOpenItems, nItems) + (p._ni < nItems && itemsInView(FS) ? ' <span class="n">&middot; ' + p._ni + " shown</span>" : "") + "</button>" +
      '<button type="button" role="tab" data-tab="all" aria-selected="' + (S.tab === "all") + '"' + tipAttrs("every " + W.line + " (filters ignored) and every item on this " + W.card + "; also: click the name") + '>everything</button>' + fold + "</div></div>");
    if (S.tab === "items") {
      S.shown = []; S.line = -1;
      // with a filter that puts items in view, the items tab shows the matching items only
      card.innerHTML = h + itemsHtml(p, S.pin !== S.pipe && itemsInView(FS));
      return;
    }
    // lines the filter lets through, grouped the tracker's way (T.groupLines: units, segments)
    var all = S.tab === "all";
    var base = bySev[S.tab] || p.lines;
    var keep = all ? p.lines.slice() : base.filter(function (l) { return match(l, p, FS, null, q); });
    var hidden = base.length - keep.length;
    if (S.pin === S.pipe && !keep.length) { keep = base.slice(); hidden = 0; }
    var groups = (T.groupLines && T.groupLines(p, keep)) || [{label: "", lines: keep, plain: true}];
    S.shown = [];
    var firstSeg = true;
    groups.forEach(function (g) {
      if (!g.lines.length) return;
      // the first group heading sits right under the tab strip, so it needs no rule of its own
      if (!g.plain) { h += '<div class="segdiv' + (firstSeg ? " first" : "") + '">' + (g.html != null ? g.html : esc(g.label)) + "</div>"; firstSeg = false; }
      g.lines.forEach(function (l) {
        S.shown.push(l._i);
        h += '<div class="line tier-' + tierOf(l) + (cur(l) ? " d-" + cur(l) : "") + ((T.dimmed ? T.dimmed(l) : grayed(l)) ? " dim" : "") +
          (T.lineClass ? T.lineClass(l) : "") + (l._i === S.line ? " cur" : "") + '" id="line-' + l._i + '" data-i="' + l._i + '">' + lineHtml(l) + "</div>";
      });
    });
    if (hidden) h += '<div class="hiddennote">' + hidden + " more " + (hidden === 1 ? W.line : W.lines) + " on this " + W.card + " " + (hidden === 1 ? "is" : "are") +
      ' hidden by the filter. <a href="#" class="only" data-showall="1">show all</a></div>';
    if (!keep.length && !hidden) h += '<div class="hiddennote">no ' + (SEV_LABEL[S.tab] || W.lines) + ' on this ' + W.card + '.</div>';
    if (all) h += '<h3 class="allitems">items</h3>' + itemsHtml(p);
    card.innerHTML = h;
    if (S.line < 0 || S.shown.indexOf(S.line) < 0) S.line = S.shown.length ? S.shown[0] : -1;
    var el = S.line >= 0 && $("line-" + S.line);
    if (el) el.classList.add("cur");
  }
  function setLine(i, noScroll) {
    var prev = S.line >= 0 && $("line-" + S.line);
    if (prev) prev.classList.remove("cur");
    S.line = i;
    var el = $("line-" + i);
    if (el) { el.classList.add("cur"); if (!noScroll) el.scrollIntoView({block: "nearest"}); }
  }

  // ---- keyboard navigation ----
  // a line kept in view only because it was decided this session (the decision filter would drop it): j / k pass over it, shift+k comes back to it
  function pinnedOnly(i) {
    var o = LINES[i];
    return !!(o && S.stay[o.key] && FS.decision && dstate(o) !== FS.decision);
  }
  function stepLine(dir, all) {
    var at = S.shown.indexOf(S.line), n = at + dir;
    while (!all && n >= 0 && n < S.shown.length && S.shown[n] !== S.line && pinnedOnly(S.shown[n])) n += dir;
    if (n >= 0 && n < S.shown.length) return setLine(S.shown[n]);
    stepPipe(dir, dir < 0);
  }
  function stepPipe(dir, toLast) {
    var at = S.visible.indexOf(S.pipe), n = at + dir;
    while (n >= 0 && n < S.visible.length && queueHides(S.visible[n])) n += dir;
    if (n < 0 || n >= S.visible.length) return;
    selectPipe(S.visible[n]);
    if (toLast && S.shown.length) setLine(S.shown[S.shown.length - 1]);
  }
  function firstRef(l) {
    if (!l) return "";
    if (T.firstRef) { var x = T.firstRef(l); if (x != null) return x; }
    return asList(l.proposed_refs)[0] || asList(l.current_ref)[0] || "";
  }
  function openFirstRef() {
    var l = LINES[S.line], u = firstRef(l);
    if (u && T.openRef && T.openRef(u, l)) return;      // the tracker opens it its own way (pipelines: a route map, Store.open)
    if (u) window.open(u, "_blank", "noopener"); else toast("this " + W.line + " has no link to open");
  }
  function notYet() { toast(NOT_YET); }
  function setStat(i, text, failed) {
    var e = $("dstat-" + i);
    if (e) { e.textContent = text; e.className = "dstat" + (failed ? " err" : (text === "saving…" ? " saving" : "")); }
  }
  // ---- every line save goes through commit: the lines are snapshotted first (S.history, for "undo last"), then saved, then the records land ----
  var HISTORY_MAX = 50;
  function snap(l) {
    var s = {key: l.key, decided: !!cur(l), decision: l.decision, suggested_value: l.suggested_value || "", reference: l.reference || "", note: l.decision_note || ""};
    if (T.snapshot) s.extra = T.snapshot(l);       // the tracker's own record fields to put back (LNG: suggest_kind, suggested_refs)
    return s;
  }
  function restoreRec(s) {
    if (!s.decided) return {key: s.key, undo: true, via: "undo"};
    var r = {key: s.key, decision: s.decision, note: s.note, reference: s.reference, via: "undo"};
    if (s.decision === "suggest") r.suggested_value = s.suggested_value;
    if (s.extra) Object.keys(s.extra).forEach(function (k) { r[k] = s.extra[k]; });
    return r;
  }
  function commit(recs, label, undoing) {
    var before = recs.map(function (r) { return LINE_BY_KEY[r.key]; }).filter(Boolean).map(snap);
    return Store.decide(recs).then(function (saved) {
      if (!undoing) { S.history.push({label: label, snaps: before}); if (S.history.length > HISTORY_MAX) S.history.shift(); }
      applySaved(saved);
      recs.forEach(function (r) { delete S.notes[r.key]; S.stay[r.key] = true; });
      banner("");
      return saved;
    });
  }
  function lineName(l) { return T.lineTitle ? T.lineTitle(l) : (l.column || W.line); }
  // "undo last": puts back the lines of the newest save as they were before it, one save per press
  function undoLast() {
    if (!Store.caps.decide) return notYet();
    var h = S.history.pop();
    if (!h) return toast("nothing to undo this session");
    var keepLine = S.line;
    commit(h.snaps.map(restoreRec), "", true).then(function (saved) {
      refilter(true);
      if (T.afterSave) T.afterSave(saved);
      if (keepLine >= 0 && $("line-" + keepLine)) setLine(keepLine, true);
      toast("undone: " + h.label + (S.history.length ? " · press U again for the one before" : ""));
    }, function (e) { S.history.push(h); toast("undo not saved: " + e.message); });
  }
  // Linked pairs (T.partners(l) -> [{line, strict}]): a call on one asks about the other. A strict pair is both or neither.
  function partnersFor(l, rec) {
    if (!T.partners || rec.decision === "suggest") return [];
    return (T.partners(l) || []).filter(function (x) {
      var p = x && x.line;
      if (!p || p.key === l.key || S.saving[p.key]) return false;
      return rec.undo ? !!cur(p) : cur(p) !== rec.decision && offers(p, rec.decision);
    });
  }
  function askLinked(l, rec, parts, go) {
    var strict = parts.some(function (x) { return x.strict; });
    if (!strict && S.linkSkip) return go(S.linkSkip === "both" ? parts : []);
    var dlg = $("dialog"), what = rec.undo ? "undo" : (rec.decision || "");
    var names = parts.map(function (x) { return "<b>" + esc(lineName(x.line)) + "</b>"; }).join(", ");
    dlg.setAttribute("data-kind", "linked");
    dlg.innerHTML = "<h3>" + esc(what) + " " + esc(lineName(l)) + "</h3><p>" + esc(lineName(l)) + " goes with " + names + ". " +
      (strict ? "These two are decided together." : "Do the same to " + (parts.length === 1 ? "it" : "them") + "?") + "</p>" +
      (strict ? "" : '<label class="faint"><input type="checkbox" id="dlg-skip"> don\'t ask again this session (give the same answer next time)</label>') +
      '<div class="actions"><button type="button" class="ghost" id="dlg-cancel">cancel</button>' +
      (strict ? "" : '<button type="button" class="dlg-alt" id="dlg-one">only this one</button>') +
      '<button type="button" class="dlg-ok" id="dlg-both">' + (parts.length === 1 ? "both" : "all " + (parts.length + 1)) + "</button></div>";
    function close(answer) { if (!strict && $("dlg-skip") && $("dlg-skip").checked) S.linkSkip = answer; dlg.close(); }
    $("dlg-cancel").onclick = function () { dlg.close(); };
    if (!strict) $("dlg-one").onclick = function () { close("one"); go([]); };
    $("dlg-both").onclick = function () { close("both"); go(parts); };
    dlg.showModal();
  }
  // Save one line's call. The UI changes only after the server confirms; while it is in flight the
  // line says "saving…", then "accepted by <reviewer> <time>" (or the refusal). No confirm dialog,
  // except the linked-pair question when the line has a partner.
  function save(l, rec, advance) {
    if (!Store.caps.decide) return notYet();
    if (S.saving[l.key]) return;
    var parts = partnersFor(l, rec);
    if (!parts.length) return saveWith(l, rec, [], advance);
    askLinked(l, rec, parts, function (take) { saveWith(l, rec, take, advance); });
  }
  function saveWith(l, rec, parts, advance) {
    if (S.saving[l.key]) return;
    var recs = [rec].concat(parts.map(function (x) {
      var p = x.line, r = rec.undo ? {key: p.key, undo: true} : {key: p.key, decision: rec.decision, note: rec.note || ""};
      r.via = "linked";
      return r;
    }));
    var label = (rec.undo ? "undo on " : (rec.decision || "call") + " on ") + lineName(l) + (parts.length ? " and its pair" : "");
    recs.forEach(function (r) { S.saving[r.key] = true; });
    setStat(l._i, "saving…");
    commit(recs, label).then(function (saved) {
      var keepLine = S.line;
      refilter(true);
      if (T.afterSave) T.afterSave(saved);
      if (keepLine >= 0 && $("line-" + keepLine)) setLine(keepLine, true);
      if (advance && S.line === l._i) nextUndecided();
      if (parts.length) toast(label + " saved", {label: "undo (U)", fn: undoLast});
    }).catch(function (e) {
      setStat(l._i, "not saved: " + e.message, true);
      toast("not saved: " + e.message);
    }).then(function () { recs.forEach(function (r) { delete S.saving[r.key]; }); });
  }
  // l: the line the record lands on, when that is not the line of its own key (a record under an older key)
  function applyRecord(r, l) {
    l = l || LINE_BY_KEY[r.key];
    if (!l) return;
    l.decision = r.undecided ? null : r.decision;
    l.reviewed = !r.undecided;
    l.decided_by = r.undecided ? null : r.reviewer;
    l.decided_at = r.undecided ? null : r.ts;
    l.suggested_value = r.undecided ? "" : (r.suggested_value || "");
    l.reference = r.undecided ? "" : (r.reference || "");
    l.decision_note = r.undecided ? "" : (r.note || "");
  }
  function applyItemRecord(r, it) {
    it = it || ITEM_BY_KEY[r.key];
    if (!it) return;
    it.call = r.undecided ? null : r.call;
    it.call_note = r.undecided ? null : r.note;
    it.call_reference = r.undecided ? "" : (r.reference || "");
    it.reviewed = !r.undecided;
    it.decided_by = r.undecided ? null : r.reviewer;
    it.decided_at = r.undecided ? null : r.ts;
  }
  // a saved or remote record lands: the tracker takes its own record types first (T.applyRecord returns true), then items, then lines
  function applySaved(saved) {
    (saved || []).forEach(function (r) {
      if (T.applyRecord && T.applyRecord(r, LINE_BY_KEY[r.key], ITEM_BY_KEY[r.key])) return;
      if ("call" in r) applyItemRecord(r); else applyRecord(r);
    });
  }
  // Save one item's call. Same in-place feedback as a line; the card re-renders in place.
  function saveItem(it, rec) {
    if (!Store.caps.decide) return notYet();
    if (S.saving[it.key]) return;
    S.saving[it.key] = true;
    var el = $("istat-" + it._i);
    if (el) { el.textContent = "saving…"; el.className = "dstat saving"; }
    Store.item([rec]).then(function (saved) {
      applySaved(saved);
      banner("");
      refilter(true);
    }).catch(function (e) {
      renderCard();
      var e2 = $("istat-" + it._i);
      if (e2) { e2.textContent = "not saved: " + e.message; e2.className = "dstat err"; }
      toast("not saved: " + e.message);
    }).then(function () { delete S.saving[it.key]; });
  }
  function onItemChange(e) {
    if (T.onCardChange && T.onCardChange(e)) return;
    if (onNoteChange(e)) return;
    var sel = e.target.closest("select[data-icall]"), inp = e.target.closest("input[data-inote]"), ref = e.target.closest("input[data-iref]");
    var t = sel || inp || ref;
    if (!t) return;
    var it = ITEMS[+t.getAttribute(sel ? "data-icall" : inp ? "data-inote" : "data-iref")];
    if (!it) return;
    var box = t.closest(".icall"), call = box.querySelector("select").value, note = box.querySelector("input[data-inote]").value,
        reference = (box.querySelector("input[data-iref]") || {}).value || "";
    if (!call) { if (sel && it.call) saveItem(it, {key: it.key, undo: true}); return; }
    if (!sel && call === it.call && note === (it.call_note || "") && reference === (it.call_reference || "")) return;
    if ((T.noteRequired ? T.noteRequired(it.kind, call, it) : NOTE_REQUIRED[it.kind + ":" + call]) && !note.trim()) {
      var st = $("istat-" + it._i);
      if (st) { st.textContent = "say why in the note, then it saves"; st.className = "dstat err"; }
      if (sel) box.querySelector("input[data-inote]").focus();
      return;
    }
    saveItem(it, {key: it.key, call: call, note: note, reference: reference});
  }
  // The note box on a line: optional, it appears once the line has an accept / hold / reject (a
  // suggestion has the note in its own form). Edited, it re-saves that call with the new note; text
  // still in it when another call is pressed (S.notes) goes with that call.
  function noteBox(l) {
    if (T.noteBox) return !!T.noteBox(l);
    var d = cur(l); return d === "accept" || d === "hold" || d === "reject";
  }
  function noteOf(l) { return l.key in S.notes ? S.notes[l.key] : (cur(l) ? l.decision_note || "" : ""); }
  function onNoteInput(e) {
    var t = e.target.closest("input[data-dnote]");
    if (!t) return false;
    var l = LINES[+t.getAttribute("data-dnote")];
    if (l) S.notes[l.key] = t.value;
    return true;
  }
  function onNoteChange(e) {
    var t = e.target.closest("input[data-dnote]");
    if (!t) return false;
    var l = LINES[+t.getAttribute("data-dnote")], d = l && cur(l);
    if (!l) return true;
    S.notes[l.key] = t.value;
    if (!d) return true;
    if (t.value === (l.decision_note || "")) { delete S.notes[l.key]; return true; }
    var rec = {key: l.key, decision: d, note: t.value};
    if (d === "suggest") { rec.suggested_value = l.suggested_value || ""; rec.reference = l.reference || ""; }
    if (T.noteRecord) rec = T.noteRecord(l, rec) || rec;      // the tracker reshapes the re-save (pipelines: a taken candidate)
    if (d === "suggest" && ("suggested_value" in rec) && blankv(rec.suggested_value) && blankv(t.value)) { setStat(l._i, "a suggestion with no value needs a note", true); return true; }
    // a short wait: when the box loses focus because a call button was pressed, that call saves
    // the note instead (dropNoteSave), so the two saves never race
    dropNoteSave();
    S.noteSave = {key: l.key, timer: setTimeout(function () { S.noteSave = null; save(l, rec, false); }, 250)};
    return true;
  }
  function dropNoteSave() { if (S.noteSave) { clearTimeout(S.noteSave.timer); S.noteSave = null; } }
  function decideCurrent(decision, advance) {
    var l = LINES[S.line];
    if (S.tab === "items") return toast("the items tab takes calls, not change decisions: press i to go back to the changes");
    if (!l) return;
    if (!offers(l, decision)) return toast("this " + W.line + " does not take " + (VERB[decision] || decision) + ": use the buttons it shows");
    dropNoteSave();
    save(l, {key: l.key, decision: decision, note: noteBox(l) ? noteOf(l) : ""}, advance);
  }
  function undoCurrent() {
    var l = LINES[S.line];
    if (S.tab === "items" || !l) return;
    if (!cur(l)) return toast("nothing to undo on this change");
    dropNoteSave();
    save(l, {key: l.key, undo: true}, false);
  }
  function nextUndecided() {       // after a keypress decision: the next open line, then the next plant
    var at = S.shown.indexOf(S.line);
    for (var n = at + 1; n < S.shown.length; n++) {
      if (isOpen(LINES[S.shown[n]])) return setLine(S.shown[n]);
    }
    stepPipe(1);
  }
  // Suggest: an inline form on the current line. Prefill = the proposed value of the line's column.
  // Enter saves decision "suggest" with suggested_value + note; Esc cancels.
  function suggestPrefill(l) {
    if (T.suggestPrefill) { var x = T.suggestPrefill(l); if (x != null) return x; }
    var pv = l.proposed_values || {}, v = pv[l.column];
    if (blankv(v)) { var ks = Object.keys(pv).filter(function (k) { return !blankv(pv[k]); }); v = ks.length ? pv[ks[0]] : ""; }
    return blankv(v) ? "" : String(v);
  }
  function closeSuggest() {
    var f = document.querySelector("#card .sform");
    if (f) f.parentNode.removeChild(f);
  }
  function openSuggest(l) {
    if (!Store.caps.decide) return notYet();
    if (!l) return;
    var el = $("line-" + l._i);
    if (!el) return;
    closeSuggest();
    dropNoteSave();
    setLine(l._i, true);
    var prior = l.reviewed && l.decision === "suggest";
    var f = document.createElement("form");
    f.className = "sform";
    // T.suggestForm(l, prior) -> {html, read(form, l)}: the tracker's own fields; read returns an error string, or the record fields to save
    var custom = T.suggestForm ? T.suggestForm(l, prior) : null;
    if (custom) return openCustomSuggest(l, el, f, custom);
    f.innerHTML = '<label>suggested value <input type="text" class="sv" autocomplete="off"></label>' +
      '<label>note <input type="text" class="sn" autocomplete="off" placeholder="why"></label>' +
      (T.suggestRef === false ? "" : '<label>source link <input type="url" class="sr" autocomplete="off" placeholder="https://… (where the value is stated)"></label>') +
      '<button type="submit" class="sv-save">save suggestion</button><button type="button" class="sv-cancel">cancel (esc)</button>' +
      '<span class="faint sv-err" role="alert"></span>';
    var sv = f.querySelector(".sv"), sn = f.querySelector(".sn"), sr = f.querySelector(".sr") || {value: ""}, err = f.querySelector(".sv-err");
    sv.value = prior ? (l.suggested_value || "") : suggestPrefill(l);
    sn.value = noteOf(l);
    sr.value = prior && T.suggestRef !== false ? (l.reference || "") : "";
    f.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSuggest(); }
    });
    f.querySelector(".sv-cancel").onclick = closeSuggest;
    f.onsubmit = function (e) {
      e.preventDefault();
      if (blankv(sv.value) && blankv(sn.value)) { err.textContent = "give a suggested value or a note"; return; }
      if (!blankv(sr.value) && !/^https?:\/\/\S+$/.test(sr.value.trim())) { err.textContent = "the source link must start with http:// or https://"; return; }
      var srec = {key: l.key, decision: "suggest", suggested_value: sv.value, note: sn.value};
      if (T.suggestRef !== false) srec.reference = sr.value.trim();
      saveSuggest(l, f, srec, err);
    };
    var ctl = el.querySelector(".controls");
    ctl.parentNode.insertBefore(f, ctl.nextSibling);
    sv.focus(); sv.select();
  }
  function saveSuggest(l, f, srec, err) {
    if (S.saving[l.key]) return;
    var b = f.querySelector(".sv-save"); b.disabled = true;
    S.saving[l.key] = true;
    commit([srec], "suggestion on " + lineName(l)).then(function (saved) {
      var keepLine = S.line;
      refilter(true);
      if (T.afterSave) T.afterSave(saved);
      if (keepLine >= 0 && $("line-" + keepLine)) setLine(keepLine, true);
      toast("suggestion saved");
    }).catch(function (e2) {
      b.disabled = false; err.textContent = "not saved: " + e2.message;
    }).then(function () { delete S.saving[l.key]; });
  }
  function openCustomSuggest(l, el, f, custom) {
    f.innerHTML = custom.html + '<div class="sv-actions"><button type="submit" class="sv-save">save suggestion</button><button type="button" class="sv-cancel">cancel (esc)</button>' +
      '<span class="faint sv-err" role="alert"></span></div>';
    var err = f.querySelector(".sv-err");
    f.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSuggest(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); f.onsubmit(e); }     // a textarea takes Enter as a new line
    });
    f.querySelector(".sv-cancel").onclick = closeSuggest;
    f.onsubmit = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      var got = custom.read(f, l);
      if (typeof got === "string") { err.textContent = got; return; }
      var srec = {key: l.key, decision: "suggest"};
      Object.keys(got || {}).forEach(function (k) { srec[k] = got[k]; });
      saveSuggest(l, f, srec, err);
    };
    var ctl = el.querySelector(".controls");
    ctl.parentNode.insertBefore(f, ctl.nextSibling);
    var first = f.querySelector("textarea, input:not([type=radio]):not([type=checkbox])");
    if (first) { first.focus(); if (first.select) first.select(); }
  }
  function suggestKey(e) {
    if (e && e.preventDefault) e.preventDefault();   // the "s" must not land in the form's input
    if (S.tab === "items") return toast("the items tab takes calls, not suggestions: press i to go back to the " + W.lines);
    if (LINES[S.line] && !offers(LINES[S.line], "suggest")) return toast("this " + W.line + " takes no suggestion: use the buttons it shows");
    openSuggest(LINES[S.line]);
  }
  // the keyboard map; a tracker adds or replaces keys with T.keys
  var KEYS = {
    j: function () { stepLine(1); }, k: function () { stepLine(-1); },
    J: function () { stepPipe(1); }, K: function () { stepLine(-1, true); },
    o: openFirstRef,
    d: function () {
      var l = S.line >= 0 && $("line-" + S.line), m = l && l.querySelector("details[data-more]");
      if (m) m.open = !m.open;
    },
    a: function () { decideCurrent("accept", true); }, h: function () { decideCurrent("hold", true); },
    r: function () { decideCurrent("reject", true); }, s: suggestKey, u: undoCurrent, U: undoLast,
    "/": function (e) { e.preventDefault(); $("f-q").focus(); $("f-q").select(); },
    i: toggleItemsTab,
    "?": showHelp
  };
  function toggleItemsTab() {
    if (S.pipe < 0) return;
    S.tab = S.tab === "items" ? defaultTab(cards()[S.pipe]) : "items";
    renderCard();
    if (S.tab === "items") { var s1 = document.querySelector("#card select[data-icall]"); if (s1) s1.focus(); }
  }
  // the help rows: T.help (an array of [keys, text], or a function of the defaults) replaces or edits them
  function helpRows() {
    var wl = W.line, wc = W.card;
    var rows = [["j / k", "next / previous " + wl + " still to decide (runs on into the next " + wc + ")"], ["K", "previous " + wl + ", including ones you just decided"], ["J", "next " + wc],
                ["a / h / r", "accept / hold / reject the " + wl + "; saved at once, then on to the next open " + wl],
                ["s", "suggest a different value: an inline form on the " + wl + " (value + note; enter saves, esc cancels)"],
                ["i", "switch the card between " + W.lines + " and items; calls save on change"],
                ["u", "undo: the " + wl + " goes back to undecided"], ["U", "undo the last save (a call, a pair, a bulk call), one save per press, as far back as this session goes"], ["o", "open the " + wl + "'s first source link (new tab)"], ["d", "show / hide the " + wl + "'s notes"],
                ["/", "search"], ["?", "this help"]];
    if (typeof T.help === "function") return T.help(rows) || rows;
    return T.help || rows;
  }
  function showHelp() {
    var dlg = $("dialog");
    dlg.setAttribute("data-kind", "help");
    dlg.innerHTML = "<h3>keyboard</h3><table>" + helpRows().map(function (r) { return "<tr><td><kbd>" + r[0] + "</kbd></td><td>" + r[1] + "</td></tr>"; }).join("") +
      '</table><div class="actions"><button type="button" id="dlg-close">close</button></div>';
    $("dlg-close").onclick = function () { dlg.close(); };
    dlg.showModal();
  }
  // "how to": a plain-language page on what the app shows and what each call does. T.info (HTML, or a function returning it) replaces the generic text.
  function savedWhere() {
    return STATIC ? (Store.status && Store.status().state === "synced" ?
      " on this page, where the sender reads it back. <b>push to log</b> in the top bar asks for your new calls to be added to the batch's log" :
      " kept in this browser. Click <b>download decisions</b> in the top bar when you are done (or any time) and send the file back; the calls are then added to the batch's log") :
      " in the batch's staging folder";
  }
  function infoHtml() {
    if (typeof T.info === "function") return T.info(savedWhere());
    if (T.info) return T.info;
    return "<h3>how this works</h3>" +
      "<p>This page shows the <b>edits a research batch proposes</b> for a GEM tracker. " +
      "Nothing here is in the GEM database yet, and nothing on this page can write to it. Your job is to say yes or no to each edit.</p>" +
      "<h4>what you see</h4><ul>" +
      "<li><b>Left list:</b> the " + W.cards + " with something to decide. Click one to open it.</li>" +
      "<li><b>Card:</b> that " + W.card + "'s proposed " + W.lines + ". Each one shows the value as it is <b>now</b>, the <b>proposed</b> value, and the source links that back it.</li>" +
      "<li><b>Major / minor:</b> a <b>major change</b> moves a value. A <b>minor change</b> means the value was checked again and stands, so only a source link is added.</li>" +
      "<li><b>Color:</b> green means a well-checked source, yellow means one source or a partial match, and red means weak. <b>unrated</b> means no rating, and it defaults to hold.</li>" +
      "<li><b>Filters:</b> decision, kind and search sit in the bar at the top. <b>more filters</b> holds the rest, and <b>reset</b> clears them all. <b>hide done</b> drops the " + W.cards + " with nothing left to decide.</li>" +
      "<li><b>Items</b> tab: questions and other notes the researcher raised. They take a call and a note, but they never change a value.</li>" +
      "</ul><h4>your four calls</h4><ul>" +
      "<li><b>accept:</b> yes, this edit goes into the actions workbook.</li>" +
      "<li><b>hold:</b> not sure yet, leave it open.</li>" +
      "<li><b>reject:</b> no, do not apply this.</li>" +
      "<li><b>suggest:</b> something else is right, so type the value or a note, and the source link if you have one.</li>" +
      "</ul><h4>what happens when you accept</h4><ol>" +
      "<li>Your click is saved at once in the decision log" + savedWhere() + ". The GEM database is <b>not</b> touched.</li>" +
      "<li>When the batch is built, every accepted " + W.line + " goes into the actions workbook. Someone then applies it by hand.</li>" +
      "</ol><h4>good to know</h4><ul>" +
      "<li><b>Undo:</b> click the pressed button again, or press <kbd>u</kbd>. Nothing is deleted; the log just records the undo.</li>" +
      "<li>A grayed " + W.line + " is already decided. A bright one still needs you.</li>" +
      "<li><b>theme</b> and the half-circle button change the page's colors.</li>" +
      "<li>Press <kbd>?</kbd> for the keyboard shortcuts.</li></ul>";
  }
  function showInfo() {
    var dlg = $("dialog");
    dlg.setAttribute("data-kind", "info");
    dlg.innerHTML = infoHtml() + '<div class="actions"><button type="button" id="dlg-close">close</button></div>';
    $("dlg-close").onclick = function () { dlg.close(); };
    dlg.showModal();
    dlg.scrollTop = 0;
  }
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ($("dialog").open) return;
    var t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) { if (e.key === "Escape" || (e.key === "Enter" && t.matches(".dnote"))) t.blur(); return; }
    var f = KEYS[e.key];
    if (f) f(e);
  }
  var toastTimer = null;
  // act: {label, fn}, a button on the toast (an undo); the toast then stays longer
  function toast(msg, act) {
    var t = $("toast");
    t.textContent = msg;
    if (act) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "ghost toast-act"; b.textContent = act.label;
      b.onclick = function () { t.hidden = true; act.fn(); };
      t.appendChild(document.createTextNode(" ")); t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, act ? 8000 : 4000);
  }
  var STICKY = "";
  function banner(msg) { var b = $("banner"); msg = msg || STICKY; b.textContent = msg; b.hidden = !msg; }

  function onCardClick(e) {
    var pidEl = e.target.closest(".pid");
    if (pidEl) { copyText(pidEl.textContent, pidEl.textContent + " copied"); return; }
    var clip = e.target.closest("button[data-clip]");
    if (clip) { var ct = clip.getAttribute("data-clip"); copyText(ct, (ct.length > 60 ? ct.slice(0, 59) + "…" : ct) + " copied"); return; }
    var on = e.target.closest("[data-only]");
    if (on) { e.preventDefault(); return filterOnly(on.getAttribute("data-only"), on.getAttribute("data-facet") || "q"); }
    if (T.onCardClick && T.onCardClick(e)) return;      // the tracker's own buttons and boxes
    if (e.target.closest(".dnote")) { var nl = e.target.closest(".line"); if (nl) setLine(+nl.getAttribute("data-i"), true); return; }
    if (e.target.closest("[data-showall]")) {
      e.preventDefault();
      var keepPipe = S.pipe;
      FS = defaults(); FS.decision = "";
      syncControls(); S.pin = keepPipe; refilter(true); writeRoute(false);
      return;
    }
    var tf = e.target.closest("button[data-tabfold]");
    if (tf) {     // closing goes back to the major tab, the only one left showing
      var opening = tf.getAttribute("data-tabfold") === "open";
      function foldTabs() {
        S.moreTabs = opening;
        if (!S.moreTabs) S.tab = "major";
        renderCard();
      }
      // T.tabFoldNotice: a word before the tabs open (GOGPT: what is on them is beyond the update research). "OK, I understand" leaves them folded; "Show anyway" opens them
      if (opening && T.tabFoldNotice) {
        var dlg = $("dialog");
        dlg.setAttribute("data-kind", "notice");
        dlg.innerHTML = "<p>" + esc(T.tabFoldNotice) + '</p><div class="actions"><button type="button" class="dlg-alt" id="dlg-show">Show anyway</button><button type="button" class="dlg-ok" id="dlg-close">OK, I understand</button></div>';
        $("dlg-close").onclick = function () { dlg.close(); };
        $("dlg-show").onclick = function () { dlg.close(); foldTabs(); };
        dlg.showModal();
      } else foldTabs();
      return;
    }
    var tb = e.target.closest("[data-tab]");
    if (tb && tb.tagName === "A") e.preventDefault();
    if (tb) {
      if (tb.getAttribute("data-tab") === "all") S.pin = S.pipe;   // deciding lines here must not drop the card from the queue
      if (S.tab !== tb.getAttribute("data-tab")) { S.tab = tb.getAttribute("data-tab"); renderCard(); }
      return;
    }
    var sb = e.target.closest("button[data-suggest]");
    var b = e.target.closest("button[data-decide]");
    var ub = e.target.closest("button[data-undo]");
    var ln = e.target.closest(".line");
    if (ln) setLine(+ln.getAttribute("data-i"), true);
    if (ub && !ub.disabled) return undoCurrent();
    if (sb) {
      if (!Store.caps.decide) return notYet();
      return openSuggest(LINES[S.line]);
    }
    if (!b) return;
    if (!Store.caps.decide) return notYet();
    // a click on the pressed button takes the call back (the same record an undo writes)
    if (b.getAttribute("aria-pressed") === "true") return undoCurrent();
    decideCurrent(b.getAttribute("data-decide"), false);
  }

  // ---- bulk ----
  // The targets are the CURRENT filtered lines of the open card. Lines already decided, and lines the tracker does not count, are skipped. T.bulkTargets(mode, line) may refuse a line ("other").
  function bulkTargets(mode) {     // every line the bulk button covers; a line that does not offer accept (T.lineActions) is skipped
    var q = FS.q.trim().toLowerCase();
    var t = {lines: [], byKind: {}, decision: "accept", skip: {decided: 0, other: 0}, extra: {}};
    var p = cards()[S.pipe];
    p.lines.forEach(function (l) {
      if (!match(l, p, FS, null, q)) return;
      if (cur(l)) { t.skip.decided++; return; }
      if (!counted(l)) { t.extra.uncounted = (t.extra.uncounted || 0) + 1; return; }   // T.bulkSkip.uncounted names them (pipelines: already in the backend)
      // the tracker may refuse a line: a string names its own skip reason (T.bulkSkip holds the text), false counts as "other"
      var tb = T.bulkTargets ? T.bulkTargets(mode, l) : null;
      if (typeof tb === "string") { t.extra[tb] = (t.extra[tb] || 0) + 1; return; }
      if ((mode === "bulk-high" && tierOf(l) !== "high") || (mode === "bulk-minor" && sevOf(l) !== "minor") || tb === false || !offers(l, "accept")) { t.skip.other++; return; }
      t.lines.push(l);
      t.byKind[l.kind] = (t.byKind[l.kind] || 0) + 1;
    });
    return t;
  }
  function bulkTitle(mode) {
    return ({"bulk-minor": "accept all minor " + W.lines, "bulk-high": "accept all high-conf " + W.lines, "bulk-all": "accept all " + W.lines})[mode] || mode;
  }
  function showBulk(mode) {
    if (!Store.caps.decide) return notYet();
    if (S.pipe < 0) return toast("nothing in view");
    var t = bulkTargets(mode), dlg = $("dialog"), sk = t.skip;
    var skipTxt = Object.keys(t.extra).map(function (k) { return t.extra[k] + ((T.bulkSkip || {})[k] || (k === "uncounted" ? " not waiting on a call" : " " + k)); })
      .concat([sk.decided && sk.decided + " already decided",
               sk.other && sk.other + (mode === "bulk-high" ? " not high confidence" : " major (the value moves: decide those by hand)")]).filter(Boolean).join(", ");
    if (!t.lines.length) return toast("nothing to accept in view" + (skipTxt ? " (skipped: " + skipTxt + ")" : ""));
    var kinds = Object.keys(t.byKind).map(function (k) { return "<tr><td>" + esc(KIND_LABEL[k] || k) + "</td><td>" + t.byKind[k] + "</td></tr>"; }).join("");
    dlg.setAttribute("data-kind", "bulk");
    dlg.innerHTML = "<h3>" + esc(bulkTitle(mode)) + " (this " + W.card + ")</h3><p><b>" + plural(t.lines.length, W.line) + "</b> will be accepted as " + esc(ME) + ", in one save:</p><table>" + kinds + "</table>" +
      (skipTxt ? '<p class="faint">skipped: ' + esc(skipTxt) + ".</p>" : "") +
      '<p class="faint" id="bulk-err"></p><div class="actions"><button type="button" class="ghost" id="dlg-cancel">cancel</button>' +
      '<button type="button" id="dlg-ok">accept ' + t.lines.length + "</button></div>";
    $("dlg-cancel").onclick = function () { dlg.close(); };
    $("dlg-ok").onclick = function () {
      var ok = $("dlg-ok"); ok.disabled = true; ok.textContent = "saving…";
      commit(t.lines.map(function (l) { return {key: l.key, decision: "accept"}; }), bulkTitle(mode) + " (" + plural(t.lines.length, W.line) + ")").then(function (saved) {
        dlg.close();
        refilter(true);
        toast("accepted " + plural(saved.filter(function (r) { return !("call" in r); }).length, W.line));
        if (T.afterSave) T.afterSave(saved);
      }).catch(function (e) {
        ok.disabled = false; ok.textContent = "retry";
        $("bulk-err").textContent = "not saved: " + e.message;
        $("bulk-err").className = "err";
      });
    };
    dlg.showModal();
  }
  // Every line the filters show, on every card in view: accept, hold or reject them in one save (T.bulkFiltered turns the buttons on).
  // A line already at that call, one not counted, or one that does not offer the call is skipped. Partners outside the filter
  // (T.partners) are named; a strict partner always goes with its line, the others only on "include the partners".
  function filterDesc() {
    var q = routeHash().split("?")[1] || "";
    return q ? decodeURIComponent(q).replace(/&/g, ", ") : "no filters";
  }
  function bulkFilteredTargets(decision) {
    var q = FS.q.trim().toLowerCase(), t = {lines: [], changes: 0, skip: 0, strict: [], loose: []}, inT = {};
    S.visible.forEach(function (pi) {
      var p = cards()[pi];
      p.lines.forEach(function (l) {
        if (!match(l, p, FS, null, q) || cur(l) === decision) return;
        if (!counted(l) || !offers(l, decision)) { t.skip++; return; }
        t.lines.push(l); inT[l.key] = 1;
        if (cur(l)) t.changes++;
      });
    });
    if (T.partners) t.lines.forEach(function (l) {
      (T.partners(l) || []).forEach(function (x) {
        var p = x && x.line;
        if (!p || inT[p.key] || cur(p) === decision || !offers(p, decision)) return;
        inT[p.key] = 1;
        (x.strict ? t.strict : t.loose).push(p);
      });
    });
    return t;
  }
  function showBulkFiltered(decision) {
    if (!Store.caps.decide) return notYet();
    var t = bulkFilteredTargets(decision), dlg = $("dialog"), desc = filterDesc();
    if (!t.lines.length) return toast("nothing in view to " + decision + (t.skip ? " (" + t.skip + " skipped)" : ""));
    var warn = T.bulkWarn ? T.bulkWarn(t.lines.concat(t.strict, t.loose), decision) : "";
    function names(ls) { return ls.slice(0, 12).map(function (l) { return esc((cards()[l._p] || {}).name || "") + " · " + esc(lineName(l)); }).join("; ") + (ls.length > 12 ? "; and " + (ls.length - 12) + " more" : ""); }
    dlg.setAttribute("data-kind", "bulk");
    dlg.innerHTML = "<h3>" + esc(decision) + " every " + esc(W.line) + " in view</h3>" +
      "<p><b>" + plural(t.lines.length, W.line) + "</b> will be marked " + esc(VERB[decision] || decision) + " as " + esc(ME) + ", in one save. Filters: " + esc(desc) + ".</p>" +
      (t.changes ? "<p>" + plural(t.changes, W.line) + " already " + (t.changes === 1 ? "has" : "have") + " another call, which this replaces.</p>" : "") +
      (t.strict.length ? "<p>Their " + plural(t.strict.length, "partner") + " outside the filter go too, because a pair is decided together: " + names(t.strict) + ".</p>" : "") +
      (t.loose.length ? "<p>" + plural(t.loose.length, "linked " + W.line) + " outside the filter: " + names(t.loose) + ".</p>" : "") +
      (t.skip ? '<p class="faint">skipped: ' + t.skip + " that do not take this call or are not waiting on one.</p>" : "") +
      (warn ? '<p class="err">' + warn + "</p>" : "") +
      '<p class="faint" id="bulk-err"></p><div class="actions"><button type="button" class="ghost" id="dlg-cancel">cancel</button>' +
      '<button type="button" id="dlg-ok"' + (t.loose.length ? ' class="dlg-alt"' : "") + ">" + (t.loose.length ? "only the filtered " + W.lines : esc(decision) + " " + (t.lines.length + t.strict.length)) + "</button>" +
      (t.loose.length ? '<button type="button" id="dlg-all">include the partners</button>' : "") + "</div>";
    function go(withLoose, btn) {
      var via = ("bulk:" + desc).slice(0, 300);
      var recs = t.lines.concat(t.strict).map(function (l) { return {key: l.key, decision: decision, via: via}; })
        .concat(withLoose ? t.loose.map(function (l) { return {key: l.key, decision: decision, via: "linked"}; }) : []);
      Array.prototype.forEach.call(dlg.querySelectorAll(".actions button"), function (b) { b.disabled = true; });
      btn.textContent = "saving…";
      var label = decision + " on " + plural(recs.length, W.line) + " in view";
      commit(recs, label).then(function (saved) {
        dlg.close();
        refilter(true);
        if (T.afterSave) T.afterSave(saved);
        toast(label + " saved", {label: "undo (U)", fn: undoLast});
      }).catch(function (e) {
        Array.prototype.forEach.call(dlg.querySelectorAll(".actions button"), function (b) { b.disabled = false; });
        btn.textContent = "retry";
        $("bulk-err").textContent = "not saved: " + e.message; $("bulk-err").className = "err";
      });
    }
    $("dlg-cancel").onclick = function () { dlg.close(); };
    $("dlg-ok").onclick = function () { go(false, $("dlg-ok")); };
    if (t.loose.length) $("dlg-all").onclick = function () { go(true, $("dlg-all")); };
    dlg.showModal();
  }
  // Click to filter: an element with data-only="<value>" (and data-facet="<filter>", the search box by default) shows only what matches it
  function only(value, text, facet, tip) {
    return '<a href="#" class="only" data-only="' + esc(value) + '"' + (facet ? ' data-facet="' + esc(facet) + '"' : "") +
      tipAttrs(tip || "show only " + value) + ">" + esc(text == null ? value : text) + "</a>";
  }
  function filterOnly(value, facet) {
    if (!(facet in FS)) facet = "q";
    FS = defaults();
    FS[facet] = facet === "q" ? String(value).toLowerCase() : value;
    syncControls();
    changed(false);
    toast("showing only " + value + " · reset clears it");
  }
  function copyText(text, msg) {
    msg = msg || "copied";
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? msg : "could not copy: select the text by hand");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(msg); }, fallback);
    else fallback();
  }
  function reload(data) {
    var pid = cards()[S.pipe] ? cards()[S.pipe].pid : "";
    D = data;
    prepare();
    if (Store.ready) Store.ready();
    fillFilters(); syncControls();
    S.pin = -1; S.stay = {}; S.line = -1; S.igOpen = {};
    S.pipe = -1;
    cards().forEach(function (p, i) { if (p.pid === pid) S.pipe = i; });
    if (T.afterReload) T.afterReload(D);
    refilter(true);
  }

  // ---- routing: #/<card id> plus an optional ?query with the filters that differ from the defaults ----
  var ROUTING = false;
  var QK = {decision: "d", kind: "k", tier: "t", dir: "dir", column: "col", q: "q", by: "by"};   // T.QK replaces it (its order is the hash order)
  function routeHash() {
    var p = cards()[S.pipe], d = defaults(), q = [];
    Object.keys(QK).forEach(function (f) {
      var v = FS[f];
      if (Array.isArray(v)) {
        if (v.join("|") === (d[f] || []).join("|")) return;
        v = !v.length && T.routeEmpty ? T.routeEmpty : v.join("|");      // T.routeEmpty: how an empty list is written (pipelines "all": every box ticked)
      }
      else if (v === d[f]) return;
      if (typeof v === "boolean") v = "1";
      else if (f === "decision" && v === "") v = "any";
      q.push(QK[f] + "=" + encodeURIComponent(v));
    });
    return "#/" + (p ? encodeURIComponent(p.pid) : "") + (q.length ? "?" + q.join("&") : "");
  }
  var NAV = window.GasNav || null;      // the Apps Script page keeps its route through gas.js, not the frame's own address
  function curHash() { return NAV ? NAV.hash : (location.hash || ""); }
  // The route (filters + open card) is also kept in this browser, because a published artifact's
  // frame does not keep the URL hash across a reload. Per scope; restored only when the URL carries no route.
  function routeKey() {
    if (T.routeKey) return T.routeKey(D);
    var c = (D && D.scope) || {};
    return "review-route:" + (T.id || T.name || TB.name || "") + ":" + (c.id || "");
  }
  function savedRoute() { try { return localStorage.getItem(routeKey()) || ""; } catch (e) { return ""; } }
  function saveRoute(h) { try { localStorage.setItem(routeKey(), h); } catch (e) { /* storage blocked */ } }
  var RESTORED = false;
  function writeRoute(replace) {
    if (ROUTING || !D) return;
    var h = routeHash();
    saveRoute(h);
    if (h === curHash()) return;
    if (NAV) return NAV.write(h, replace);
    try { history[replace ? "replaceState" : "pushState"](null, "", h); } catch (e) { /* file:// or blocked */ }
  }
  function applyRoute() {
    ROUTING = true;
    try {
      var hash = curHash();
      if (!RESTORED) { RESTORED = true; if (!/^#\/./.test(hash) && /^#\//.test(savedRoute())) hash = savedRoute(); }
      var m = /^#\/([^?]*)(?:\?(.*))?$/.exec(hash), pid = "";
      FS = defaults();
      if (m) {
        pid = decodeURIComponent(m[1]);
        (m[2] || "").split("&").forEach(function (kv) {
          var i = kv.indexOf("="); if (i < 1) return;
          var k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
          Object.keys(QK).forEach(function (f) {
            if (QK[f] !== k) return;
            if (Array.isArray(FS[f])) {
              var vs = T.routeEmpty && v === T.routeEmpty ? [] : v.split("|").filter(Boolean);
              FS[f] = T.routeArray ? T.routeArray(f, vs) : vs;
            } else FS[f] = typeof FS[f] === "boolean" ? v === "1" : (f === "decision" && v === "any" ? "" : v);
          });
        });
      }
      syncControls();
      S.pin = -1; S.panel = null;
      var pi = -1;
      if (pid) cards().forEach(function (p, i) { if (p.pid === pid) pi = i; });
      S.pipe = pi;
      refilter(true);
      if (pi >= 0 && S.visible.indexOf(pi) < 0) {      // a link to a card the filters would hide
        FS = defaults(); FS.decision = "";
        syncControls(); S.pin = pi; refilter(true);
      }
      if (pi >= 0 && S.visible.indexOf(pi) >= 0 && S.pipe !== pi) selectPipe(pi);
      if (pi >= 0 && S.visible.indexOf(pi) >= 0) { S.pipe = pi; renderQueue(); renderCard(); var li = $("pipes").querySelector("li.sel"); if (li) li.scrollIntoView({block: "nearest"}); }
    } finally { ROUTING = false; }
    writeRoute(true);
  }

  // ---- boot ----
  function et(iso) { return String(iso || "").replace("T", " ").slice(0, 16) + " ET"; }
  function boot(reviewer, data) {
    D = data; ME = reviewer;
    var tLoaded = performance.now();
    prepare();
    if (Store.ready) Store.ready();
    banner();
    $("whoami").textContent = reviewer;
    var synced = STATIC && Store.status && Store.status().state === "synced";
    $("whoami").dataset.tip = synced ? "your calls are saved under these initials on this page as you make them" :
      STATIC ? "your calls are saved under these initials in this browser until you download them" :
      "your calls are saved under these initials in review_log.jsonl in each batch's staging folder";
    if (STATIC) {
      var ex = $("export-btn");
      ex.hidden = false;
      ex.classList.toggle("parked", synced);   // a synced page saves every call itself; only a page keeping calls in this browser needs the download
      ex.dataset.tip = synced ? "a backup copy of every call made here, as a file. Your calls are already saved on this page" :
        "save every call made in this browser as a review_log.jsonl file to send back. Safe to click more than once: the file always holds the whole log";
      ex.onclick = function () {
        if (!Store.count()) { toast("no calls yet; nothing to download"); return; }
        Promise.resolve(Store.download()).then(function (r) {
          toast("saved " + r.count + " call" + (r.count === 1 ? "" : "s") + " to " + r.name);
        }, function (e) { toast(e && e.message ? e.message : "download failed"); });
      };
      if (synced && Store.requestPush && !$("ledger-btn")) {
        var pb = document.createElement("button");
        pb.id = "ledger-btn"; pb.type = "button"; pb.className = "ghost"; pb.textContent = "push to log";
        pb.dataset.tip = "ask Claude to add your calls that are not in the log yet; calls already logged or already pushed are left out. When a Claude session is watching this page it is woken at once (a comment sent to Claude) and asks whether to push the accepts to the tracker; otherwise it finds the request on its next check. Nothing is written to the tracker without a yes";
        var ledgerUrl = (window.REVIEW_STATIC || {}).ledger_url;
        if (ledgerUrl) { pb.dataset.tipHref = ledgerUrl; pb.dataset.tipHrefLabel = "open the log ↗"; }
        pb.onclick = function () {
          Promise.resolve(Store.requestPush(pb)).then(function (r) {
            toast("push to log requested: " + r.count + " new call" + (r.count === 1 ? "" : "s") + " not yet in the log" +
              (r.sent ? "; Claude was told and will ask about the sheet push" : "; a watching Claude session picks it up on its next check"));
          }, function (e) { toast(e && e.message ? e.message : "the request did not go through"); });
        };
        ex.parentNode.insertBefore(pb, ex.nextSibling);
      }
      var st = Store.status ? Store.status() : {state: "local"};
      if (st.state === "error") { STICKY = st.message; banner(); }
      else if (!synced && Store.storageOk && !Store.storageOk()) { STICKY = "this browser is not keeping the log between visits (private window or storage blocked): download your decisions before closing the tab"; banner(); }
    }
    var dirs = D.dirs || [], scope = D.scope || {};
    document.querySelector(".top h1").dataset.tip = "built " + et(D.built) + " · " + dirs.length + " staging folder" + (dirs.length === 1 ? "" : "s") + ": " +
      dirs.map(dirLabel).join(", ") + (scope.quarter ? " · " + scope.quarter : "");
    initFilters();
    if (T.onBoot) T.onBoot(D);
    applyRoute();
    var tDone = performance.now();
    var timing = {loadMs: Math.round(tLoaded - T0), renderMs: Math.round(tDone - tLoaded), totalMs: Math.round(tDone - T0)};
    timing[W.cards] = cards().length; timing.lines = LINES.length; timing.items = ITEMS.length;
    window.ReviewApp.timing = timing;
    if (window.console) console.info("review app: loaded in " + timing.loadMs + " ms, first render " + timing.renderMs + " ms", timing);
    if (T.poll) T.poll();
  }

  // ---- records this page did not save (another reviewer, another tab, a live poll): applied to the data, lines on the open card stay in view; -> how many applied ----
  // A store that knows whose record speaks for a key (static_store.js: speak, keysFor, apply) has already taken the records into its log. Each line and item they touch
  // then shows the record that speaks for it, by the Python store's rules: a person's live call over a later machine record, a person's undo over an earlier call,
  // a record under an older key when the line has no person record of its own. A store without speak (gas.js) lays the records on one at a time, oldest first.
  // Records that name no line or item (a tracker's markers, such as the GOGPT flag) always land one at a time.
  var REMOTE = false;
  function applyRemote(recs) {
    var n = 0, open = S.pipe, spoken = typeof Store.speak === "function", keys = [], seen = {};
    function stay(key, o) { if (open >= 0 && o._p === open) S.stay[key] = true; }
    function one(r) {
      if (T.applyRecord && T.applyRecord(r, LINE_BY_KEY[r.key], ITEM_BY_KEY[r.key], true)) { n++; return; }
      var item = "call" in r, o = item ? ITEM_BY_KEY[r.key] : LINE_BY_KEY[r.key];
      if (!o) return;
      if (item) applyItemRecord(r); else applyRecord(r);
      if (!item) stay(r.key, o);
      n++;
    }
    REMOTE = true;
    try {
      (recs || []).forEach(function (r) {
        if (!spoken) return one(r);
        var hit = false;
        (Store.keysFor ? Store.keysFor(r.key) : [r.key]).forEach(function (k) {
          if (!LINE_BY_KEY[k] && !ITEM_BY_KEY[k]) return;
          hit = true;
          if (!seen[k]) { seen[k] = 1; keys.push(k); }
        });
        if (!hit) one(r);
      });
      keys.forEach(function (k) {
        var said = Store.speak(k), rec = said[0], l = LINE_BY_KEY[k], it = ITEM_BY_KEY[k];
        if (!rec) return;             // the values the page was built with stand
        // the tracker gets the line's latest machine record as well (pipelines: applied)
        if (T.applyRecord && T.applyRecord(rec, l, it, true, said[1] || null)) { n++; return; }
        if (Store.apply) Store.apply(it || l, it ? "items" : "lines", rec);
        else if (it) applyItemRecord(rec, it);
        else applyRecord(rec, l);
        if (l) stay(k, l);
        n++;
      });
    } finally { REMOTE = false; }
    return n;
  }
  // true while a re-render would take something from under the reviewer's hands
  function busy() {
    var a = document.activeElement;
    return $("dialog").open || !!document.querySelector("#card .sform") || Object.keys(S.saving).length > 0 ||
      !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && $("card").contains(a));
  }
  function rerender() {
    var keepLine = S.line;
    refilter(true);
    if (keepLine >= 0 && $("line-" + keepLine)) setLine(keepLine, true);
  }

  // ---- the tip popover (shows on hover and focus, stays while hovered, Esc dismisses) ----
  function initTips() {
    var tip = document.createElement("div"), owner = null, hideT = 0, showT = 0;
    tip.id = "tip"; tip.className = "tip"; tip.setAttribute("role", "tooltip"); tip.hidden = true;
    document.body.appendChild(tip);
    function show(el) {
      clearTimeout(hideT);
      owner = el; tip.innerHTML = '<div class="tip-head"></div>'; tip.firstChild.textContent = el.getAttribute("data-tip");
      var note = el.getAttribute("data-tip-note");
      if (note) { var n = document.createElement("div"); n.className = "tip-note"; n.textContent = "note: " + note; tip.appendChild(n); }
      var href = el.getAttribute("data-tip-href");
      if (href) { var a = document.createElement("a"); a.className = "tip-link"; a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = el.getAttribute("data-tip-href-label") || href; a.style.cssText = "display:block;margin-top:8px"; tip.appendChild(a); }
      tip.hidden = false;
      var r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, m = 8;
      var x = Math.min(Math.max(m, r.left), window.innerWidth - w - m);
      var y = r.bottom + 6 + h > window.innerHeight - m ? r.top - 6 - h : r.bottom + 6;
      tip.style.left = x + "px"; tip.style.top = Math.max(m, y) + "px";
    }
    function hide() { clearTimeout(showT); tip.hidden = true; owner = null; }
    function later() { clearTimeout(hideT); hideT = setTimeout(hide, 150); }
    document.addEventListener("mouseover", function (e) {
      var el = e.target.closest && e.target.closest("[data-tip]");
      if (owner && !owner.isConnected) hide();
      if (el) {
        if (el === owner) { clearTimeout(hideT); return; }
        clearTimeout(showT);
        if (owner) show(el); else showT = setTimeout(function () { if (el.isConnected) show(el); }, 300);
      } else {
        clearTimeout(showT);
        if (owner && !tip.contains(e.target)) later(); else if (tip.contains(e.target)) clearTimeout(hideT);
      }
    });
    document.addEventListener("focusin", function (e) {
      var t = e.target.closest && e.target.closest("[data-tip]");
      if (t && e.target.matches(":focus-visible")) show(t);
    });
    document.addEventListener("focusout", function (e) { if (owner && owner.contains(e.target)) hide(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !tip.hidden) { hide(); e.stopPropagation(); } }, true);
    document.documentElement.addEventListener("mouseleave", hide);
    document.addEventListener("mousedown", function (e) { if (owner && !tip.contains(e.target) && !owner.contains(e.target)) hide(); });
    window.addEventListener("blur", hide);
    document.addEventListener("scroll", function (e) { if (owner && !tip.contains(e.target)) hide(); }, true);
  }
  // the tracker's slot HTML goes into the named slots; an element with data-after / data-before="<id>" moves next to that control (or its label)
  function fillSlots() {
    var slots = T.slots || {};
    Array.prototype.forEach.call(document.querySelectorAll(".slot[data-slot]"), function (el) {
      var html = slots[el.getAttribute("data-slot")];
      if (html) el.innerHTML = typeof html === "function" ? html() : html;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".slot [data-after], .slot [data-before]"), function (el) {
      var after = el.getAttribute("data-after"), ref = $(after || el.getAttribute("data-before"));
      if (!ref) return;
      ref = (ref.closest && ref.closest("label")) || ref;
      ref.parentNode.insertBefore(el, after ? ref.nextSibling : ref);
    });
    $("pipes").setAttribute("aria-label", W.cards);
    if (T.searchPlaceholder) $("f-q").placeholder = T.searchPlaceholder;
  }
  var STARTED = false;
  function init() {
    if (STARTED) return;
    STARTED = true;
    Store = window.GasStore || window.StaticStore || LOOPBACK;     // an adapter loaded after this file still wins
    STATIC = Store.mode === "static";
    NAV = window.GasNav || null;
    window.Store = Store; window.ReviewApp.Store = Store;
    fillSlots();
    initTheme();
    document.addEventListener("keydown", onKey);
    initTips();
    // A press anywhere outside the open suggest form closes it, same as cancel.
    document.addEventListener("mousedown", function (e) {
      var f = document.querySelector("#card .sform");
      if (f && !f.contains(e.target)) closeSuggest();
    });
    document.addEventListener("click", closeDrops);
    $("card").addEventListener("click", onCardClick);
    // T.hideItemsSwitch false: no "hide with items" switch; T.hideDoneInFilters: the "hide done" switch sits in the filter row, not above the queue
    var hi = T.hideItemsSwitch === false && $("hide-items"), hiL = hi && hi.closest("label");
    if (hiL) hiL.remove();
    var hd = T.hideDoneInFilters && $("hide-done"), hdL = hd && hd.closest("label"), more = $("f-more"), grp = more && more.closest(".fbtns");
    if (grp) more = grp;
    if (hdL && more && more.parentNode) {
      var row = hdL.parentNode;
      more.parentNode.insertBefore(hdL, more);
      if (row && row.children && !row.children.length) row.remove();
    }
    [["hide-done", "hideDone", "review-hide-done"], ["hide-items", "hideItems", "review-hide-items"]].forEach(function (c) {
      var box = $(c[0]);
      if (!box) { S[c[1]] = false; return; }
      try { S[c[1]] = localStorage.getItem(c[2]) === "1"; } catch (e) { S[c[1]] = false; }
      box.checked = !!S[c[1]];
      box.addEventListener("change", function () {
        S[c[1]] = box.checked;
        try { localStorage.setItem(c[2], S[c[1]] ? "1" : "0"); } catch (e) { /* ignore */ }
        renderQueue();
      });
    });
    $("pipes").addEventListener("click", function (e) {
      var li = e.target.closest("li[data-i]");
      if (li) return selectPipe(+li.getAttribute("data-i"));
      if (T.onQueueClick) T.onQueueClick(e);
    });
    $("help-btn").onclick = showHelp;
    $("info-btn").onclick = showInfo;
    $("progress-btn").onclick = showProgress;
    // every popup shares #dialog: a click on the backdrop (outside the box) closes it
    $("dialog").addEventListener("click", function (e) {
      var dlg = e.currentTarget, r = dlg.getBoundingClientRect();
      if (e.target !== dlg || dlg.dataset.busy) return;      // a dialog at work (a push in flight) stays open
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    $("card").addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("button[data-bulk]");
      if (!b) return;
      if (b.getAttribute("aria-disabled") === "true") return toast(b.getAttribute("data-why"));
      showBulk(b.getAttribute("data-bulk"));
    });
    var fb = $("f-bulk");
    if (fb && T.bulkFiltered) {
      fb.hidden = false;
      fb.addEventListener("click", function (e) { var b = e.target.closest("button[data-fbulk]"); if (b) showBulkFiltered(b.getAttribute("data-fbulk")); });
    }
    $("card").addEventListener("change", onItemChange);
    $("card").addEventListener("input", onNoteInput);
    $("card").addEventListener("toggle", function (e) {
      var d = e.target;
      if (d && d.classList && d.classList.contains("igroup")) S.igOpen[d.getAttribute("data-g")] = d.open;
    }, true);
    window.addEventListener("popstate", applyRoute);
    window.addEventListener("hashchange", function () { if (D && !ROUTING && location.hash !== routeHash()) applyRoute(); });
    if (T.onInit) T.onInit();
    Promise.all([Store.whoami(), Store.load()]).then(function (r) { boot(r[0], r[1]); })
      .catch(function (e) { banner("could not load the dataset: " + e.message); });
  }

  // ---- ReviewApp.define: a tracker registers its hooks and vocabularies ----
  // define(obj) or define(function (A) { return obj; }); A is the helper API below. Settings missing from the object come from the built page's tracker block.
  function pick(k, tbk) { return T[k] != null ? T[k] : (tbk && TB[tbk] != null ? TB[tbk] : null); }
  function vocab() {
    var x;
    if ((x = pick("line_kinds", "line_kinds"))) { LINE_KINDS = x.slice(); KINDS_GIVEN.line = true; }
    if ((x = pick("item_kinds", "item_kinds"))) { ITEM_KINDS = x.slice(); KINDS_GIVEN.item = true; }
    if ((x = pick("item_calls", "item_calls"))) ITEM_CALLS = x;
    if ((x = pick("other_calls", "other_calls"))) OTHER_CALLS = x;
    x = pick("note_required", "note_required");
    if (x) { NOTE_REQUIRED = {}; (Array.isArray(x) ? x : Object.keys(x)).forEach(function (k) { NOTE_REQUIRED[k] = 1; }); }
    if ((x = pick("info_kinds", "info_kinds"))) { INFO_KINDS = {}; (Array.isArray(x) ? x : Object.keys(x)).forEach(function (k) { INFO_KINDS[k] = 1; }); }
    function merge(dst, src) { if (src) Object.keys(src).forEach(function (k) { dst[k] = src[k]; }); }
    merge(KIND_LABEL, T.kind_label); merge(KIND_TIP, T.kind_tip);
    merge(CALL_LABEL, T.call_label); merge(CALL_HELP, T.call_help); merge(CALL_HINT, T.call_hint);
    merge(SEV_LABEL, T.sev_label); merge(SEV_TIP, T.sev_tip); merge(TIER_TIP, T.tier_tip);
    merge(BODY_LABEL, T.body); merge(KEYS, T.keys); merge(W, T.words);
    if (T.hideFields) T.hideFields.forEach(function (f) { HIDE[f] = 1; });
    if (T.itemFacets) ITEM_FACETS = T.itemFacets.slice();
    if (T.QK) QK = T.QK;
    // extra store methods: name -> loopback route; the static and Apps Script adapters bring their own
    var st = T.store || {};
    Object.keys(st).forEach(function (name) {
      if (Store === LOOPBACK && !LOOPBACK[name] && typeof st[name] === "string") {
        LOOPBACK[name] = function (records) { return LOOPBACK._post(st[name], records); };
      }
    });
  }
  function define(t) {
    var obj = typeof t === "function" ? t(A) : t;
    Object.keys(obj || {}).forEach(function (k) { T[k] = obj[k]; });
    // functions a tracker hands to its store adapter through window.ReviewApp (pipelines: setLive for gas.js)
    if (obj && obj.expose) Object.keys(obj.expose).forEach(function (k) { window.ReviewApp[k] = obj.expose[k]; });
    vocab();
    return window.ReviewApp;
  }
  // the helper API a tracker's ext.js works through
  var A = {
    get D() { return D; }, get FS() { return FS; }, set FS(v) { FS = v; }, get S() { return S; },
    get LINES() { return LINES; }, get ITEMS() { return ITEMS; }, get LINE_BY_KEY() { return LINE_BY_KEY; }, get ITEM_BY_KEY() { return ITEM_BY_KEY; },
    get ME() { return ME; }, get Store() { return Store; }, get STATIC() { return STATIC; }, get W() { return W; },
    get REMOTE() { return REMOTE; }, applyRemote: applyRemote, busy: busy, rerender: rerender,
    get KIND_LABEL() { return KIND_LABEL; }, get CALL_LABEL() { return CALL_LABEL; }, get SEV_LABEL() { return SEV_LABEL; },
    NOT_YET: NOT_YET, cards: cards,
    $: $, esc: esc, linkText: linkText, leadOf: leadOf, chip: chip, tipAttrs: tipAttrs, urlLink: urlLink, asList: asList, vmark: vmark, shortLink: shortLink, shortUrl: shortUrl,
    tag: tag, copyBtn: copyBtn, newvHtml: newvHtml, valueRow: valueRow, valueRows: valueRows, refRow: refRow, pairTable: pairTable, tierChip: tierChip, sevChip: sevChip,
    tierSummary: tierSummary, cur: cur, tierOf: tierOf, sevOf: sevOf, dstate: dstate, blankv: blankv, dirLabel: dirLabel, timeOf: timeOf, et: et,
    toast: toast, banner: banner, copyText: copyText, refilter: refilter, changed: changed, renderQueue: renderQueue, renderCard: renderCard,
    renderActive: renderActive, syncControls: syncControls, setLine: setLine, selectPipe: selectPipe, writeRoute: writeRoute, applyRoute: applyRoute,
    applySaved: applySaved, notYet: notYet, facetSelect: facetSelect, fitSelect: fitSelect, facetCounts: facetCounts, match: match, uniq: uniq, defaults: defaults,
    isItemKind: isItemKind, itemsInView: itemsInView, kindLabel: kindLabel, callText: callText, itemHead: itemHead, plural: plural,
    settled: settled, grayed: grayed, counted: counted, isOpen: isOpen, defaultTab: defaultTab, decisionText: decisionText, pipeMatches: pipeMatches,
    save: save, undoCurrent: undoCurrent, undoLast: undoLast, commit: commit, only: only, filterOnly: filterOnly, showBulkFiltered: showBulkFiltered, lineName: lineName, noteOf: noteOf, noteBox: noteBox, dropNoteSave: dropNoteSave, setStat: setStat,
    nextUndecided: nextUndecided, decideCurrent: decideCurrent, lineActions: lineActions, routeHash: routeHash, openSuggest: openSuggest, reload: function (data) { reload(data); },
    get STICKY() { return STICKY; }, setSticky: function (msg) { STICKY = msg || ""; banner(); }
  };

  window.ReviewApp = {
    get data() { return D; }, state: S, filters: function () { return FS; }, refilter: refilter, Store: Store, timing: {},
    reload: reload, applyRoute: applyRoute, writeRoute: writeRoute, banner: banner, toast: toast, esc: esc, copyText: copyText, et: et,
    applyRemote: applyRemote, busy: busy, rerender: rerender, define: define, api: A
  };
  vocab();
  // ext.js loads after this file and calls define() before the page boots
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else setTimeout(init, 0);
})();
