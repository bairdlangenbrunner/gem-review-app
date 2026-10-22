"""
The pipelines review config. pipelines-researcher binds it through its review_app shims (store.py, server.py, build_static.py), the same way gogpt-researcher binds trackers/gogpt.

Line kinds: ref (a Data Source link), fill (a blank cell gets a value), status, oo (owner or operator), route and new_row. A line record also names its sheet row and the column its reference goes in. A line can cover other records (a status line and the `Status [ref]` record folded into it are one decision), and every covered record gets the same call in the same write.

Item kinds: a concern (a validity question on a contested value) is confirmed, dismissed or sent back for more research. Every other kind is noted, todo or dismissed. A `confirmed` item is information only and nobody is asked to call it.

A person's line call can answer a concern in the same write. Accepting a line whose proposed value equals the concern's contested value dismisses the concern. Taking the concern's candidate value instead of the proposal (a `rival` request, stored as a suggest) confirms it.

Machine reviewers: "backend sync" (a refresh found the line already in the sheet), "push" (push.py wrote the cell) and "apply_route_candidates" (the §8 apply wrote a route line's sheet columns). Their records never count as a person's call; the line shows them as `applied`.

What stays repo code in pipelines-researcher: the refresh (scripts/refresh_csvs.sh plus a dataset rebuild), the push plan and apply (push.py) and the `basis` stamp (review_data.basis). The routes below call the refresh and push through methods on the repo's App subclass, and answer 409 when the subclass does not have them.

The single-file page index carries what the pipelines page store and the Apps Script server (Code.gs) read: per line r (sheet row), c (reference column), b (basis), d (default, "hold" when the line has none), v (covers) and x (concern answers); and at the top w (the backend cells each line was judged against, for the live drift check) and cmd (the commodity). index_entry fills what one line carries; index_extras adds x, w and cmd. pipelines-researcher's publish.py writes this same index (review_core.build_static.pack_index) for the parked Google page.

Two behaviors moved to the shared core on the port (2026-10-08), neither pinned by a pipelines test: a line whose live call is not a suggest now shows an empty `suggested_value` (the pipelines overlay used to leave the value of an earlier suggest in place); and the reviewer-facing error texts for refresh and push keep their pipelines wording through the routes below.
"""
import sys
from pathlib import Path
from urllib.parse import unquote

from review_core.config import TrackerConfig
from review_core.server import Refusal
from review_core.store import Invalid

LINE_KINDS = ("ref", "fill", "status", "oo", "route", "new_row")
ITEM_KINDS = ("concern", "routeqc", "route_suggestion", "monitor", "flag", "escalation",
              "unresolved", "confirmed", "other")
CONCERN_CALLS = ("confirmed", "dismissed", "needs_research")
OTHER_CALLS = ("noted", "todo", "dismissed")
SYNC_REVIEWER = "backend sync"
MACHINE_REVIEWERS = {"backend sync", "push", "apply_route_candidates"}
INFO_KINDS = {"confirmed"}


# ---- keys --------------------------------------------------------------------------
# A line or item key is `<dir>::<pid>|<sheet_row>|<colid>`. The colid is review_data's (`Capacity`, a multi-column fill `Capacity+CapacityUnits`), plus `#<class><n>` when one dir, ProjectID, row and colid held several records. These are the one place the shape is written and read: review_data builds keys with make_key, and publish, decisions and import_log read them with parse_key and resolve_key.

def make_key(d, pid, row, colid):
    """The key of a line or item: `<dir>::<pid>|<row>|<colid>`, the colid with its `#...` suffix."""
    return f"{d}::{pid}|{row}|{colid}"


def parse_key(key):
    """`<dir>::<pid>|<row>|<colid>` to (dir, pid, row, colid), the colid WITH its `#...` suffix. None for any other key (a marker key, a malformed one)."""
    d, sep, rest = str(key).partition("::")
    parts = rest.split("|", 2)
    return (d, parts[0], parts[1], parts[2]) if sep and len(parts) == 3 else None


def legacy_colids(colid):
    """The single-column colids a multi-column fill colid was logged under before 2026-10-01, one per value column, each with the fill's `#...` suffix. An empty list for any other colid."""
    base, _, suffix = str(colid).partition("#")
    if "+" not in base:
        return []
    sfx = "#" + suffix if suffix else ""
    return [c + sfx for c in base.split("+")]


def legacy_keys(key):
    """The keys a multi-column fill (`...|ProposalYear+ProposalMonth`, `...|Capacity+CapacityUnits#FILL2`) was logged under before 2026-10-01: one per value column, since which column came first cannot be recovered from the key. An empty list for any other key."""
    s = parse_key(key)
    return [make_key(s[0], s[1], s[2], c) for c in legacy_colids(s[3])] if s else []


def key_index(known_keys):
    """What resolve_key looks a key up in: the known keys themselves, the known keys by (dir, pid, colid), and the multi-column fill keys by (dir, pid, one of their single colids). Build it once when resolving many keys against one build."""
    by_ident, by_legacy = {}, {}
    for k in known_keys:
        s = parse_key(k)
        if not s:
            continue
        by_ident.setdefault((s[0], s[1], s[3]), []).append(k)
        for c in legacy_colids(s[3]):
            by_legacy.setdefault((s[0], s[1], c), []).append(k)
    return {"keys": set(known_keys), "ident": by_ident, "legacy": by_legacy}


def resolve_key(key, known_keys, index=None):
    """The key of this build that a logged key stands for, or None. In order:
      - the key itself, when the build has it
      - a renumbered row: the one known key with the same dir, ProjectID and colid (only the sheet row differs; a row inserted above the pipeline moved it)
      - a legacy fill: the one multi-column fill key with the same dir and ProjectID that names this key's single column (a fill logged before 2026-10-01)
    None when nothing matches, or when the first rule that matches finds more than one key (a multi-row ProjectID): a guess would put a call on the wrong line. `index` is key_index(known_keys), passed to save rebuilding it per call."""
    ix = index or key_index(known_keys)
    if key in ix["keys"]:
        return key
    s = parse_key(key)
    if not s:
        return None
    ident = (s[0], s[1], s[3])
    cands = ix["ident"].get(ident) or ix["legacy"].get(ident) or []
    return cands[0] if len(cands) == 1 else None


# ---- concern helpers (pure functions of the dataset) --------------------------------

def open_concerns(pipeline):
    """Validity concerns on this pipeline with a contested map and no call yet."""
    return [it for it in pipeline.get("items", [])
            if it.get("kind") == "concern" and not it.get("call") and isinstance(it.get("contested"), dict)]


def contested_cols(pipeline):
    """Columns named by an open validity concern on this pipeline."""
    cols = set()
    for it in open_concerns(pipeline):
        cols.update(it["contested"])
    return cols


def line_cols(line):
    """Columns a line touches: its column, its value columns, and Status for a status line."""
    cols = {line.get("column")} | set(line.get("value_cols") or [])
    if line.get("kind") == "status":
        cols.add("Status")
    return {c for c in cols if c}


def proposed_on(line, col):
    """The value the line proposes on `col`, stripped ("" when it proposes nothing there)."""
    pv = line.get("proposed_values") or {}
    v = pv.get(col)
    if (v is None or str(v).strip() == "") and col == "Status" and line.get("kind") == "status":
        v = line.get("proposed_status")
    return "" if v is None else str(v).strip()


def resolves(line, concern):
    """Sorted contested columns of `concern` on which the line is the resolution: the contested value is not empty and equals the line's proposed value there."""
    cont = concern.get("contested") or {}
    return sorted(c for c in line_cols(line) & set(cont)
                  if str(cont[c]).strip() and str(cont[c]).strip() == proposed_on(line, c))


def rival_of(line, concern_key):
    """The line's rival entry for `concern_key` that carries a different candidate value, or None."""
    for rv in line.get("rivals") or []:
        if rv.get("key") == concern_key and rv.get("cols"):
            return rv
    return None


def cover_records(line, rec):
    """The same call on every record the line covers, each in its own dir, carrying `via` (the line's key)."""
    return [dict(rec, key=c["key"], dir=c["dir"], sheet_row=c.get("sheet_row"),
                 ref_col=c.get("ref_col") or "", kind=c["kind"], via=rec["key"])
            for c in line.get("covers") or []]


# ---- hooks --------------------------------------------------------------------------

def record_fields(card, obj, group):
    """A line record names its pipeline, sheet row and reference column; an item record adds nothing."""
    if group != "lines":
        return {}
    return {"pid": obj.get("pid") or card["pid"], "sheet_row": obj.get("sheet_row"),
            "ref_col": obj.get("ref_col") or obj.get("column") or ""}


def line_request(api, i, r, line, card):
    """A rival request takes a concern's candidate value instead of the proposal. It is stored as a suggest whose suggested_value is the candidate. The refusals come in the pipelines order: a decision that is not one of the four is refused by the core first, then a rival with no candidate, then a rival with any decision but suggest."""
    if r.get("undo") or r.get("undecided"):
        return r
    rival = str(r.get("rival") or "")
    if not rival:
        return r
    decision = r.get("decision") or "suggest"
    if decision not in api.CONFIG.decisions:
        return r
    r = dict(r)
    rv = rival_of(line, rival)
    if rv is None:
        raise Invalid(f"record {i}: {rival!r} is not a concern with a candidate value on {r.get('key')!r}")
    if decision != "suggest":
        raise Invalid(f"record {i}: taking a concern's candidate is recorded as suggest, not {decision}")
    r["decision"] = "suggest"
    r["suggested_value"] = str(r.get("suggested_value") or "").strip() or rv["value"]
    return r


def line_record(api, i, r, line, card, rec):
    """The line record carries the backend cells it was decided against (`basis`) and its rival, then one record per covered record."""
    if line.get("basis"):
        rec["basis"] = line["basis"]
    rival = "" if rec["undecided"] else str(r.get("rival") or "")
    if rival:
        rec["rival"] = rival
    return [rec] + cover_records(line, rec)


def concern_calls(api, recs, data):
    """The item calls a batch of line records owes: an accept that resolves an open concern dismisses it; a rival suggest confirms the concern unless it is already confirmed. A confirmation wins over a dismissal of the same concern in one request."""
    idx = api.index(data)
    calls = {}
    for r in recs:
        if r["undecided"] or r.get("via"):
            continue
        pipe, line, _ = idx[r["key"]]
        if r["decision"] == "accept":
            for c in open_concerns(pipe):
                cols = resolves(line, c)
                if not cols:
                    continue
                cur = calls.get(c["key"])
                if cur and cur["call"] == "confirmed":
                    continue
                have = cur["cols"] if cur else []
                calls[c["key"]] = {"call": "dismissed", "cols": have + [x for x in cols if x not in have]}
        elif r["decision"] == "suggest" and r.get("rival"):
            rv = rival_of(line, r["rival"])
            _, concern, _ = idx[r["rival"]]
            if concern.get("call") == "confirmed":
                continue
            calls[r["rival"]] = {"call": "confirmed", "cols": list(rv["cols"])}
    return [{"key": k, "call": v["call"],
             "note": ("resolved by accepted " if v["call"] == "dismissed" else "candidate accepted on ")
                     + ", ".join(v["cols"]) + (" fill" if v["call"] == "dismissed" else "")}
            for k, v in calls.items()]


def overlay_extras(api, data, speak):
    """Lines also get `applied` ({by, at} of the latest machine record), `rival`, and, on a line that covers other records, each cover's own decision plus `uncovered` (the covers whose record says something else)."""
    for p in api.cards(data):
        for o in p.get("lines", []):
            rec, mrec = speak(o.get("dir"), o["key"])
            live = rec if rec and not rec.get("undecided") else None
            # no machine record: a route line keeps what review_data detected (route_state.py: in the routes repo, sheet mapped)
            o["applied"] = {"by": mrec.get("reviewer"), "at": mrec.get("ts")} if mrec else o.get("detected_applied")
            o["rival"] = (live.get("rival") or None) if live and live.get("decision") == "suggest" else None
            if o.get("covers"):
                for c in o["covers"]:
                    crec, _ = speak(c.get("dir"), c["key"])
                    clive = crec if crec and not crec.get("undecided") else None
                    c["decision"] = clive["decision"] if clive else None
                    c["decided_by"] = clive.get("reviewer") if clive else None
                    c["decided_at"] = clive.get("ts") if clive else None
                o["uncovered"] = [c["key"] for c in o["covers"] if c["decision"] != o["decision"]]


def index_entry(obj, group, e):
    """The fields one line carries in the page index: b basis, r sheet row, c reference column, d default ("hold" when the line has none) and v covers. Concern answers (x) need the whole pipeline: index_extras adds them."""
    if group != "lines":
        return e
    e["b"] = obj.get("basis") or ""
    if obj.get("sheet_row") is not None:
        e["r"] = obj["sheet_row"]
    if obj.get("ref_col") or obj.get("column"):
        e["c"] = obj.get("ref_col") or obj.get("column")
    if not obj.get("default"):
        e["d"] = "hold"
    if obj.get("covers"):
        e["v"] = [[x["key"], x.get("sheet_row"), x.get("ref_col") or "", x["kind"]] for x in obj["covers"]]
    return e


OO_TAB = "operators_owners"     # the owners and operators tab, as review_data names it


def make_watch(data, cards):
    """The backend cells each line was judged against, for the live drift check: {"tracker"|"oo": [[pid, sheet_row, {column: value}]]}, one entry per (tab, pid, row). The columns are the ones `basis` hashes (the value columns, the reference column, Status, RouteAccuracy) with the values the line shows."""
    seen = {}
    for p in cards:
        for l in p.get("lines", []):
            if l.get("kind") == "new_row" or l.get("sheet_row") is None:
                continue
            tab = "oo" if l.get("tab") == OO_TAB else "tracker"
            cells = {c: str(v if v is not None else "") for c, v in (l.get("current") or {}).items()}
            if l.get("ref_col"):
                cells[l["ref_col"]] = str(l.get("current_ref") or "")
            if "current_status" in l:
                cells["Status"] = str(l.get("current_status") or "")
            if "current_route_accuracy" in l:
                cells["RouteAccuracy"] = str(l.get("current_route_accuracy") or "")
            seen.setdefault((tab, l.get("pid") or p["pid"], l["sheet_row"]), {}).update(cells)
    out = {"tracker": [], "oo": []}
    for (tab, pid, row), cells in seen.items():
        out[tab].append([pid, row, cells])
    return out


def index_extras(data, index):
    """Per line, x: the answers to every concern on its pipeline, [[concern key, columns an accept resolves, the candidate a rival suggest takes ("" when none differs), the columns that candidate covers]], left out when there are none. At the top, w (make_watch) and cmd (the commodity)."""
    cards = data.get("pipelines") or data.get("cards") or []
    where = {d: i for i, d in enumerate(index["dirs"])}
    for p in cards:
        concerns = [it for it in p.get("items", [])
                    if it.get("kind") == "concern" and isinstance(it.get("contested"), dict)]
        if not concerns:
            continue
        for l in p.get("lines", []):
            xs = []
            for c in concerns:
                res = resolves(l, c)
                rv = rival_of(l, c["key"])
                cand = rv["value"] if rv else ""
                if res or cand:
                    xs.append([c["key"], res, cand, sorted(rv["cols"]) if rv else []])
            if xs:
                d = l.get("dir") or p.get("dir")
                index["keys"][where[d]][l["key"][len(d) + 2:]]["x"] = xs
    index["w"] = make_watch(data, cards)
    index["cmd"] = (data.get("scope") or {}).get("commodity", "") or ""
    return index


def exports(api):
    """Names the pipelines store has always exported beyond the core ones."""
    def sync_backend(data, dirs, snapshot="", sink=None):
        """After a fresh pull and rebuild: every line the snapshot already holds (`in_backend`) that no person has decided gets a `backend sync` accept record. Lines that already carry a live record are left alone. Returns the records written."""
        note = f"already in backend after refresh {snapshot}".rstrip()
        logs, recs = {}, []
        with api._LOCK:
            for p in api.cards(data):
                for line in p.get("lines", []):
                    if not line.get("in_backend"):
                        continue
                    d = line.get("dir")
                    if d not in logs:
                        logs[d] = api.latest(api.read_log(dirs[d])) if d in dirs else {}
                    rec = logs[d].get(line["key"])
                    if rec and not rec.get("undecided"):
                        continue
                    mine = {"key": line["key"], "dir": d, "pid": line.get("pid") or p["pid"],
                            "sheet_row": line.get("sheet_row"),
                            "ref_col": line.get("ref_col") or line.get("column") or "", "kind": line["kind"],
                            "decision": "accept", "suggested_value": "", "note": note,
                            "reviewer": SYNC_REVIEWER, "ts": None, "undecided": False}
                    recs.append(mine)
                    for c in cover_records(line, mine):
                        if c["dir"] not in logs:
                            logs[c["dir"]] = api.latest(api.read_log(dirs[c["dir"]])) if c["dir"] in dirs else {}
                        crec = logs[c["dir"]].get(c["key"])
                        if not (crec and not crec.get("undecided")):
                            recs.append(c)
            return (sink or api._write)(recs, dirs) if recs else []

    return {"SYNC_REVIEWER": SYNC_REVIEWER, "CONCERN_CALLS": CONCERN_CALLS, "sync_backend": sync_backend,
            "open_concerns": open_concerns, "contested_cols": contested_cols, "line_cols": line_cols,
            "proposed_on": proposed_on, "resolves": resolves, "rival_of": rival_of,
            "cover_records": cover_records, "concern_calls": lambda recs, data: concern_calls(api, recs, data)}


def dynamic_caps(app):
    """Refresh works only when the server built its dataset; push only with a decision store."""
    return {"refresh": bool(getattr(app, "build_argv", None)), "push": app.ledger is not None}


def routes(app):
    """/geo/<path> serves route geometry under batches/. Refresh and push call methods the pipelines App subclass provides (they run repo code)."""
    def need(name):
        fn = getattr(app, name, None)
        if fn is None:
            raise Refusal(409, f"this server cannot {name.replace('_', ' ')}")
        return fn

    def geo(h):
        base = getattr(app, "batches_root", None) or Path(app.root) / "batches"
        rel = unquote(h.path.split("?", 1)[0])[len("/geo/"):]
        h.serve_file(base, rel, {".geojson", ".json"})

    def refresh(h):
        fn = need("refresh")
        try:
            return fn()
        except Refusal:
            raise
        except (Exception, SystemExit) as e:      # a failed rebuild exits; say so instead of dying
            print(f"review app: refresh failed: {e!r}", file=sys.stderr)
            raise Refusal(500, f"refresh failed: {e}")

    def guarded(fn):
        try:
            return fn()
        except Refusal:
            raise
        except Exception as e:
            print(f"review app: push failed: {e!r}", file=sys.stderr)
            raise Refusal(500, f"push failed: {e}")

    def push_plan(h):
        return guarded(need("push_plan"))

    def push(h):
        fn = need("push_apply")
        try:
            body = h.body() or {}
        except (ValueError, UnicodeDecodeError):
            raise Refusal(400, "body is not JSON")
        return guarded(lambda: fn(str(body.get("token") or "")))

    return [("GET", "/geo/", geo), ("POST", "/api/refresh", refresh),
            ("POST", "/api/push/plan", push_plan), ("POST", "/api/push", push)]


CONFIG = TrackerConfig(
    name="pipelines",
    title="pipelines reviewer",
    cards_key="pipelines",
    line_kinds=LINE_KINDS,
    item_kinds=ITEM_KINDS,
    item_calls={"concern": CONCERN_CALLS},
    other_calls=OTHER_CALLS,
    machine_reviewers=set(MACHINE_REVIEWERS),
    info_kinds=set(INFO_KINDS),
    references=False,
    record_fields=record_fields,
    legacy_keys=legacy_keys,
    line_request=line_request,
    line_record=line_record,
    decide_extras=concern_calls,
    overlay_extras=overlay_extras,
    index_entry=index_entry,
    index_extras=index_extras,
    exports=exports,
    routes=routes,
    caps={"decide": True, "refresh": False, "push": False},
    dynamic_caps=dynamic_caps,
    web_dir=Path(__file__).resolve().parent / "web",
    port=8766,
)
