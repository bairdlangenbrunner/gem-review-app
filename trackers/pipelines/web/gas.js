/* Apps Script adapter for the shared review app (gem-review-app), moved from the pipelines repo, where it began. Loaded BEFORE app.js.
   On the Apps Script page (google.script.run exists) it defines window.GasStore, the Store the
   app uses in place of the local HTTP one, and window.GasNav, which carries the route (the page
   is a sandboxed iframe: its own location is not the address bar). Anywhere else it does nothing.

   What it adds to the local behavior:
     - scopes: the published datasets (scopes.json); one is open at a time (?scope=<id>, a picker)
     - the dataset arrives as gzipped parts; decisions stored after it was published are laid on top
     - every 45 s (while the tab is visible) it asks the store for newer decisions, so two
       reviewers see each other's calls; a write that would land on a line someone else decided
       since this page last heard from the store is refused, their call is shown, nothing is saved
     - a republished scope is reloaded in place
     - candidate route geometry opens in a dialog (there is no /geo/ URL here)
   Server side: the researcher repo's review_app/gas/Code.gs.
   A tracker record type beside decisions and calls (GOGPT: flag) goes through GasStore.addType(name, serverFunction), which adds GasStore[name](records) calling that Code.gs function the same way decide does. */
(function () {
  "use strict";
  if (!(window.google && google.script && google.script.run)) return;

  var POLL_MS = 45000;
  var MACHINE = {"backend sync": 1, "push": 1};
  var G = {
    me: "", scopes: [], scope: null,
    cursor: 1,          // the last store row this page has seen
    rows: {},           // key -> the store row of the record this page shows for it
    pending: [],        // records fetched with the dataset, applied once the app has indexed it
    geo: null, dirty: false, stale: false, reloading: false, polling: false, lastPoll: 0,
    types: {},                    // tracker record types added with addType: name -> Code.gs function
    chain: Promise.resolve()      // writes go one at a time
  };
  function RA() { return window.ReviewApp; }

  // google.script.run as a promise; an {ok: false} answer (a refusal) rejects with .body set
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var r = google.script.run.withSuccessHandler(function (b) {
        if (b && b.ok) return resolve(b);
        var e = new Error(b && b.error ? b.error : "the server gave no answer");
        e.body = b || {};
        reject(e);
      }).withFailureHandler(function (err) {
        reject(new Error(err && err.message ? err.message : String(err)));
      });
      r[fn].apply(r, args);
    });
  }
  function gunzip(b64) {
    if (!window.DecompressionStream) return Promise.reject(new Error("this browser cannot unpack the dataset: use a current Chrome, Edge, Firefox or Safari"));
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text().then(JSON.parse);
  }
  function part(sc, name) { return call("getPart", sc.id, sc.ver, name).then(function (b) { return gunzip(b.b64); }); }
  function where() {
    return new Promise(function (resolve) {
      try { google.script.url.getLocation(function (loc) { resolve(loc || {}); }); } catch (e) { resolve({}); }
    });
  }
  function find(id) {
    var hit = null;
    G.scopes.forEach(function (s) { if (s.id === id) hit = s; });
    return hit;
  }
  function pick(want) {
    var saved = "";
    try { saved = localStorage.getItem("review-scope") || ""; } catch (e) { /* storage blocked */ }
    return find(want) || find(saved) ||
      G.scopes.slice().sort(function (a, b) { return String(b.published).localeCompare(String(a.published)); })[0];
  }

  // ---- routing ----
  var Nav = {
    hash: "",
    write: function (h, replace) {
      Nav.hash = h;
      try { google.script.history[replace ? "replace" : "push"](null, G.scope ? {scope: G.scope.id} : {}, h.replace(/^#/, "")); }
      catch (e) { /* the route is a convenience */ }
    }
  };
  try {
    google.script.history.setChangeHandler(function (e) {
      var loc = (e && e.location) || {}, want = loc.parameter && loc.parameter.scope;
      Nav.hash = loc.hash ? "#" + loc.hash : "";
      if (want && G.scope && want !== G.scope.id && find(want)) return switchScope(want, true);
      if (RA() && RA().data) RA().applyRoute();
    });
  } catch (e) { /* no history API: links still open, back/forward do not move the app */ }

  // ---- loading ----
  var who = null;
  function whoami(again) {
    if (!who || again) {
      who = Promise.all([call("whoami"), where()]).then(function (r) {
        var b = r[0], loc = r[1];
        G.me = b.reviewer;
        G.scopes = b.scopes || [];
        Store.caps = {decide: !!(b.caps && b.caps.decide), refresh: false, push: false};
        Object.keys(G.types).forEach(function (t) { Store.caps[t] = Store.caps.decide; });
        if (!G.scopes.length) throw new Error("nothing has been published yet (review_app/publish.py --upload)");
        if (G.scope) G.scope = find(G.scope.id) || pick("");
        else {
          Nav.hash = loc.hash ? "#" + loc.hash : "";
          G.scope = pick(loc.parameter && loc.parameter.scope);
        }
        return b.reviewer;
      });
      who.catch(function () { who = null; });
    }
    return who;
  }
  function loadScope(sc) {
    return Promise.all(sc.parts.map(function (n) { return part(sc, n); })).then(function (parts) {
      var data = parts[0];
      var ck = data.cards ? "cards" : "pipelines";      // the list of cards; datasets from before the shared app call it pipelines
      for (var i = 1; i < parts.length; i++) data[ck] = data[ck].concat(parts[i][ck] || parts[i].cards || parts[i].pipelines || []);
      return call("getDecisions", sc.id, sc.ver, sc.store_cursor).then(function (d) {
        if (d.ver !== sc.ver) { var e = new Error("this scope was republished while it loaded"); e.body = {reload: true}; throw e; }
        G.cursor = d.cursor; G.rows = {}; G.pending = d.records || []; G.geo = null; G.dirty = false; G.stale = false;
        G.lastPoll = Date.now();
        return data;
      });
    });
  }
  function load(retried) {
    return whoami().then(function () { return loadScope(G.scope); }).catch(function (e) {
      if (e.body && e.body.reload && !retried) return whoami(true).then(function () { return load(true); });
      throw e;
    });
  }
  // records not yet shown: a record is skipped when this page already shows a later row for its key
  function fresh(recs) {
    return (recs || []).filter(function (r) {
      if (!r || !r.key) return false;
      if (r.row && G.rows[r.key] && r.row <= G.rows[r.key]) return false;
      if (r.row) G.rows[r.key] = r.row;
      return true;
    });
  }
  function announce(recs) {
    var names = {}, n = 0;
    recs.forEach(function (r) {
      if (r.via || MACHINE[r.reviewer]) return;
      n++;
      names[r.reviewer === G.me ? "you (another tab)" : r.reviewer] = 1;
    });
    if (n) RA().toast(n + " new decision" + (n === 1 ? "" : "s") + " by " + Object.keys(names).join(", "));
  }

  // ---- live drift check: the published cells against the backend sheet as it is now ----
  function liveCheck(manual) {
    var ra = RA(), sc = G.scope, btn = document.getElementById("sync");
    if (!ra || !ra.data || !sc || G.liveBusy) return Promise.resolve();
    G.liveBusy = true;
    if (btn) { btn.disabled = true; btn.textContent = "checking…"; }
    return call("liveCheck", sc.id, sc.ver).then(function (r) {
      if (G.scope !== sc) return;
      var n = ra.setLive(r);
      ra.rerender();
      var gone = r.gone.length ? ", " + r.gone.length + " no longer on the sheet" : "";
      if (manual || n || r.gone.length) ra.toast("backend checked " + ra.et(r.checked_at) + ": " + n + " change" + (n === 1 ? "" : "s") + " changed since published" + gone);
    }).catch(function (e) {
      if (manual) ra.toast("backend check failed: " + e.message);
      else if (window.console) console.warn("live check:", e.message);
    }).then(function () {
      G.liveBusy = false;
      if (btn) { btn.disabled = false; btn.innerHTML = "&#8635; check backend"; }
    });
  }

  // ---- the header: scope picker, tip, what the page cannot do here ----
  function chrome() {
    var ra = RA(), D = ra && ra.data, sc = G.scope;
    if (!D || !sc) return;
    var sync = document.getElementById("sync");
    if (sync) {                                   // the dataset is rebuilt by publish.py; the button only re-reads the sheet
      sync.hidden = false; sync.disabled = false;
      sync.innerHTML = "&#8635; check backend";
      sync.dataset.tip = "read the live backend sheet (read-only) and flag lines whose cells changed since this was published";
      sync.onclick = function () { liveCheck(true); };
    }
    if (G.liveVer !== sc.ver) { G.liveVer = sc.ver; liveCheck(false); }
    var label = document.getElementById("scope");
    label.dataset.tip = "published " + ra.et(sc.published) + " · built " + ra.et(D.built) + " · " + D.dirs.length + " staging dir" +
      (D.dirs.length === 1 ? "" : "s") + ": " + D.dirs.map(function (d) { return String(d).split("/").pop(); }).join(", ");
    var sel = document.getElementById("scope-pick");
    if (!sel && G.scopes.length > 1) {
      sel = document.createElement("select");
      sel.id = "scope-pick";
      sel.setAttribute("aria-label", "review scope");
      sel.onchange = function () { switchScope(sel.value, false); };
      label.parentNode.insertBefore(sel, label);
    }
    if (sel) {
      sel.innerHTML = G.scopes.map(function (s) {
        return '<option value="' + ra.esc(s.id) + '">' + ra.esc(s.label || s.id) + "</option>";
      }).join("");
      sel.value = sc.id;
    }
    var n = 0;
    (D.cards || D.pipelines || []).forEach(function (p) { p.lines.forEach(function (l) { if (l.drift && l.reviewed) n++; }); });
    if (n) ra.banner(n + " decided change" + (n === 1 ? " was" : "s were") + " judged against backend cells that have since changed: more filters > sheet changed since decided");
  }
  function switchScope(id, fromNav) {
    var ra = RA(), sc = find(id), sel = document.getElementById("scope-pick");
    if (!sc || !ra || sc === G.scope) return;
    if (G.reloading || ra.busy()) {
      if (sel) sel.value = G.scope.id;
      return ra.toast("finish what is open first, then switch scope");
    }
    G.reloading = true;
    ra.toast("loading " + (sc.label || sc.id) + "…");
    var prev = G.scope;
    G.scope = sc;
    loadScope(sc).then(function (data) {
      try { localStorage.setItem("review-scope", id); } catch (e) { /* storage blocked */ }
      if (!fromNav) Nav.hash = "";
      ra.banner("");
      ra.reload(data);                     // -> Store.ready()
      if (fromNav) ra.applyRoute(); else ra.writeRoute(false);
    }).catch(function (e) {
      G.scope = prev;
      if (sel) sel.value = prev.id;
      ra.toast("could not load " + (sc.label || sc.id) + ": " + e.message);
    }).then(function () { G.reloading = false; });
  }
  function republished() {
    var ra = RA();
    G.reloading = true; G.stale = false;
    whoami(true).then(function () { return loadScope(G.scope); }).then(function (data) {
      ra.reload(data);
      ra.toast("the dataset was republished (" + ra.et(G.scope.published) + "): reloaded");
    }).catch(function (e) {
      ra.banner("this scope was republished and could not be reloaded (" + e.message + "): reload the page");
    }).then(function () { G.reloading = false; });
  }

  // ---- other reviewers' decisions ----
  function poll() {
    var ra = RA(), sc = G.scope;
    if (G.polling || G.reloading || !sc || !ra || !ra.data) return Promise.resolve(0);
    G.polling = true; G.lastPoll = Date.now();
    return call("getDecisions", sc.id, sc.ver, G.cursor).then(function (d) {
      if (G.scope !== sc) return 0;
      if (d.ver !== sc.ver) { G.stale = true; return 0; }
      G.cursor = Math.max(G.cursor, d.cursor);
      var f = fresh(d.records), n = ra.applyRemote(f);
      if (n) { G.dirty = true; announce(f); }
      return n;
    }).catch(function () { return 0; }).then(function (n) { G.polling = false; return n; });
  }
  setInterval(function () {
    var ra = RA();
    if (!ra || !ra.data || G.reloading) return;
    if (G.stale && !ra.busy()) return republished();
    if (G.dirty && !ra.busy()) { G.dirty = false; ra.rerender(); }
    if (document.visibilityState === "visible" && Date.now() - G.lastPoll > POLL_MS) poll();
  }, 1000);

  // ---- writes ----
  function write(fn, records) {
    if (!Store.caps.decide) return Promise.reject(new Error("this page cannot record decisions"));
    var run = function () {
      var sc = G.scope, ra = RA();
      return call(fn, sc.id, sc.ver, records, G.cursor).then(function (b) {
        if (G.scope === sc) {
          var others = fresh(b.others);            // stored between this page's last sync and this write
          if (ra.applyRemote(others)) announce(others);
          fresh(b.saved);
          G.cursor = Math.max(G.cursor, b.cursor);
        }
        return b.saved;
      }, function (e) {
        var b = e.body || {};
        if (b.stale && G.scope === sc) {           // someone else decided it first: show theirs, save nothing
          G.cursor = Math.max(G.cursor, b.cursor || 0);
          if (ra.applyRemote(fresh(b.records))) G.dirty = true;
          ra.banner(e.message);
        } else if (b.reload) G.stale = true;
        throw e;
      });
    };
    var p = G.chain.then(run, run);
    G.chain = p.catch(function () { /* the caller has the error */ });
    return p;
  }

  // ---- candidate route geometry ----
  function geoLines(g) {
    var out = [];
    (function walk(x) {
      if (!x) return;
      if (x.type === "FeatureCollection") (x.features || []).forEach(walk);
      else if (x.type === "Feature") walk(x.geometry);
      else if (x.type === "GeometryCollection") (x.geometries || []).forEach(walk);
      else if (x.type === "LineString") out.push(x.coordinates);
      else if (x.type === "MultiLineString") (x.coordinates || []).forEach(function (c) { out.push(c); });
      else if (x.type === "Point") out.push([x.coordinates]);
    })(g);
    return out.filter(function (l) { return l && l.length && l[0] && l[0].length >= 2; });
  }
  function sketch(ls) {
    var W = 520, H = 300, P = 14, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    ls.forEach(function (l) { l.forEach(function (c) { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); }); });
    var k = Math.cos((y0 + y1) / 2 * Math.PI / 180) || 1, dx = (x1 - x0) * k || 1e-6, dy = (y1 - y0) || 1e-6;
    var s = Math.min((W - 2 * P) / dx, (H - 2 * P) / dy);
    var ox = (W - dx * s) / 2, oy = (H - dy * s) / 2;
    function pt(c) { return (ox + (c[0] - x0) * k * s).toFixed(1) + "," + (H - oy - (c[1] - y0) * s).toFixed(1); }
    var h = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="route sketch, north up, no basemap">';
    ls.forEach(function (l) {
      if (l.length > 1) h += '<polyline fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" points="' + l.map(pt).join(" ") + '"/>';
      [l[0], l[l.length - 1]].forEach(function (c) { var q = pt(c).split(","); h += '<circle r="4" cx="' + q[0] + '" cy="' + q[1] + '" fill="currentColor"/>'; });
    });
    return h + "</svg>";
  }
  function showGeo(name) {
    var ra = RA(), dlg = document.getElementById("dialog"), sc = G.scope;
    function close() { return '<div class="actions"><button type="button" id="dlg-close">close</button></div>'; }
    function wire() { document.getElementById("dlg-close").onclick = function () { dlg.close(); }; }
    dlg.setAttribute("data-kind", "geo");
    dlg.innerHTML = "<h3>candidate route</h3><p class=\"faint\">loading the geometry…</p>" + close();
    wire();
    if (!dlg.open) dlg.showModal();
    if (!sc.geo) G.geo = Promise.reject(new Error("this scope was published without route geometry"));
    else if (!G.geo) G.geo = part(sc, sc.geo);
    G.geo.then(function (all) {
      var g = all[name];
      if (!g) throw new Error("this file is not in the published geometry: " + name);
      var ls = geoLines(g), n = 0, text = JSON.stringify(g);
      ls.forEach(function (l) { n += l.length; });
      function ll(c) { return c[1].toFixed(5) + ", " + c[0].toFixed(5); }
      var ends = ls.length ? "from " + ll(ls[0][0]) + " to " + ll(ls[ls.length - 1][ls[ls.length - 1].length - 1]) + " (lat, lon)" : "no line geometry";
      var props = g.type === "FeatureCollection" ? ((g.features || [])[0] || {}).properties : g.properties;
      dlg.innerHTML = "<h3>candidate route</h3><p><code>" + ra.esc(name.split("/").pop()) + "</code> &middot; " + ls.length + " part" + (ls.length === 1 ? "" : "s") +
        ", " + n + " vertices<br>" + ra.esc(ends) + "</p>" + (ls.length ? sketch(ls) : "") +
        '<p class="faint">a sketch: north up, no basemap. Copy the GeoJSON into QGIS or geojson.io to see it on a map.</p>' +
        (props ? "<details><summary>properties</summary><pre>" + ra.esc(JSON.stringify(props, null, 1)) + "</pre></details>" : "") +
        '<div class="actions"><button type="button" class="ghost" id="dlg-copy">copy GeoJSON</button><button type="button" id="dlg-close">close</button></div>';
      wire();
      document.getElementById("dlg-copy").onclick = function () { ra.copyText(text, "GeoJSON copied"); };
    }).catch(function (e) {
      G.geo = null;
      dlg.innerHTML = "<h3>candidate route</h3><p class=\"err\">" + ra.esc(e.message) + "</p>" + close();
      wire();
    });
  }

  var Store = {
    caps: {decide: false, refresh: false, push: false},
    whoami: function () { return whoami(); },
    load: function () { return load(false); },
    decide: function (records) { return write("decide", records); },
    item: function (records) { return write("recordItems", records); },
    refresh: function () { return Promise.reject(new Error("the Google page cannot rebuild the dataset: run review_app/publish.py")); },
    // called by the app once it has indexed a dataset (boot and reload): lay the later store records on it
    ready: function () {
      var recs = fresh(G.pending);
      G.pending = [];
      RA().applyRemote(recs);
      setTimeout(chrome, 0);
    },
    showGeo: showGeo,
    poll: poll,
    state: G,
    // a tracker record type: GasStore[name](records) calls the Code.gs function `fn` (default record<Name>s)
    addType: function (name, fn) {
      fn = fn || "record" + name.charAt(0).toUpperCase() + name.slice(1) + "s";
      Store[name] = function (records) { return write(fn, records); };
      G.types[name] = fn;
      Store.caps[name] = Store.caps.decide;
      return Store;
    }
  };
  window.GasStore = Store;
  window.GasNav = Nav;
})();
