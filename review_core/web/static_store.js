/* Store adapter for the single-file review page (review_core/build_static.py) and the claude.ai artifact built from it. Same interface as the loopback adapter at the top of app.js (caps, load, whoami, decide, item), plus mode "static", download, logs, requestPush and one method per marker the tracker declares (GOGPT: flag).
   There is no server here, so this file does what review_core/store.py does: it checks every record against the dataset exactly as the store does (keep the two in step), keeps the log, and lays the log over the data.
   The dataset rides in the page: window.REVIEW_STATIC.data when a test or an old page puts it there, else the gzip blob in #review-blob ({data, index}, the packed key index from build_static.pack_index).
   The log lives in this browser (localStorage, one key per build and set of folders; a rebuilt page carries the calls of earlier builds over) and, on a published artifact, in the artifact database: documents logs/<viewer id>~<browser>~<n>, 250 records each. Every record gets a uuid id here, which the decision ledger dedupes on.
   The tracker block (window.REVIEW_STATIC.tracker, TrackerConfig.page_block) gives the vocabularies. A tracker's ext.js can add more through StaticStore.extend({...}) and StaticStore.addType(name, validate) before the page boots.
   Nothing here reaches the decision store, the GEM database or a sheet: import_log.py carries the records into the ledger. */
(function () {
  "use strict";
  var CFG = window.REVIEW_STATIC;
  if (!CFG) return;
  var TB = CFG.tracker || {};

  // ---- the vocabularies (TrackerConfig defaults when the page has no tracker block) ----
  var DECISIONS = (TB.decisions || ["accept", "hold", "reject", "suggest"]).slice().sort();
  var LINE_KINDS = TB.line_kinds && TB.line_kinds.length ? TB.line_kinds : null;     // null: any kind a line carries
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
  var URL_RE = /^https?:\/\/\S+$/;
  var MAX_TEXT = 5000, MAX_RECORDS = 5000, CHUNK = 250;
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
    newCalls: function (n, names) { return n + " new decision" + (n === 1 ? "" : "s") + " by " + names.join(", "); }
  };
  function text(k) { return H.texts[k] != null ? H.texts[k] : TEXT[k]; }

  var G = {
    data: null, packed: null, idx: null, logKey: "", built: "", dirs: [], snapshot: "",
    me: CFG.reviewer || "reviewer", email: "", uid: "", device: "",
    own: [],          // the records this browser wrote (and recovered), oldest first
    remote: {},       // doc id -> the latest body of every other log document
    seen: {}, shown: {}, pending: [], synced: {},
    storage: true, db: null, dl: null, state: "local", message: "", syncing: false, again: false, first: true, dirty: false
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
  // mirror of store.initials: "Amalia Llano" and amalia.llano@x.org both give "AL"
  function initials(who) {
    var v = str(who).trim();
    if (!v || /^[A-Z]{1,4}$/.test(v)) return v;
    var m = /^([^@\s]+)@[^@\s]+\.[^@\s]+$/.exec(v);
    var parts = (m ? m[1].split(/[._+\-]+/) : v.split(/\s+/)).filter(function (t) { return /^[A-Za-z]/.test(t); });
    if (!parts.length) return "";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
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
    if (CFG.data) loading = Promise.resolve({data: CFG.data, index: null});
    else {
      var el = typeof document !== "undefined" && document.getElementById("review-blob");
      loading = el ? gunzip(el.textContent.replace(/\s+/g, "")) : Promise.resolve({data: {cards: [], dirs: []}, index: null});
    }
    loading = loading.then(function (b) {
      G.data = b.data; G.packed = b.index || null;
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
      if (key.indexOf(pre) === 0 && (G.idx[key.slice(pre.length)] || markerCard(key))) ok = true;
    });
    return ok;
  }
  function known(r) { return !!(r && r.key && (G.idx[r.key] || markerKnown(r))); }

  // ---- the browser log ----
  function readLog() {
    try {
      var raw = localStorage.getItem(G.logKey);
      if (raw) G.own = JSON.parse(raw);
      if (!Array.isArray(G.own)) G.own = [];
    } catch (e) { G.storage = false; G.own = []; }
    if (!G.own.length) carryOver();
  }
  // A rebuilt page has a new build stamp and so a new, empty log. Bring across the calls this browser made on earlier builds of the same folders (and the older one-key log), for the records the rebuild still has. The earlier logs stay where they are.
  function carryOver() {
    var tail = ":" + G.dirs.join(","), old = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k === G.logKey) continue;
        if (k !== LS_LEGACY && (k.indexOf("review-log:") !== 0 || k.slice(-tail.length) !== tail)) continue;
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
  function entry(r, i) {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw refuse("record " + i + ": not an object");
    var e = G.idx[r.key];
    if (!e) throw refuse("record " + i + ": unknown key " + str(r.key));
    return e;
  }
  function textOf(v, i, what) {
    var s = str(v);
    if (s.length > MAX_TEXT) throw refuse("record " + i + ": the " + what + " is longer than " + MAX_TEXT + " characters");
    return s;
  }
  function checkRef(i, ref) {
    if (ref && !URL_RE.test(ref)) throw refuse("record " + i + ": the reference must be a URL starting with http:// or https://");
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
      if (e.grp !== "lines" || (LINE_KINDS && LINE_KINDS.indexOf(e.obj.kind) < 0)) throw refuse("record " + i + ": " + r.key + " is an item, not a line");
      if (H.lineRequest) r = H.lineRequest(i, r, e, API);
      var undo = !!(r.undo || r.undecided), decision = r.decision;
      if (undo && !decision) decision = e.obj["default"] || "hold";      // an undo record still carries a decision field
      if (!undo && !decision) throw refuse("record " + i + ": no decision given (a bare key never defaults to accept)");
      if (DECISIONS.indexOf(decision) < 0) throw refuse("record " + i + ": decision " + decision + " is not one of " + DECISIONS.join(", "));
      var note = textOf(r.note, i, "note"), sv = textOf(r.suggested_value, i, "suggested value");
      if (decision === "suggest" && !undo && !sv.trim() && !note.trim()) throw refuse("record " + i + ": a suggestion needs a suggested_value or a note");
      var rec = base(e);
      rec.kind = e.obj.kind; rec.decision = decision; rec.suggested_value = sv;
      if (REFERENCES) {
        var ref = str(r.reference).trim();
        checkRef(i, ref);
        rec.reference = undo ? "" : ref;
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
      if (e.grp !== "items") throw refuse("record " + i + ": " + r.key + " is a line, not an item");
      var undo = !!(r.undo || r.undecided), call = undo ? "" : str(r.call), note = textOf(r.note, i, "note");
      var vocab = callsFor(e.obj.kind);
      if (!undo && vocab.indexOf(call) < 0) throw refuse("record " + i + ": call " + call + " is not one of " + vocab.join(", ") + " for a " + e.obj.kind + " item");
      if (!undo && NOTE_REQUIRED[e.obj.kind + ":" + call] && !note.trim()) throw refuse("record " + i + ": " + call.replace(/_/g, " ") + " needs a note saying why");
      var rec = base(e);
      rec.kind = e.obj.kind; rec.call = call;
      if (REFERENCES) {
        var ref = str(r.reference).trim();
        checkRef(i, ref);
        rec.reference = undo ? "" : ref;
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
        if (!r || typeof r !== "object") throw refuse("record " + i + ": not an object");
        var on = r.on == null ? true : !!r.on, note = textOf(r.note, i, "note"), rec;
        if (r.key) {
          var e = G.idx[r.key];
          if (!e) throw refuse("record " + i + ": unknown key " + str(r.key));
          rec = {key: m.prefix + r.key, dir: e.obj.dir || e.card.dir, pid: e.obj.pid || e.card.pid, record_id: e.obj.record_id || null, kind: e.obj.kind};
        } else {
          var p = null;
          cardsOf(G.data).forEach(function (x) { if (!p && x.pid === r.pid && x.dir === r.dir) p = x; });
          cardsOf(G.data).forEach(function (x) { if (!p && x.pid === r.pid) p = x; });
          if (!p) throw refuse("record " + i + ": unknown " + (m.card_tag || "card") + " " + str(r.pid));
          rec = {key: markerKey(name, p.dir, p.pid), dir: p.dir, pid: p.pid, record_id: null, kind: m.card_tag || "card"};
        }
        rec[name] = m.value; rec.on = on; rec.note = note; rec.reviewer = G.me; rec.ts = null; rec.undecided = false;
        return rec;
      });
    };
  }
  // the latest call on an item, from the log or the data the page was built with
  function callOf(key) {
    var c = null;
    allRecords().forEach(function (r) { if (r.key === key && "call" in r) c = r.undecided ? "" : r.call; });
    if (c != null) return c;
    var e = G.idx[key];
    return e && e.grp === "items" ? (e.obj.call || "") : "";
  }

  // ---- the overlay: lay the log over the data, latest record per key (mirror of store.overlay) ----
  function visibleRemote() {
    var out = [], mine = segment(G.uid || "anon") + "~";
    Object.keys(G.remote).forEach(function (id) {
      if (H.showOthers || (G.uid && id.indexOf(mine) === 0)) out = out.concat(G.remote[id].records || []);
    });
    return out;
  }
  function allRecords() { return merge(G.own, visibleRemote()); }
  function overlay(data) {
    var last = {};
    allRecords().forEach(function (r) { if (r.key && !MACHINE[r.reviewer]) last[r.key] = r; });
    function marks(o, key, card) {
      Object.keys(MARKERS).forEach(function (name) {
        var m = MARKERS[name], f = last[card ? key : m.prefix + key], fld = m.field || name;
        if (!f) {
          if (o[fld + "_flag"] == null) { o[fld + "_flag"] = false; o[fld + "_note"] = ""; if (!card) o[fld + "_by"] = null; }
          return;
        }
        var on = !!f.on && !f.undecided;
        o[fld + "_flag"] = on;
        o[fld + "_note"] = on ? f.note || "" : "";
        if (!card) o[fld + "_by"] = on ? f.reviewer : null;
      });
    }
    cardsOf(data).forEach(function (p) {
      Object.keys(MARKERS).forEach(function (name) { marks(p, markerKey(name, p.dir, p.pid), true); });
      ["lines", "items"].forEach(function (grp) {
        (p[grp] || []).forEach(function (o) {
          marks(o, o.key, false);
          var rec = last[o.key];
          if (!rec) return;
          var live = rec.undecided ? null : rec;
          if (grp === "lines") {
            var sug = !!live && live.decision === "suggest";
            o.decision = live ? live.decision : null;
            o.suggested_value = sug ? live.suggested_value || "" : "";
            if (REFERENCES) o.reference = sug ? live.reference || "" : "";
            o.decision_note = live ? live.note || "" : "";
          } else {
            o.call = live ? live.call : null;
            o.call_note = live ? live.note || "" : null;
            if (REFERENCES) o.call_reference = live ? live.reference || "" : "";
          }
          o.reviewed = !!live;
          o.decided_by = live ? live.reviewer : null;
          o.decided_at = live ? live.ts : null;
        });
      });
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
    if (!G.db) return;
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
    f.forEach(function (r) { if (!r.via && !MACHINE[r.reviewer] && r.reviewer !== G.me) { n++; names[r.reviewer || "someone"] = 1; } });
    if (n && mine) ra.toast(text("newCalls")(n, Object.keys(names)));
  }
  function onDocs(snap) {
    var mine = prefix(), legacy = G.uid ? "logs/" + legacySegment(G.uid) : "", lost = [], incoming = [];
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
      G.remote[id] = b;
      incoming = incoming.concat(b.records);
    });
    if (lost.length) {
      G.own = merge(G.own, lost);
      writeLog();
    }
    var first = G.first;
    G.first = false;
    if (first) { sync(); return; }
    var shown = H.showOthers ? incoming : [];
    deliver(lost.concat(shown), true);
  }
  var READY = null;
  function connect() {
    if (READY) return READY;
    var c = window.claude;
    if (!c || typeof c.use !== "function") { READY = Promise.resolve(G.me); return READY; }      // opened from disk
    READY = Promise.all([c.use("db"), c.use("downloads"), c.use("user")]).then(function (ns) {
      var db = ns[0], user = ns[2];
      G.dl = ns[1];
      if (!user) return {db: db};
      return Promise.all([user.id ? user.id() : null, user.me ? user.me() : null, user.can ? user.can("data.write") : null]).then(function (u) {
        return {db: db, uid: u[0], me: u[1], can: u[2]};
      });
    }).then(function (v) {
      var me = v.me || {};
      G.uid = v.uid || me.id || "";
      G.email = me.email || "";
      // the address first: the ledger derives initials from it, so the page and the store agree
      var who = initials(me.email) || initials(me.name);
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
  // "push to log": make sure the shared log is current, then leave a request document in the requests collection for a Claude Code session watching this artifact
  function requestPush() {
    if (!G.db) return Promise.reject(new Error(text("noPush")));
    if (!G.own.length) return Promise.reject(new Error(text("nothing")));
    var n = G.own.length;
    return settle().then(function () {
      return G.db.doc("requests/" + segment(G.uid || "anon") + "~" + segment(G.device) + "~push").set({
        reviewer: G.me, uid: G.uid, device: G.device, requested: now(), records: n,
        built: G.built, dirs: G.dirs, snapshot: G.snapshot, seq: Date.now(), status: "requested"});
    }).then(function () { return {count: n}; }, function (e) {
      throw new Error("the request did not go through (" + ((e && (e.code || e.message)) || "unknown") + ")");
    });
  }

  // the helpers a tracker's hooks get
  var API = {
    get data() { return G.data; }, get index() { return G.idx; }, get me() { return G.me; }, state: G,
    entry: function (key) { return G.idx[key] || null; }, packed: packed, refuse: refuse, str: str, has: has,
    callOf: callOf, validateItems: validateItems, now: now, uuid: uuid
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
    requestPush: requestPush,
    logs: logs,
    // for tests and for a reviewer who wants to look: this browser's raw log
    log: function () { return G.own.slice(); },
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
