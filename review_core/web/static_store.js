/* Store adapter for the single-file review page (review_core/build_static.py) and the claude.ai artifact built from it. Same interface as the loopback adapter at the top of app.js (caps, load, whoami, decide, item), plus mode "static", download, logs, requestPush, speak, keysFor and apply (so app.js shows records that arrive later by the store's speaker rules) and one method per marker the tracker declares (GOGPT: flag).
   There is no server here, so this file does what review_core/store.py does: it checks every record against the dataset exactly as the store does (keep the two in step), keeps the log, and lays the log over the data.
   The dataset rides in the page: window.REVIEW_STATIC.data when a test or an old page puts it there, else the gzip blob in #review-blob ({data, index, legacy}: the packed key index from build_static.pack_index and the older keys from build_static.legacy_map).
   The log lives in this browser (localStorage, one key per build and set of folders; a rebuilt page carries the calls of earlier builds over) and, on a published artifact, in the artifact database: documents logs/<viewer id>~<browser>~<n>, 250 records each. Every record gets a uuid id here, which the decision ledger dedupes on.
   The tracker block (window.REVIEW_STATIC.tracker, TrackerConfig.page_block) gives the vocabularies and, in rules, the limits and patterns the store checks with (store.page_rules). A tracker's ext.js can add more through StaticStore.extend({...}) and StaticStore.addType(name, validate) before the page boots.
   Nothing here reaches the decision store, the GEM database or a sheet: import_log.py carries the records into the ledger. */
(function () {
  "use strict";
  var CFG = window.REVIEW_STATIC;
  if (!CFG) return;
  var TB = CFG.tracker || {};

  // ---- the vocabularies (TrackerConfig defaults when the page has no tracker block) ----
  var DECISIONS = (TB.decisions || ["accept", "hold", "reject", "suggest"]).slice().sort();
  // the rules the store checks with (store.page_rules); the fallbacks are the store's own values, for a page block without them
  var RULES = TB.rules || {};
  function rx(p, d) { try { return new RegExp(typeof p === "string" ? p : d); } catch (e) { return new RegExp(d); } }
  var MAX_TEXT = RULES.max_text || 5000, MAX_RECORDS = RULES.max_records || 5000, CHUNK = 250;
  var INITIALS_RE = rx(RULES.initials, "^[A-Z]{1,3}$"), EMAIL_RE = rx(RULES.email, "^([^@\\s]+)@[^@\\s]+\\.[^@\\s]+$");
  var URL_RE = rx(RULES.url, "^https?://\\S+$"), EMAIL_SPLIT = rx(RULES.email_split, "[._+\\-]+"), NAME_SPLIT = rx(RULES.name_split, "\\s+");
  var UNDO_KEEPS_REF = RULES.undo_keeps_reference !== false;
  // only a listed kind is a line, so an empty list refuses every line; null (a page without the rule and with an empty list) takes any kind
  var LINE_KINDS = Array.isArray(TB.line_kinds) && (TB.line_kinds.length || RULES.listed_line_kinds_only !== false) ? TB.line_kinds : null;
  var ITEM_CALLS = TB.item_calls || {};
  var OTHER_CALLS = TB.other_calls || ["noted", "todo", "dismissed"];
  var NOTE_REQUIRED = {};
  (TB.note_required || []).forEach(function (k) { NOTE_REQUIRED[k] = 1; });
  var REFERENCES = TB.references !== false;
  var MARKERS = TB.markers || {};
  var MACHINE = {};
  (TB.machine_reviewers || ["push", "backend sync"]).forEach(function (k) { MACHINE[k] = 1; });
  var CAPS = {};
  Object.keys(TB.caps || {decide: true}).forEach(function (k) { CAPS[k] = !!(TB.caps || {decide: true})[k]; });
  var CARDS_KEY = TB.cards_key || "cards";
  var LS_DEVICE = "review-artifact-device", LS_LEGACY = "review-artifact-log";

  // what a tracker's ext.js adds (StaticStore.extend); every hook is optional
  var H = {
    fields: null,          // fields(card, obj, grp) -> the tracker fields a record copies (default: record_id, and column on a line)
    lineRequest: null,     // lineRequest(i, request, entry, api) -> the request to check (pipelines: taking a concern's candidate)
    lineRecord: null,      // lineRecord(i, request, entry, record, api) -> [records] (pipelines: the covered records)
    extras: null,          // extras(records, api) -> item requests a batch of decisions owes (pipelines: concern calls)
    stamp: null,           // stamp(record) after the id and time are set (pipelines: batch, snapshot, origin)
    overlay: null,         // overlay(data, last, api) after the log is laid over the data
    showOthers: !!TB.show_others,   // lay other viewers' records on the page and tell the reviewer when new ones arrive
    texts: {}
  };
  var TEXT = {
    noWrite: "this page is not allowed to save your calls to the artifact (it has to be shared with you by email, as an editor, by the person who published it): your calls are kept in this browser; use download decisions before closing",
    saveError: function (code) { return "the page could not save to the artifact (" + code + "): your calls are kept in this browser; use download decisions before closing"; },
    noPush: "the shared log is not available here, so a push cannot be requested. Use download decisions.",
    nothing: "no calls yet; nothing to push",
    nothingNew: "nothing new to push: every call you made here is already in the log or was sent in an earlier push",
    newCalls: function (n, names) { return n + " new decision" + (n === 1 ? "" : "s") + " by " + names.join(", "); }
  };
  function text(k) { return H.texts[k] != null ? H.texts[k] : TEXT[k]; }

  var G = {
    data: null, packed: null, legacy: null, olds: null, idx: null, logKey: "", built: "", dirs: [], snapshot: "",
    me: CFG.reviewer || "reviewer", email: "", uid: "", device: "",
    own: [],          // the records this browser wrote (and recovered), oldest first
    remote: {},       // doc id -> the latest body of every other log document
    seen: {}, shown: {}, pending: [], synced: {}, rv: 0,
    storage: true, db: null, dl: null, state: "local", message: "", syncing: false, again: false, first: true, loaded: false, dirty: false
  };

  function RA() { return window.ReviewApp; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return String(v == null ? "" : v); }
  function ms(ts) { var t = Date.parse(ts || ""); return isNaN(t) ? 0 : t; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  // ISO seconds in Eastern time with its offset, like store.now(): 2026-10-02T17:41:03-04:00
  function now() {
    var d = new Date(), parts = {};
    try {
      new Intl.DateTimeFormat("en-US", {timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"}).formatToParts(d)
        .forEach(function (p) { parts[p.type] = p.value; });
      var asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
      var off = Math.round((asUtc - d.getTime()) / 60000), sign = off < 0 ? "-" : "+";
      off = Math.abs(off);
      return parts.year + "-" + parts.month + "-" + parts.day + "T" + parts.hour + ":" + parts.minute + ":" + parts.second +
        sign + pad(Math.floor(off / 60)) + ":" + pad(off % 60);
    } catch (e) {
      return d.toISOString().slice(0, 19) + "Z";
    }
  }
  // a uuid4 for every record (the ledger's dedupe key); the fallback is for an old browser or an insecure origin
  function uuid() {
    try { if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID(); } catch (e) { /* fall through */ }
    var h = "0123456789abcdef", s = "";
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) s += "-";
      else if (i === 14) s += "4";
      else if (i === 19) s += h[(Math.random() * 4 | 0) + 8];
      else s += h[Math.random() * 16 | 0];
    }
    return s;
  }
  // mirror of store.initials: "Amalia Llano" and amalia.llano@x.org both give "AL". A machine reviewer, a value already in initials form, an empty value and one with no part starting with a letter come back unchanged.
  function initials(who) {
    var v = str(who).trim();
    if (!v || has(MACHINE, v) || INITIALS_RE.test(v)) return who;
    var m = EMAIL_RE.exec(v);
    var parts = (m ? m[1].split(EMAIL_SPLIT) : v.split(NAME_SPLIT)).filter(function (t) { return /^\p{L}/u.test(t); });
    if (!parts.length) return who;
    function first(t) { return String.fromCodePoint(t.codePointAt(0)); }
    return (first(parts[0]) + (parts.length > 1 ? first(parts[parts.length - 1]) : "")).toUpperCase();
  }
  function segment(s) { return str(s).replace(/[^A-Za-z0-9_.~:@+-]/g, "-").slice(0, 80) || "x"; }
  function legacySegment(s) { return str(s).replace(/[^A-Za-z0-9_\-.~:@+]/g, "_").slice(0, 120) || "x"; }

  // ---- the dataset ----
  function gunzip(b64) {
    if (!window.DecompressionStream) return Promise.reject(new Error("this browser cannot unpack the dataset: use a current Chrome, Edge, Firefox or Safari"));
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text().then(JSON.parse);
  }
  function cardsOf(data) { return data.cards || data[CARDS_KEY] || []; }
  // key -> {card, obj, grp} for every line and item
  function index(data) {
    var out = {};
    cardsOf(data).forEach(function (p) {
      ["lines", "items"].forEach(function (grp) {
        (p[grp] || []).forEach(function (o) { out[o.key] = {card: p, obj: o, grp: grp}; });
      });
    });
    return out;
  }
  // the packed index entry for a key (build_static.pack_index), or null on a page without one
  function packed(key) {
    var I = G.packed;
    if (!I || typeof key !== "string") return null;
    if (!I.dn) { I.dn = {}; I.dirs.forEach(function (d, i) { I.dn[d] = i; }); }
    var at = key.indexOf("::");
    if (at <= 0) return null;
    var dir = key.substr(0, at), rest = key.substr(at + 2), grp = has(I.dn, dir) ? I.keys[I.dn[dir]] : null;
    return grp && has(grp, rest) ? grp[rest] : null;
  }
  var loading = null;
  function fetchData() {
    if (loading) return loading;
    if (CFG.data) loading = Promise.resolve({data: CFG.data, index: null, legacy: CFG.legacy || null});
    else {
      var el = typeof document !== "undefined" && document.getElementById("review-blob");
      loading = el ? gunzip(el.textContent.replace(/\s+/g, "")) : Promise.resolve({data: {cards: [], dirs: []}, index: null});
    }
    loading = loading.then(function (b) {
      G.data = b.data; G.packed = b.index || null; G.legacy = b.legacy || null;
      G.idx = index(G.data);
      G.built = G.data.built || ""; G.dirs = G.data.dirs || [];
      G.snapshot = (G.data.scope && G.data.scope.snapshot) || "";
      G.logKey = "review-log:" + G.built + ":" + G.dirs.join(",");
      readLog();
      return G.data;
    });
    return loading;
  }

  // ---- markers (flag-style records beside a decision, TrackerConfig.markers) ----
  function markerKey(name, dir, pid) { var m = MARKERS[name]; return m.prefix + str(dir) + "::" + (m.card_tag || "card") + ":" + str(pid); }
  function markerCard(key) {
    var hit = null;
    Object.keys(MARKERS).forEach(function (name) {
      cardsOf(G.data).forEach(function (p) { if (!hit && markerKey(name, p.dir, p.pid) === key) hit = p; });
    });
    return hit;
  }
  // a marker record names a line or item (<prefix><key>) or a card this build still has
  function markerKnown(r) {
    var key = str(r && r.key), ok = false;
    Object.keys(MARKERS).forEach(function (name) {
      var pre = MARKERS[name].prefix;
      if (key.indexOf(pre) === 0 && (has(G.idx, key.slice(pre.length)) || markerCard(key))) ok = true;
    });
    return ok;
  }
  // an older key one of this build's keys was logged under (build_static.legacy_map): its records still speak for the line
  function isOld(key) {
    if (!G.legacy) return false;
    if (!G.olds) {
      G.olds = {};      // older key -> the keys of this build it was an older key of
      Object.keys(G.legacy).forEach(function (k) { G.legacy[k].forEach(function (o) { (has(G.olds, o) ? G.olds[o] : (G.olds[o] = [])).push(k); }); });
    }
    return has(G.olds, key);
  }
  // the keys of this build a record under key can speak for: the key itself and every key it is an older key of
  function keysFor(key) { return [key].concat(isOld(key) ? G.olds[key] : []); }
  function known(r) { return !!(r && r.key && (has(G.idx, r.key) || markerKnown(r) || isOld(r.key))); }

  // ---- the browser log ----
  function readLog() {
    try {
      var raw = localStorage.getItem(G.logKey);
      if (raw) G.own = JSON.parse(raw);
      if (!Array.isArray(G.own)) G.own = [];
    } catch (e) { G.storage = false; G.own = []; }
    if (!G.own.length) carryOver();
  }
  // A rebuilt page has a new build stamp and so a new, empty log. Bring across the calls this browser made on earlier builds (and the older one-key log), for the records the rebuild still has. Any earlier build counts, not only one with the same folders: a batch that gains a staging folder must not start from an empty log. The earlier logs stay where they are.
  function carryOver() {
    var old = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k === G.logKey) continue;
        if (k !== LS_LEGACY && k.indexOf("review-log:") !== 0) continue;
        var recs = JSON.parse(localStorage.getItem(k) || "[]");
        if (Array.isArray(recs)) old = old.concat(recs.filter(known));
      }
    } catch (e) { return; }
    if (!old.length) return;
    G.own = merge([], old);
    writeLog();
  }
  function writeLog() {
    try { localStorage.setItem(G.logKey, JSON.stringify(G.own)); G.storage = true; }
    catch (e) { G.storage = false; }
  }
  // a record's id when it has one, else its content
  function fingerprint(r) {
    if (r.id) return "id:" + r.id;
    return [r.key, r.ts, r.reviewer, r.decision || "", r.call || "", !!r.undecided, r.suggested_value || "", r.reference || "", r.note || "",
            r.on == null ? "" : String(!!r.on)].join("\u0001");
  }
  // union of two record lists in time order; on equal stamps the first list's order wins
  function merge(a, b) {
    var seen = {}, out = [];
    a.concat(b || []).forEach(function (r, i) {
      if (!r || !r.key || !r.ts) return;
      var f = fingerprint(r);
      if (seen[f]) return;
      seen[f] = 1; out.push({r: r, i: i});
    });
    out.sort(function (x, y) { return ms(x.r.ts) - ms(y.r.ts) || x.i - y.i; });
    return out.map(function (x) { return x.r; });
  }

  // ---- validation: a mirror of review_core/store.py ----
  function refuse(msg) { return new Error(msg); }
  function list(records, what) {
    if (!Array.isArray(records) || !records.length) throw refuse("expected a non-empty list of " + what + " records");
    if (records.length > MAX_RECORDS) throw refuse("too many records in one request (" + records.length + ")");
  }
  function repr(v) { return typeof v === "string" ? "'" + v + "'" : v == null ? "None" : str(v); }
  // the line or item a record names: it has to be in the dataset and, on a page that has one, in the packed index
  function lookup(key) {
    if (typeof key !== "string" || !has(G.idx, key)) return null;
    return G.packed && !packed(key) ? null : G.idx[key];
  }
  function entry(r, i) {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw refuse("record " + i + ": not an object");
    var e = lookup(r.key);
    if (!e) throw refuse("record " + i + ": unknown key " + repr(r.key));
    return e;
  }
  function textOf(v, i, what) {
    var s = str(v || "");
    if (s.length > MAX_TEXT) throw refuse("record " + i + ": the " + what + " is longer than " + MAX_TEXT + " characters");
    return s;
  }
  function checkRef(i, ref) {
    if (ref && !URL_RE.test(ref)) throw refuse("record " + i + ": reference " + repr(ref) + " is not a web address (http or https)");
  }
  function fields(card, obj, grp) {
    if (H.fields) return H.fields(card, obj, grp) || {};
    var f = packed(obj.key);
    if (f && f.f) return JSON.parse(JSON.stringify(f.f));
    return grp === "lines" ? {record_id: obj.record_id || null, column: obj.column || ""} : {record_id: obj.record_id || null};
  }
  function base(e) {
    var rec = {key: e.obj.key, dir: e.obj.dir || e.card.dir, pid: e.obj.pid || e.card.pid};
    var f = fields(e.card, e.obj, e.grp);
    Object.keys(f).forEach(function (k) { rec[k] = f[k]; });
    return rec;
  }
  function validateLines(records) {
    list(records, "decision");
    var out = [];
    records.forEach(function (r, i) {
      var e = entry(r, i);
      if (e.grp !== "lines" || (LINE_KINDS && LINE_KINDS.indexOf(e.obj.kind) < 0)) throw refuse("record " + i + ": " + repr(r.key) + " is an item, not a line");
      if (H.lineRequest) r = H.lineRequest(i, r, e, API);
      var undo = !!(r.undo || r.undecided), decision = r.decision;
      if (undo && !decision) decision = e.obj["default"] || "hold";      // an undo record still carries a decision field
      if (!undo && !decision) throw refuse("record " + i + ": no decision given (a bare key never defaults to accept)");
      if (DECISIONS.indexOf(decision) < 0) throw refuse("record " + i + ": decision " + repr(decision) + " is not one of " + DECISIONS.join(", "));
      var note = textOf(r.note, i, "note"), sv = textOf(r.suggested_value, i, "suggested value");
      if (decision === "suggest" && !undo && !sv.trim() && !note.trim()) throw refuse("record " + i + ": a suggestion needs a suggested_value or a note");
      var rec = base(e);
      rec.kind = e.obj.kind; rec.decision = decision; rec.suggested_value = sv;
      if (REFERENCES) {
        var ref = str(r.reference || "").trim();
        checkRef(i, ref);
        rec.reference = undo && !UNDO_KEEPS_REF ? "" : ref;
      }
      rec.note = note; rec.reviewer = G.me; rec.ts = null; rec.undecided = undo;
      out = out.concat(H.lineRecord ? H.lineRecord(i, r, e, rec, API) : [rec]);
    });
    return out;
  }
  function callsFor(kind) { return ITEM_CALLS[kind] || OTHER_CALLS; }
  function validateItems(records) {
    list(records, "item");
    return records.map(function (r, i) {
      var e = entry(r, i);
      if (e.grp !== "items") throw refuse("record " + i + ": " + repr(r.key) + " is a line, not an item");
      var undo = !!(r.undo || r.undecided), call = undo ? "" : str(r.call || "");
      var vocab = callsFor(e.obj.kind);
      if (!undo && vocab.indexOf(call) < 0) throw refuse("record " + i + ": call " + repr(call) + " is not one of " + vocab.join(", ") + " for a " + e.obj.kind + " item");
      var note = textOf(r.note, i, "note");
      if (!undo && NOTE_REQUIRED[e.obj.kind + ":" + call] && !note.trim()) throw refuse("record " + i + ": " + call.replace(/_/g, " ") + " needs a note saying why");
      var rec = base(e);
      rec.kind = e.obj.kind; rec.call = call;
      if (REFERENCES) {
        var ref = str(r.reference || "").trim();
        checkRef(i, ref);
        rec.reference = undo && !UNDO_KEEPS_REF ? "" : ref;
      }
      rec.note = note; rec.reviewer = G.me; rec.ts = null; rec.undecided = undo;
      return rec;
    });
  }
  // mirror of the store's marker validator: {key, on, note?} for a line or item, {pid, dir, on, note?} for a whole card
  function markerValidator(name) {
    var m = MARKERS[name];
    return function (records) {
      list(records, name);
      return records.map(function (r, i) {
        if (!r || typeof r !== "object" || Array.isArray(r)) throw refuse("record " + i + ": not an object");
        var on = has(r, "on") ? !!r.on : true, note = textOf(r.note, i, "note"), rec;      // like the store's r.get("on", True): only a missing on counts as on
        if (r.key) {
          var e = lookup(r.key);
          if (!e) throw refuse("record " + i + ": unknown key " + repr(r.key));
          rec = {key: m.prefix + r.key, dir: e.obj.dir || e.card.dir, pid: e.obj.pid || e.card.pid, record_id: e.obj.record_id || null, kind: e.obj.kind};
        } else {
          var p = null;
          cardsOf(G.data).forEach(function (x) { if (!p && x.pid === r.pid && x.dir === r.dir) p = x; });
          cardsOf(G.data).forEach(function (x) { if (!p && x.pid === r.pid) p = x; });
          if (!p) throw refuse("record " + i + ": unknown " + (m.card_tag || "card") + " " + repr(r.pid));
          rec = {key: markerKey(name, p.dir, p.pid), dir: p.dir, pid: p.pid, record_id: null, kind: m.card_tag || "card"};
        }
        rec[name] = m.value; rec.on = on; rec.note = note; rec.reviewer = G.me; rec.ts = null; rec.undecided = false;
        return rec;
      });
    };
  }
  // the call that stands on an item: the record that speaks for it in this browser's log (says), else the one the page was built with
  function callOf(key) {
    var e = has(G.idx, key) ? G.idx[key] : null, o = e && e.grp === "items" ? e.obj : null;
    var rec = says(pool(), key, o ? shownBy(o) : null);
    if (rec) return rec.undecided ? "" : str(get(rec, "call", ""));
    return o ? (o.call || "") : "";
  }

  // ---- whose record speaks for a key (mirror of store.reviewed, store.calls and store.speaker) ----
  function isMachine(r) { return has(MACHINE, str(r && r.reviewer)); }
  // a person's live call: not a machine's, not an undo
  function reviewed(r) { return !!r && !isMachine(r) && !r.undecided; }
  // Python's dict.get: the default only when the field is missing
  function get(r, k, d) { return r && has(r, k) ? r[k] : d; }
  // key -> {person: the latest person record (an undo included), machine: the latest machine record, last: the latest of either}, from records in time order
  function calls(records) {
    var out = {};
    records.forEach(function (r) {
      var k = r && r.key;
      if (!k) return;
      var c = has(out, k) ? out[k] : (out[k] = {person: null, machine: null, last: null});
      c[isMachine(r) ? "machine" : "person"] = r;
      c.last = r;
    });
    return out;
  }
  function legacyOf(key) { return G.legacy && has(G.legacy, key) ? G.legacy[key] : []; }
  // [the record that speaks for key, its latest machine record]. A person's live call speaks first: the key's own or, when the key has no person record at all, the one older key (build_static.legacy_map) that holds a live one. Otherwise the latest record of any kind speaks: an undo, or a machine record.
  function speaker(byKey, key) {
    var c = has(byKey, key) ? byKey[key] : {}, prec = c.person || null;
    if (!prec) {
      var leg = legacyOf(key).filter(function (k) { return has(byKey, k) && byKey[k].person && !byKey[k].person.undecided; });
      if (leg.length === 1) prec = byKey[leg[0]].person;
    }
    var live = prec && !prec.undecided ? prec : null;
    return [live || c.last || null, c.machine || null];
  }
  // the records this page lays over its data (this browser's and the visible shared ones) in time order, and their calls; rebuilt when either changes
  var POOL = null;
  function pool() {
    if (!POOL || POOL.own !== G.own || POOL.rv !== G.rv || POOL.uid !== G.uid) {
      var recs = allRecords();
      POOL = {own: G.own, rv: G.rv, uid: G.uid, records: recs, byKey: calls(recs)};
    }
    return POOL;
  }
  // what the page shows for a line, item or marker as it was built: a person's live call (reviewed) and when it was made (at)
  function shownBy(o) { return {reviewed: !!o.reviewed, at: o.decided_at || null}; }
  // The record the browser's records say for a key, or null when the values the page was built with stand.
  // The page was built with the store's overlay of the whole log, and the browser holds only part of it, so the speaker over the browser's records is checked against what the page shows:
  //   - a record under an older key never speaks over a call the page shows on the key itself,
  //   - a machine record never speaks over a person's call the page shows, unless a person record here is as new as that call,
  //   - a record older than the call the page shows never speaks over it, unless it is a person's call and the page shows a machine's.
  // What the page cannot know is a person's undo in the log it was built from: a line it shows undecided may still let an older key speak here.
  function says(P, key, shown) {
    var rec = speaker(P.byKey, key)[0];
    if (!rec || !shown || (!shown.reviewed && !shown.at)) return rec;
    var pr = has(P.byKey, key) ? P.byKey[key].person : null;
    if (shown.reviewed && rec.key !== key) return null;
    if (shown.reviewed && isMachine(rec) && !(pr && (!shown.at || ms(pr.ts) >= ms(shown.at)))) return null;
    if (shown.at && ms(shown.at) > ms(rec.ts) && !(reviewed(rec) && !shown.reviewed)) return null;
    return rec;
  }

  // ---- the overlay: lay the browser's records over the data (mirror of store.overlay) ----
  function visibleRemote() {
    var out = [], mine = segment(G.uid || "anon") + "~";
    Object.keys(G.remote).forEach(function (id) {
      if (H.showOthers || (G.uid && id.indexOf(mine) === 0)) out = out.concat(G.remote[id].records || []);
    });
    return out;
  }
  function allRecords() { return merge(G.own, visibleRemote()); }
  // The fields store.overlay sets, from the record that speaks (says). A key nothing here speaks for keeps the values the page was built with.
  // Lines: decision, suggested_value, reference (when the tracker takes references), decision_note (a person's note on a live call). Items: call, call_note, call_reference.
  // Both: reviewed, decided_by, decided_at. Each marker: <field>_flag, <field>_note, <field>_by on lines and items, <field>_flag and <field>_note on cards.
  // A tracker's overlay hook gets last, key -> the record that speaks, for every key the browser's records changed (and every other key they speak for).
  function apply(o, grp, rec) {
    var live = rec.undecided ? null : rec;
    if (grp === "lines") {
      var sug = !!live && get(live, "decision", null) === "suggest";
      o.decision = live ? get(live, "decision", null) : null;
      o.suggested_value = sug ? get(live, "suggested_value", "") : "";
      if (REFERENCES) o.reference = sug ? get(live, "reference", "") : "";
      o.decision_note = live && reviewed(rec) ? get(live, "note", "") : "";
    } else {
      o.call = live ? get(live, "call", null) : null;
      o.call_note = live ? get(live, "note", "") : null;
      if (REFERENCES) o.call_reference = live ? get(live, "reference", "") : "";
    }
    o.reviewed = reviewed(rec);
    o.decided_by = live ? get(rec, "reviewer", null) : null;
    o.decided_at = live ? get(rec, "ts", null) : null;
  }
  function overlay(data) {
    var P = pool(), last = {};
    Object.keys(P.byKey).forEach(function (k) { var r = speaker(P.byKey, k)[0]; if (r) last[k] = r; });
    function marks(o, card, keyOf) {
      Object.keys(MARKERS).forEach(function (name) {
        var m = MARKERS[name], fld = m.field || name;
        var rec = says(P, keyOf(name, m), {reviewed: !!o[fld + "_flag"], at: null});
        if (!rec) {
          if (o[fld + "_flag"] == null) { o[fld + "_flag"] = false; o[fld + "_note"] = ""; if (!card) o[fld + "_by"] = null; }
          return;
        }
        var hit = reviewed(rec) && get(rec, "on", null) ? rec : null;
        o[fld + "_flag"] = !!hit;
        o[fld + "_note"] = hit ? get(hit, "note", "") : "";
        if (!card) o[fld + "_by"] = hit ? get(hit, "reviewer", null) : null;
      });
    }
    cardsOf(data).forEach(function (p) {
      ["lines", "items"].forEach(function (grp) {
        (p[grp] || []).forEach(function (o) {
          var rec = says(P, o.key, shownBy(o));
          if (rec) { last[o.key] = rec; apply(o, grp, rec); }
          else delete last[o.key];
          marks(o, false, function (name, m) { return m.prefix + o.key; });
        });
      });
      marks(p, true, function (name) { return markerKey(name, p.dir, p.pid); });
    });
    if (H.overlay) H.overlay(data, last, API);
    return data;
  }

  // ---- writes ----
  function save(recs) {
    var ts = now();
    recs.forEach(function (r) {
      r.ts = ts; r.id = uuid();
      if (H.stamp) H.stamp(r);
      G.seen[r.id] = 1;
      G.shown[r.key] = Math.max(G.shown[r.key] || 0, ms(ts));
    });
    G.own = G.own.concat(recs);
    writeLog();
    sync();
    return Promise.resolve(recs);
  }
  function run(make) {
    if (!CAPS.decide) return Promise.reject(new Error(G.why || "this page cannot record decisions"));
    return fetchData().then(function () { return save(make()); });
  }

  // ---- the shared log (the artifact database) ----
  function prefix() { return segment(G.uid || "anon") + "~" + segment(G.device) + "~"; }
  function body(n) {
    return {reviewer: G.me, email: G.email, uid: G.uid, device: G.device, n: n, built: G.built, dirs: G.dirs,
            updated: now(), records: G.own.slice(n * CHUNK, (n + 1) * CHUNK)};
  }
  function fail(e) {
    var code = (e && (e.code || e.message)) || "unknown";
    G.state = "error";
    G.message = (e && (e.code === "invalid_argument" || e.code === "not_granted" || e.code === "revoked")) ? text("noWrite") : text("saveError")(code);
    if (RA() && RA().banner) RA().banner(G.message);
  }
  function sync() {
    // never before the first snapshot: until then this browser does not know what its documents hold, and a write would replace them with a shorter log
    if (!G.db || G.first) return;
    if (G.syncing) { G.again = true; return; }
    G.syncing = true; G.again = false;
    var todo = [], chunks = Math.ceil(G.own.length / CHUNK);
    for (var n = 0; n < chunks; n++) {
      var want = Math.min(CHUNK, G.own.length - n * CHUNK);
      if (G.synced[n] !== want) todo.push(n);
    }
    var p = Promise.resolve();
    todo.forEach(function (n) {
      p = p.then(function () {
        var b = body(n);
        return G.db.doc("logs/" + prefix() + n).set(b).then(function () { G.synced[n] = b.records.length; });
      });
    });
    p.then(function () {
      G.syncing = false;
      G.state = "synced"; G.message = "";
      if (G.again) sync();
    }, function (e) { G.syncing = false; fail(e); });
  }
  function settle() { return new Promise(function (ok) { (function wait(i) { if (!G.syncing || i > 40) return ok(); setTimeout(function () { wait(i + 1); }, 250); })(0); }); }
  // records the page does not show yet, oldest first; one older than what its key shows is dropped
  function fresh(recs) {
    return (recs || []).filter(function (r) { return r && r.id && r.key && !G.seen[r.id]; })
      .sort(function (a, b) { return ms(a.ts) - ms(b.ts); })
      .filter(function (r) {
        G.seen[r.id] = 1;
        if (ms(r.ts) < (G.shown[r.key] || 0)) return false;
        G.shown[r.key] = ms(r.ts);
        return true;
      });
  }
  // after boot: lay new records on the page; the page re-renders when the reviewer is not typing
  function deliver(recs, tell) {
    var ra = RA();
    if (!ra || !ra.data || !ra.applyRemote) { G.pending = G.pending.concat(recs); return; }
    var f = fresh(G.pending.concat(recs));
    G.pending = [];
    if (!f.length) return;
    if (ra.applyRemote(f)) G.dirty = true;
    if (!tell) return;
    var names = {}, n = 0, mine = segment(G.uid || "anon") + "~";
    f.forEach(function (r) { if (!r.via && !isMachine(r) && r.reviewer !== G.me) { n++; names[r.reviewer || "someone"] = 1; } });
    if (n && mine) ra.toast(text("newCalls")(n, Object.keys(names)));
  }
  function onDocs(snap) {
    var mine = prefix(), person = segment(G.uid || "anon") + "~", legacy = G.uid ? "logs/" + legacySegment(G.uid) : "", lost = [], incoming = [], self = [];
    snap.docs.forEach(function (d) {
      var b = d.data(), id = d.id;
      if (!b || !Array.isArray(b.records)) return;
      var own = id.indexOf(mine) === 0 || (legacy && (id === legacy || "logs/" + id === legacy));
      if (own) {                      // this browser's chunks (and the one-document log of the older page): note what the log holds, recover what this browser lost
        if (id.indexOf(mine) === 0) {
          var n = Number(id.slice(mine.length));
          if (!has(G.synced, n) || G.first) G.synced[n] = b.records.length;
        }
        var ids = {};
        G.own.forEach(function (r) { ids[fingerprint(r)] = 1; });
        b.records.forEach(function (r) { if (r && r.key && r.ts && !ids[fingerprint(r)] && known(r)) lost.push(r); });
        return;
      }
      G.remote[id] = b; G.rv++;
      incoming = incoming.concat(b.records);
      if (G.uid && id.indexOf(person) === 0) self = self.concat(b.records);     // the same person on another browser or device
    });
    if (lost.length) {
      G.own = merge(G.own, lost);
      writeLog();
    }
    var first = G.first;
    G.first = false;
    if (first) sync();
    // a first snapshot that beat the page's load is laid on by load itself; one that came after the load gave up waiting is delivered like any later one
    if (first && !G.loaded) return;
    var shown = H.showOthers ? incoming : self;
    deliver(lost.concat(shown), !first);
  }
  var READY = null;
  function connect() {
    if (READY) return READY;
    var c = window.claude;
    if (!c || typeof c.use !== "function") { READY = Promise.resolve(G.me); return READY; }      // opened from disk
    READY = Promise.all([c.use("db"), c.use("downloads"), c.use("user"), c.use("comments")]).then(function (ns) {
      var db = ns[0], user = ns[2];
      G.dl = ns[1];
      G.cm = ns[3] || null;            // null unless the published page declares comments: "push to log" then also wakes the watching session
      if (!user) return {db: db};
      return Promise.all([user.id ? user.id() : null, user.me ? user.me() : null, user.can ? user.can("data.write") : null]).then(function (u) {
        return {db: db, uid: u[0], me: u[1], can: u[2]};
      });
    }).then(function (v) {
      var me = v.me || {};
      G.uid = v.uid || me.id || "";
      G.email = me.email || "";
      // the address first: the ledger derives initials from it, so the page and the store agree
      var who = str(initials(me.email) || initials(me.name));
      // a one-word profile name gives one letter; the builder's own two initials complete it
      if (who.length === 1 && CFG.reviewer && CFG.reviewer.charAt(0) === who) who = CFG.reviewer;
      if (who) G.me = who;
      if (!v.db) return G.me;
      if (v.can === false) { G.state = "error"; G.message = text("noWrite"); return G.me; }
      try { G.device = localStorage.getItem(LS_DEVICE) || ""; } catch (e) { G.device = ""; }
      if (!G.device) { G.device = uuid().slice(0, 8); try { localStorage.setItem(LS_DEVICE, G.device); } catch (e) { /* this visit only */ } }
      G.db = v.db;
      return new Promise(function (ok) {
        var done = false;
        function go() { if (!done) { done = true; ok(G.me); } }
        try {
          v.db.collection("logs").onSnapshot(function (snap) { onDocs(snap); go(); }, function (e) {
            G.db = null; fail(e); go();
          });
        } catch (e) { G.db = null; go(); }
        setTimeout(go, 4000);            // a slow database never holds the page back; its records arrive live
      }).then(function () {
        if (G.db && G.state !== "error") G.state = "synced";
        setInterval(function () {
          var ra = RA();
          if (G.pending.length) deliver([], false);
          if (G.dirty && ra && ra.busy && !ra.busy()) { G.dirty = false; ra.rerender(); }
        }, 1000);
        return G.me;
      });
    }).catch(function (e) { G.state = "error"; G.message = text("saveError")((e && (e.code || e.message)) || "unknown"); return G.me; });
    return READY;
  }

  // ---- download and the push request ----
  function logs() {
    var out = [];
    if (G.own.length) out.push({reviewer: G.me, email: G.email, uid: G.uid, device: G.device, records: G.own});
    Object.keys(G.remote).sort().forEach(function (k) { out.push(G.remote[k]); });
    return out;
  }
  function count() {
    var n = 0;
    logs().forEach(function (l) { n += (l.records || []).length; });
    return n;
  }
  function download() {
    var stamp = now().slice(0, 16).replace(/[-:]/g, "").replace("T", "_");
    var name0 = "review_log_" + G.dirs.map(function (d) {
      var parts = d.split("/").filter(Boolean); if (parts[parts.length - 1] === "staging") parts.pop(); return parts[parts.length - 1] || d;
    }).join("+") + "_" + G.me + "_" + stamp + "_ET";
    var n = count();
    if (G.dl) {    // the artifact viewer saves files itself; .json is on its list, .jsonl is not
      var name = name0 + ".json";
      var data = JSON.stringify({reviewer: G.me, built: G.built, dirs: G.dirs, downloaded: now(), logs: logs()}, null, 1);
      return G.dl.save({filename: name, data: data}).then(function () { return {name: name, count: n}; },
        function (e) { throw new Error(e && e.code === "declined" ? "download cancelled" : (e && e.message) || "download failed"); });
    }
    var recs = merge(G.own, visibleRemote());
    var body = recs.map(function (r) { return JSON.stringify(r); }).join("\n") + (recs.length ? "\n" : "");
    var fname = name0 + ".jsonl";
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], {type: "application/x-ndjson;charset=utf-8"})); a.download = fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    return Promise.resolve({name: fname, count: recs.length});
  }
  // one file for the viewer to keep (a route's geometry): the artifact viewer's downloads when the page has them, otherwise a link click. -> the name saved
  function saveFile(name, text, type) {
    if (G.dl) return G.dl.save({filename: name, data: text}).then(function () { return name; },
      function (e) { throw new Error(e && e.code === "declined" ? "download cancelled" : (e && e.message) || "download failed"); });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], {type: (type || "application/json") + ";charset=utf-8"})); a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    return Promise.resolve(name);
  }
  // "push to log": make sure the shared log is current, then leave a request document in the requests collection for a Claude Code session watching this artifact.
  // Only calls the log does not have yet count (the import skips records already in the log by id, so a push only ever adds what is new). A call is left out when
  //   - its id is in CFG.logged, the page records the log already held when the page was built (build_static.logged_ids), or
  //   - the dataset already shows a person's decision on its line or item at the same time or later (it was imported, or superseded and skipped), or
  //   - this browser already sent it in an earlier push (kept per set of folders, so a rebuilt page, which carries the old calls over, does not count them again).
  var LOGGED = {};
  (CFG.logged || []).forEach(function (id) { LOGGED[id] = 1; });
  function pushedKey() { return "review-pushed:" + G.dirs.join(","); }
  function readPushed() {
    try { var a = JSON.parse(localStorage.getItem(pushedKey()) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function inLog(r) {
    if (r.id && LOGGED[r.id]) return true;
    var e = G.idx && has(G.idx, r.key) ? G.idx[r.key] : null, o = e && e.obj;
    return !!(o && o.reviewed && o.decided_at && ms(o.decided_at) >= ms(r.ts));
  }
  function unpushed() {
    var sent = {};
    readPushed().forEach(function (f) { sent[f] = 1; });
    return G.own.filter(function (r) { return !sent[fingerprint(r)] && !inLog(r); });
  }
  // After the request document is written, the push also wakes the Claude Code session watching the artifact: a comment sent to Claude
  // (comments.sendToClaude), anchored on the button the viewer clicked. Editors only, and only inside the viewer's own gesture; when the
  // send cannot go through (no session watching, a non-editor, the gesture expired, the page published without comments) nothing is posted
  // and the request document alone stands for the session's periodic check. The viewer is told which of the two happened.
  function wake(el, n) {
    if (!G.cm || !el || !el.isConnected) return Promise.resolve(false);
    return G.cm.canSendToClaude().then(function (can) {
      if (can !== "available") return false;
      return G.cm.anchorFor(el).then(function (anchor) {
        var msg = "push to log: " + n + " new decision" + (n === 1 ? "" : "s") + " from " + (G.me || "a reviewer") + " at " + now() +
          ". Please import the log, plan the sheet push and ask whether to apply it.";
        return G.cm.sendToClaude({anchor: anchor, text: msg}).then(function () { return true; });
      });
    }).catch(function () { return false; });
  }
  function requestPush(el) {
    if (!G.db) return Promise.reject(new Error(text("noPush")));
    if (!G.own.length) return Promise.reject(new Error(text("nothing")));
    var fresh = unpushed(), n = fresh.length;
    if (!n) return Promise.reject(new Error(text("nothingNew")));
    return settle().then(function () {
      return G.db.doc("requests/" + segment(G.uid || "anon") + "~" + segment(G.device) + "~push").set({
        reviewer: G.me, uid: G.uid, device: G.device, requested: now(), records: n, total: G.own.length,
        built: G.built, dirs: G.dirs, snapshot: G.snapshot, seq: Date.now(), status: "requested"});
    }).then(function () {
      // every own call the log does not show yet has now been sent; the ones it shows need no entry
      try { localStorage.setItem(pushedKey(), JSON.stringify(G.own.filter(function (r) { return !inLog(r); }).map(fingerprint))); } catch (e) { /* the next push counts these again; the import still skips them */ }
      return wake(el, n).then(function (sent) { return {count: n, sent: sent}; });
    }, function (e) {
      throw new Error("the request did not go through (" + ((e && (e.code || e.message)) || "unknown") + ")");
    });
  }

  // the helpers a tracker's hooks get
  var API = {
    get data() { return G.data; }, get index() { return G.idx; }, get me() { return G.me; }, state: G,
    entry: function (key) { return lookup(key); }, packed: packed, refuse: refuse, str: str, has: has,
    callOf: callOf, validateItems: validateItems, now: now, uuid: uuid,
    // [the record that speaks for a key among the browser's records, its latest machine record] (store.speaker; pipelines: applied comes from the second)
    speak: function (key) { return speaker(pool().byKey, key); }, isMachine: isMachine, reviewed: reviewed
  };

  function wrap(fn) { return function (records) { try { return run(function () { return fn(records); }); } catch (e) { return Promise.reject(e); } }; }
  var Store = {
    mode: "static",
    caps: CAPS,
    get reviewer() { return G.me; },
    storageOk: function () { return G.storage; },
    // "synced": the log is also in the artifact database; "local": this browser only; "error": see message
    status: function () { return {state: G.state, message: G.message}; },
    count: count,
    load: function () {
      return fetchData().then(connect).then(function () {
        var d = overlay(JSON.parse(JSON.stringify(G.data)));
        allRecords().forEach(function (r) { if (r.id) G.seen[r.id] = 1; G.shown[r.key] = Math.max(G.shown[r.key] || 0, ms(r.ts)); });
        G.loaded = true;
        return d;
      });
    },
    whoami: function () { return connect(); },
    decide: wrap(function (records) {
      var recs = validateLines(records);
      var owed = H.extras ? H.extras(recs, API) || [] : [];
      return owed.length ? recs.concat(validateItems(owed)) : recs;
    }),
    item: wrap(validateItems),
    download: download,
    saveFile: saveFile,
    requestPush: requestPush,
    logs: logs,
    // for tests and for a reviewer who wants to look: this browser's raw log
    log: function () { return G.own.slice(); },
    // What app.js applyRemote needs to show a record that arrives after the page loaded the way load shows the log (store.speaker):
    //   speak(key): [the record that speaks for a line or item key (null when the values the page was built with stand, see says), the key's latest machine record]
    //   keysFor(key): the line and item keys a record under key can speak for (itself and the keys it is an older key of)
    //   apply(o, grp, rec): set the fields store.overlay sets on a line ("lines") or item ("items") from the record that speaks
    speak: function (key) {
      var P = pool(), e = has(G.idx, key) ? G.idx[key] : null;
      var s = speaker(P.byKey, key);
      return [e ? says(P, key, shownBy(e.obj)) : s[0], s[1]];
    },
    keysFor: keysFor,
    apply: function (o, grp, rec) { apply(o, grp, rec); },
    state: G,
    // a tracker's ext.js adds hooks (see H above) and texts
    extend: function (h) {
      Object.keys(h || {}).forEach(function (k) {
        if (k === "texts") Object.keys(h.texts).forEach(function (t) { H.texts[t] = h.texts[t]; });
        else H[k] = h[k];
      });
      return Store;
    },
    // a tracker record type beside decisions and calls: Store[name](records) checks them with validate(records, api) and writes them to the log
    addType: function (name, validate) {
      Store[name] = wrap(function (records) { return validate(records, API); });
      return Store;
    },
    open: function (u) {         // window.open is not reliable inside an artifact; a real link is
      var a = document.createElement("a");
      a.href = u; a.target = "_blank"; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
    }
  };
  Object.keys(MARKERS).forEach(function (name) {
    Store[name] = wrap(markerValidator(name));
  });
  window.StaticStore = Store;
})();
