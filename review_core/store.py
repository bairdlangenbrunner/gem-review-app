"""
The shared decision store for every GEM review app.

Each staging dir holds two sidecars, committed with the batch:

    review_log.jsonl        append-only truth: every decision and every undo, one record per line
    review_decisions.json   derived: {"generated": ts, "decisions": {key: latest record}}

A line decision record is {key, dir, pid, <tracker fields>, kind, decision, suggested_value, reference (when the tracker takes references), note, reviewer, ts, undecided}. An item call record is {key, dir, pid, <tracker fields>, kind, call, reference, note, reviewer, ts, undecided}. A marker record (a flag that sits beside a decision, see config.py) is {key: prefix + line or item key, ..., <marker name>: value, on, note}. The latest record per key wins, latest by ts: the log is replayed in time order (in_time_order), so a record imported later with an earlier ts does not speak over a newer one, and the single-file page, which merges records from several places, agrees. An undo is a record with `undecided: true`; nothing is ever deleted from the log. A person is recorded by initials. A machine reviewer (config.machine_reviewers, such as "push" or "backend sync") is kept verbatim, and its records never count as a person's call: a person's live call keeps speaking for the line and the machine record shows as `applied` only where a tracker asks for it.

`bind(config, root)` returns the store API bound to one tracker as a plain dict, so a tracker's shim can do `globals().update(bind(CONFIG, ROOT))` and keep every name its callers import. A shim that passes `into=` its own module gets the names put straight into it, and the writes look up `atomic_write`, `append_jsonl`, `write_derived` and `rollback` when they run: the one on the shim when a test replaced it there, else this module's (which the core tests replace). Records that came through the ledger also carry id, scope, batch, snapshot and origin; nothing here depends on them.

The rules the single-file page has to apply the same way (the request limits, the initials and address patterns, how line kinds and undo references are checked) are in page_rules(). TrackerConfig.page_block() hands them to review_core/web/static_store.js.

Nothing here touches a tracker database, a live sheet or the staged files.
"""
import json
import os
import re
import threading
from datetime import datetime
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
LOG_NAME = "review_log.jsonl"
DERIVED_NAME = "review_decisions.json"
# A person is recorded by their first and last initials, never their full name: "Baird
# Langenbrunner" and baird.langenbrunner@globalenergymonitor.org both record as "BL".
_INITIALS_RE = re.compile(r"^[A-Z]{1,3}$")
_EMAIL_RE = re.compile(r"^([^@\s]+)@[^@\s]+\.[^@\s]+$")
_URL_RE = re.compile(r"^https?://\S+$")
_EMAIL_SPLIT = r"[._+\-]+"      # an address's local part splits into name parts on these
_NAME_SPLIT = r"\s+"
MAX_RECORDS = 5000      # the most records one request may carry
MAX_TEXT = 5000         # the longest note or suggested value a record may carry, in characters
VIA_MAX = 300           # the longest "via" (how a call was made: single, linked, undo, bulk:<filters>)


class Invalid(ValueError):
    """A request the store refuses before writing anything (HTTP 400)."""


# ---- helpers that need no tracker ----------------------------------------------------

def read_jsonl(path):
    """Records of a JSONL file. A torn last line (a crash mid-append) is skipped, not fatal."""
    out = []
    path = Path(path)
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def read_log(d):
    return read_jsonl(Path(d) / LOG_NAME)


def _when(ts):
    """A ts as seconds since the epoch, or None when it is missing or does not parse."""
    try:
        return datetime.fromisoformat(str(ts)).timestamp()
    except (TypeError, ValueError):
        return None


def in_time_order(records):
    """The records oldest first by ts. Records with the same ts keep their log order. A record with no readable ts sorts with the record before it."""
    at, keyed = float("-inf"), []
    for r in records:
        t = _when(r.get("ts")) if isinstance(r, dict) else None
        if t is not None:
            at = t
        keyed.append((at, r))
    return [r for _, r in sorted(keyed, key=lambda x: x[0])]


def latest(records, field="key"):
    """Field value to the latest record carrying it, latest by ts (in_time_order)."""
    out = {}
    for r in in_time_order(records):
        if isinstance(r, dict) and r.get(field):
            out[r[field]] = r
    return out


def read_decisions(d):
    """Key to latest record for one staging dir, read from the log. The derived file is a
    convenience copy; the log is the truth."""
    return latest(read_log(d))


def now():
    return datetime.now(ET).isoformat(timespec="seconds")


def atomic_write(path, text):
    path = Path(path)
    tmp = path.with_name(f".{path.name}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def append_jsonl(path, records):
    """Append records. Returns the file's prior size so a failed step can roll it back."""
    path = Path(path)
    size = path.stat().st_size if path.exists() else 0
    with open(path, "a", encoding="utf-8", newline="") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return size


def rollback(path, size):
    path = Path(path)
    if size == 0:
        path.unlink(missing_ok=True)
    else:
        with open(path, "r+b") as f:
            f.truncate(size)


def write_derived(d, ts, write=None):
    """Regenerate <d>/review_decisions.json from the whole log (latest record per key). `write` is the atomic_write to use; the bound store passes the one in force when the write runs. Without it, this module's is used."""
    body = {"generated": ts, "decisions": latest(read_log(d))}
    (write or atomic_write)(Path(d) / DERIVED_NAME, json.dumps(body, indent=1, ensure_ascii=False) + "\n")


_WRITE_HELPERS = ("atomic_write", "append_jsonl", "write_derived", "rollback")


def page_rules():
    """The checks the single-file page makes the same way the store does, as plain JSON (TrackerConfig.page_block puts them in the page). The patterns are written so that JavaScript's RegExp reads them the same way."""
    return {"max_records": MAX_RECORDS, "max_text": MAX_TEXT,
            "initials": _INITIALS_RE.pattern, "email": _EMAIL_RE.pattern, "url": _URL_RE.pattern,
            "email_split": _EMAIL_SPLIT, "name_split": _NAME_SPLIT,
            # only a kind in line_kinds is a line, so an empty line_kinds refuses every line
            "listed_line_kinds_only": True,
            # an undo keeps the reference the request gave
            "undo_keeps_reference": True}


def cards(data, config):
    """The dataset's review cards: the tracker's own list (config.cards_key), else `cards`."""
    got = data.get(config.cards_key)
    if got is None:
        got = data.get("cards")
    return got or []


# ---- the bound API -------------------------------------------------------------------

def bind(config, root=None, into=None):
    """The store API for one tracker, as a dict of names. `root` is the folder relative dir
    labels resolve against (the researcher repo's root).

    `into` is the namespace the bound functions look their helpers up in, at call time: a shim
    passes its own module (`bind(CONFIG, ROOT, into=sys.modules[__name__])`) so that replacing
    `store.atomic_write` in a test reaches the writes. The names are put into it as well."""
    api = into if into is not None else SimpleNamespace()
    machines = set(config.machine_reviewers)
    item_calls = {k: config.calls_for(k) for k in config.item_kinds}
    lock = threading.Lock()      # one process-wide lock around every read-modify-write of a sidecar
    base_root = Path(root) if root else Path.cwd()
    legacy = config.legacy_keys or (lambda key: [])

    def is_machine(rec):
        return str((rec or {}).get("reviewer") or "") in machines

    def initials(who):
        """A person to their first and last initials, uppercased: "Baird Langenbrunner" gives
        "BL", and so does baird.langenbrunner@globalenergymonitor.org (the local part split on
        . _ - +). A one-part name or address gives its first letter. A machine reviewer, a value
        already in initials form and an empty value come back unchanged, so applying it twice
        changes nothing."""
        v = str(who or "").strip()
        if not v or v in machines or _INITIALS_RE.match(v):
            return who
        m = _EMAIL_RE.match(v)
        parts = [t for t in re.split(_EMAIL_SPLIT if m else _NAME_SPLIT, m.group(1) if m else v) if t[:1].isalpha()]
        if not parts:
            return who
        return (parts[0][0] + (parts[-1][0] if len(parts) > 1 else "")).upper()

    def reviewed(rec):
        """True when the record is a person's live call: not a machine's, not an undo."""
        return bool(rec) and not is_machine(rec) and not rec.get("undecided")

    def calls(records):
        """Key to {"person": the latest person record (an undo included), "machine": the latest
        machine record, "last": the latest record of either}, replayed in time order."""
        out = {}
        for r in in_time_order(records):
            k = r.get("key")
            if not k:
                continue
            c = out.setdefault(k, {"person": None, "machine": None, "last": None})
            c["machine" if is_machine(r) else "person"] = r
            c["last"] = r
        return out

    def speaker(calls_by_key, key):
        """(the record that speaks for `key`, its latest machine record). A person's live call
        speaks first: the key's own or, when the key has no person record at all, the one older
        key (config.legacy_keys) that holds a live one. Otherwise the latest record of any kind
        speaks: an undo, or a machine record."""
        c = calls_by_key.get(key) or {}
        prec = c.get("person")
        if prec is None:
            leg = [calls_by_key[k]["person"] for k in legacy(key)
                   if calls_by_key.get(k, {}).get("person") and not calls_by_key[k]["person"].get("undecided")]
            if len(leg) == 1:
                prec = leg[0]
        live = prec if prec and not prec.get("undecided") else None
        return (live or c.get("last")), c.get("machine")

    def dir_paths(data, root=None):
        """{dir label: Path}. Labels are relative to the repo root, or absolute."""
        b = Path(root) if root else api.ROOT
        return {d: b / d for d in data.get("dirs", [])}

    def index(data):
        """Key to (card, object, group) for every line and item."""
        out = {}
        for p in cards(data, config):
            for grp in ("lines", "items"):
                for o in p.get(grp, []):
                    out[o["key"]] = (p, o, grp)
        return out

    def fields(card, obj, grp):
        return dict(config.record_fields(card, obj, grp)) if config.record_fields else {}

    def marker_key(name, label, pid):
        m = config.markers[name]
        return f"{m['prefix']}{label}::{m.get('card_tag', 'card')}:{pid}"

    def overlay(data, dirs=None, root=None):
        """Lay each dir's review_log.jsonl over `data` in place and return it.

        Lines get `decision`, `reviewed`, `decided_by`, `decided_at`, `decision_note` (a person's
        note on a live call), and `suggested_value` (plus `reference` when the tracker takes
        references) on a suggest. Items get `call`, `call_note`, `reviewed`, `decided_by`,
        `decided_at` (plus `call_reference`). `decision` and `call` are None after an undo or with
        no record. Each marker fills <field>_flag, <field>_note and <field>_by on lines and items
        and <field>_flag, <field>_note on cards. Then the tracker's overlay_extras runs."""
        dirs = dirs if dirs is not None else dir_paths(data, root)
        logs = {}

        def speak(d, key):
            if d not in logs:
                logs[d] = calls(read_log(dirs[d])) if d in dirs else {}
            return speaker(logs[d], key)

        def marked(d, key):
            rec, _ = speak(d, key)
            return rec if reviewed(rec) and rec.get("on") else None

        for p in cards(data, config):
            for grp in ("lines", "items"):
                for o in p.get(grp, []):
                    rec, _ = speak(o.get("dir"), o["key"])
                    live = rec if rec and not rec.get("undecided") else None
                    if grp == "lines":
                        sug = bool(live) and live.get("decision") == "suggest"
                        o["decision"] = live.get("decision") if live else None
                        o["suggested_value"] = live.get("suggested_value", "") if sug else ""
                        if config.references:
                            o["reference"] = live.get("reference", "") if sug else ""
                        o["decision_note"] = live.get("note", "") if live and reviewed(rec) else ""
                    else:
                        o["call"] = live.get("call") if live else None
                        o["call_note"] = live.get("note", "") if live else None
                        if config.references:
                            o["call_reference"] = live.get("reference", "") if live else ""
                    o["reviewed"] = reviewed(rec)
                    o["decided_by"] = rec.get("reviewer") if live else None
                    o["decided_at"] = rec.get("ts") if live else None
                    for m in config.markers.values():
                        hit = marked(o.get("dir"), m["prefix"] + o["key"])
                        o[m["field"] + "_flag"] = bool(hit)
                        o[m["field"] + "_note"] = hit.get("note", "") if hit else ""
                        o[m["field"] + "_by"] = hit.get("reviewer") if hit else None
            for name, m in config.markers.items():
                hit = marked(p.get("dir"), marker_key(name, p.get("dir"), p["pid"]))
                p[m["field"] + "_flag"] = bool(hit)
                p[m["field"] + "_note"] = hit.get("note", "") if hit else ""
        if config.overlay_extras:
            config.overlay_extras(api, data, speak)
        return data

    # ---- validation --------------------------------------------------------------

    def check_list(records, what):
        if not isinstance(records, list) or not records:
            raise Invalid(f"expected a non-empty list of {what} records")
        if len(records) > MAX_RECORDS:
            raise Invalid(f"too many records in one request ({len(records)})")

    def text(i, v, what):
        s = str(v or "")
        if len(s) > MAX_TEXT:
            raise Invalid(f"record {i}: the {what} is longer than {MAX_TEXT} characters")
        return s

    def check_ref(i, ref):
        if ref and not _URL_RE.match(ref):
            raise Invalid(f"record {i}: reference {ref!r} is not a web address (http or https)")

    def validate(records, data, reviewer=None):
        """Normalized decision records (ts is stamped later), or Invalid; nothing is written for
        a bad request. A request is {key, decision, suggested_value?, reference?, note?} or
        {key, undo: true}; an undo is stored as undecided: true and keeps the line's default
        decision."""
        check_list(records, "decision")
        idx = index(data)
        out = []
        for i, r in enumerate(records):
            if not isinstance(r, dict):
                raise Invalid(f"record {i}: not an object")
            key = r.get("key")
            if key not in idx:
                raise Invalid(f"record {i}: unknown key {key!r}")
            card, obj, grp = idx[key]
            if grp != "lines" or obj.get("kind") not in config.line_kinds:
                raise Invalid(f"record {i}: {key!r} is an item, not a line (use /api/item)")
            if config.line_request:
                r = config.line_request(api, i, r, obj, card)
            undo = bool(r.get("undo") or r.get("undecided"))
            decision = r.get("decision")
            if undo and not decision:
                decision = obj.get("default") or "hold"      # an undo record still carries a decision field
            if not undo and not decision:
                raise Invalid(f"record {i}: no decision given (a bare key never defaults to accept)")
            if decision not in config.decisions:
                raise Invalid(f"record {i}: decision {decision!r} is not one of {', '.join(sorted(config.decisions))}")
            note = text(i, r.get("note"), "note")
            sv = text(i, r.get("suggested_value"), "suggested value")
            if decision == "suggest" and not undo and not (sv.strip() or note.strip()):
                raise Invalid(f"record {i}: a suggestion needs a suggested_value or a note")
            rec = {"key": key, "dir": obj["dir"], "pid": card["pid"]}
            rec.update(fields(card, obj, "lines"))
            rec.update({"kind": obj["kind"], "decision": decision, "suggested_value": sv})
            if config.references:
                ref = str(r.get("reference") or "").strip()
                check_ref(i, ref)
                rec["reference"] = ref
            rec.update({"note": note, "reviewer": reviewer, "ts": None, "undecided": undo})
            via = r.get("via")
            if via is not None:          # how the call was made: "single", "linked", "undo", "bulk:<filters>"
                if not isinstance(via, str) or len(via) > VIA_MAX:
                    raise Invalid(f"record {i}: via must be text of at most {VIA_MAX} characters")
                if via:
                    rec["via"] = via
            out.extend(config.line_record(api, i, r, obj, card, rec) if config.line_record else [rec])
        return out

    def validate_items(records, data, reviewer=None):
        """Normalized item call records, or Invalid. A request is {key, call, reference?, note?}
        or {key, undo: true}. The call must be in the vocabulary for the item's kind, and a
        (kind, call) pair in config.note_required needs a note."""
        check_list(records, "item")
        idx = index(data)
        out = []
        for i, r in enumerate(records):
            if not isinstance(r, dict):
                raise Invalid(f"record {i}: not an object")
            key = r.get("key")
            if key not in idx:
                raise Invalid(f"record {i}: unknown key {key!r}")
            card, obj, grp = idx[key]
            if grp != "items":
                raise Invalid(f"record {i}: {key!r} is a line, not an item (use /api/decide)")
            undo = bool(r.get("undo") or r.get("undecided"))
            call = "" if undo else str(r.get("call") or "")
            vocab = config.calls_for(obj.get("kind"))
            if not undo and call not in vocab:
                raise Invalid(f"record {i}: call {call!r} is not one of {', '.join(vocab)} for a {obj.get('kind')} item")
            note = text(i, r.get("note"), "note")
            if not undo and (obj.get("kind"), call) in config.note_required and not note.strip():
                raise Invalid(f"record {i}: {call.replace('_', ' ')} needs a note saying why")
            rec = {"key": key, "dir": obj["dir"], "pid": card["pid"]}
            rec.update(fields(card, obj, "items"))
            rec.update({"kind": obj["kind"], "call": call})
            if config.references:
                ref = str(r.get("reference") or "").strip()
                check_ref(i, ref)
                rec["reference"] = ref
            rec.update({"note": note, "reviewer": reviewer, "ts": None, "undecided": undo})
            out.append(rec)
        return out

    def marker_validator(name):
        m = config.markers[name]

        def validate_marker(records, data, reviewer=None):
            """Normalized marker records, or Invalid. A request is {key, on, note?} for a line or
            item, or {pid, dir, on, note?} for a whole card. The stored key carries the marker's
            prefix, so a marker never collides with the decision on the same record."""
            check_list(records, name)
            idx = index(data)
            by_card = {(p.get("dir"), p["pid"]): p for p in cards(data, config)}
            out = []
            for i, r in enumerate(records):
                if not isinstance(r, dict):
                    raise Invalid(f"record {i}: not an object")
                on = bool(r.get("on", True))
                note = text(i, r.get("note"), "note")
                key = r.get("key")
                if key:
                    if key not in idx:
                        raise Invalid(f"record {i}: unknown key {key!r}")
                    card, obj, grp = idx[key]
                    out.append({"key": m["prefix"] + key, "dir": obj["dir"], "pid": card["pid"],
                                "record_id": obj.get("record_id"), "kind": obj.get("kind"), name: m["value"], "on": on,
                                "note": note, "reviewer": reviewer, "ts": None, "undecided": False})
                    continue
                pid, label = r.get("pid"), r.get("dir")
                card = by_card.get((label, pid)) or next((p for p in by_card.values() if p["pid"] == pid), None)
                if card is None:
                    raise Invalid(f"record {i}: unknown {m.get('card_tag', 'card')} {pid!r}")
                out.append({"key": marker_key(name, card["dir"], card["pid"]), "dir": card["dir"], "pid": card["pid"],
                            "record_id": None, "kind": m.get("card_tag", "card"), name: m["value"], "on": on,
                            "note": note, "reviewer": reviewer, "ts": None, "undecided": False})
            return out
        return validate_marker

    # ---- writing -----------------------------------------------------------------

    installed = {n: globals()[n] for n in _WRITE_HELPERS}     # as bind puts them in the namespace

    def helper(name):
        """The write helper in force now: the namespace's when a test replaced it there, else this
        module's (which a test may have replaced too). The real write_derived comes back set to
        write through the atomic_write in force."""
        f = getattr(api, name, None)
        if f is None or f is installed[name]:
            f = globals()[name]
        if f is installed["write_derived"]:
            return partial(f, write=helper("atomic_write"))
        return f

    def _write(recs, dirs, stamp=True):
        """Per touched dir (the caller holds _LOCK): append to review_log.jsonl and regenerate
        review_decisions.json atomically. On failure every touched log is rolled back to its
        previous length. ts is stamped here; `stamp=False` keeps the ts each record already has
        (records mirrored from the Google store). Returns recs."""
        ts = now()
        by_dir = {}
        for r in recs:
            if stamp:
                r["ts"] = ts
            if r["dir"] not in dirs:
                raise Invalid(f"staging dir not known to the server: {r['dir']}")
            by_dir.setdefault(r["dir"], []).append(r)
        done = []          # (dir, log path, prior size) of dirs touched so far, for a multi-dir rollback
        try:
            for label, rs in by_dir.items():
                log = Path(dirs[label]) / LOG_NAME
                size = helper("append_jsonl")(log, rs)
                done.append((dirs[label], log, size))
                helper("write_derived")(dirs[label], ts)
        except Exception:
            for d, log, size in done:
                helper("rollback")(log, size)
            for d, log, size in done[:-1]:      # dirs whose derived file already moved: re-derive
                try:
                    helper("write_derived")(d, ts)
                except Exception:
                    pass
            raise
        return recs

    def decide(records, data, reviewer, dirs=None, root=None, sink=None):
        """Validate, then write under the process lock to each touched dir's sidecars. Returns the
        records written (with reviewer and ts): the line records, then any item calls the tracker
        says they owe (config.decide_extras; never for a machine reviewer).

        `sink(recs, dirs)` replaces the write: the ledger's sink appends to the Google decision
        store first and then to the sidecars. A sink runs under _LOCK, so it calls _write, never
        append_records."""
        reviewer = initials(reviewer)
        dirs = dirs if dirs is not None else dir_paths(data, root)
        with lock:
            recs = validate(records, data, reviewer)
            items = []
            if config.decide_extras and not is_machine({"reviewer": reviewer}):
                owed = config.decide_extras(api, recs, data)
                items = validate_items(owed, data, reviewer) if owed else []
            return (sink or _write)(recs + items, dirs)

    def append_records(recs, dirs, sink=None):
        """Append records that were already decided elsewhere (the Google store, or a single-file
        page's download) exactly as given: reviewer, ts and every extra field are kept, nothing is
        validated against a dataset or re-stamped. A record whose dir is not in `dirs` is refused
        (Invalid) and nothing is written."""
        with lock:
            return (sink or _write)(list(recs), dirs, stamp=False) if recs else []

    def record_items(records, data, reviewer, dirs=None, root=None, sink=None):
        """Item calls into the same review_log.jsonl as line decisions (an item key and a line key
        never coincide). Returns the records written. `sink` as in decide."""
        reviewer = initials(reviewer)
        dirs = dirs if dirs is not None else dir_paths(data, root)
        with lock:
            return (sink or _write)(validate_items(records, data, reviewer), dirs)

    def recorder(validator):
        def record(records, data, reviewer, dirs=None, root=None, sink=None):
            """Records of a tracker record type into the same log. Returns the records written."""
            reviewer = initials(reviewer)
            dirs = dirs if dirs is not None else dir_paths(data, root)
            with lock:
                return (sink or _write)(validator(records, data, reviewer), dirs)
        return record

    names = dict(
        CONFIG=config, ROOT=base_root, ET=ET, LOG_NAME=LOG_NAME, DERIVED_NAME=DERIVED_NAME,
        DECISIONS=set(config.decisions), LINE_KINDS=tuple(config.line_kinds), ITEM_KINDS=tuple(config.item_kinds),
        ITEM_CALLS=item_calls, OTHER_CALLS=tuple(config.other_calls), NOTE_REQUIRED=set(config.note_required),
        MACHINE_REVIEWERS=machines, INFO_KINDS=set(config.info_kinds),
        _INITIALS_RE=_INITIALS_RE, _EMAIL_RE=_EMAIL_RE, _URL_RE=_URL_RE, _LOCK=lock, Invalid=Invalid,
        is_machine=is_machine, initials=initials, reviewed=reviewed, calls=calls, speaker=speaker,
        legacy_keys=legacy, read_jsonl=read_jsonl, read_log=read_log, latest=latest, read_decisions=read_decisions,
        dir_paths=dir_paths, index=index, overlay=overlay, now=now, validate=validate, validate_items=validate_items,
        in_time_order=in_time_order, page_rules=page_rules, MAX_RECORDS=MAX_RECORDS, MAX_TEXT=MAX_TEXT, **installed,
        _write=_write, decide=decide, append_records=append_records, record_items=record_items,
        cards=lambda data: cards(data, config), marker_key=marker_key,
    )
    record_types = {name: marker_validator(name) for name in config.markers}
    for name, fn in config.extra_record_types.items():
        record_types[name] = (lambda f: lambda records, data, reviewer=None: f(api, records, data, reviewer))(fn)
    for name, validator in record_types.items():
        names[f"validate_{name}s"] = validator
        names[f"record_{name}s"] = recorder(validator)
    names["RECORD_TYPES"] = dict(record_types)
    vars(api).update(names)
    if config.exports:
        extra = config.exports(api)
        vars(api).update(extra)
        names.update(extra)
    return names
