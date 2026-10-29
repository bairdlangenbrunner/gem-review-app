"""
The LNG carriers review config. lng-carriers-researcher binds it through its review_app shims (core_store.py, server.py, build_static.py), the same way gogpt-researcher binds trackers/gogpt.

A card is a vessel: one backend row (pid = the row's UUID), or one discovery cluster with no row yet (pid = "c:<batch>:<cluster_id>"). One more card ("items") holds the items no vessel card claims. A line is one proposal of a batch (key `<batch>::<decisions.csv id>`); its kind is fill (a value with its [ref]), ref (a [ref] alone) or new_row (a discovery cluster's whole row).

A suggest is stricter than the core's: it needs a value AND a note, and carries suggest_kind (value: a different value; cosmetic: the same fact styled differently) and suggested_refs (the URLs that support it; push.py gates them before it writes). A new_row, ref or ref-only line takes no suggest.

Item kinds: a conflict (a conflicts.csv row: research against a non-blank backend value) is accepted, held or rejected, and the call goes into conflicts.csv `decision`; a conflict the backend already settles is marked resolved (conflicts.csv is left as it is). A discovery flag, a manual-review entry, a proposed-bucket row action and a possible duplicate are resolved or sent back for more research. An undo puts an item back to open.

Machine reviewers: "backend sync" (the sync button found the line already in the sheet) and "§5 regrade" (scripts/regrade_confidence.py). Their records never count as a person's call.

What stays repo code in lng-carriers-researcher: decisions.csv and conflicts.csv (the files apply_batch.py reads), review_items.jsonl (where item calls have always been logged), the backend sync, and the push plan and write (review_app/push.py). The repo's store writes those through a sink; the routes below call the sync and push through methods on the repo's App subclass and answer 409 when the subclass does not have them.
"""
import re
import sys
from pathlib import Path

from review_core.config import TrackerConfig
from review_core.server import Refusal
from review_core.store import Invalid

LINE_KINDS = ("fill", "ref", "new_row")
ITEM_KINDS = ("conflict", "flag", "manual", "proposed_bucket", "duplicate")
CONFLICT_CALLS = ("accept", "hold", "reject")       # the conflict calls written into conflicts.csv
OTHER_CALLS = ("resolved", "needs_research")
SUGGEST_KINDS = ("value", "cosmetic")
SYNC_REVIEWER = "backend sync"
REGRADE_REVIEWER = "§5 regrade"
MACHINE_REVIEWERS = {SYNC_REVIEWER, REGRADE_REVIEWER}
ITEMS_PID = "items"          # the card for items no vessel card claims
_URL = re.compile(r"https?://\S+$")


def suggestable(line):
    """A suggest replaces a value: not on a new row, a ref line or a ref-only line."""
    return line.get("kind") == "fill" and "ref_only" not in (line.get("flags") or [])


def suggested_refs(raw, i=0):
    """The refs typed with a suggestion (a list, or one string with a URL per line or comma) as a deduplicated list of http(s) URLs."""
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = re.split(r"[\s,]+", raw)
    if not isinstance(raw, list):
        raise Invalid(f"record {i}: suggested_refs must be a list of URLs")
    out = []
    for u in raw:
        u = str(u or "").strip()
        if not u:
            continue
        if not _URL.match(u):
            raise Invalid(f"record {i}: suggested ref {u!r} is not an http(s) URL")
        if u not in out:
            out.append(u)
    return out


# ---- hooks --------------------------------------------------------------------------

def record_fields(card, obj, group):
    """A line record names its decisions.csv id, column and backend row. A conflict's record names the conflicts.csv record its call goes in (its index, and the row_id and column that record must still hold); any other item record adds nothing."""
    if group == "lines":
        return {"record_id": obj.get("id"), "column": obj.get("column") or "", "row_id": obj.get("row_id") or ""}
    if obj.get("conflict_match"):
        return {"conflict_index": obj.get("conflict_index"), "conflict_match": list(obj["conflict_match"])}
    return {}


def line_request(api, i, r, line, card):
    """A suggest needs a value and a note, a known suggest_kind and URLs for refs; it is refused on a line that takes none."""
    if r.get("undo") or r.get("undecided") or r.get("decision") != "suggest":
        return r
    if not suggestable(line):
        raise Invalid(f"record {i}: nothing to suggest on a {line.get('kind')} line; accept, hold or reject it")
    kind = r.get("suggest_kind") or "value"
    if kind not in SUGGEST_KINDS:
        raise Invalid(f"record {i}: suggest_kind {kind!r} is not one of {', '.join(SUGGEST_KINDS)}")
    if not str(r.get("suggested_value") or "").strip():
        raise Invalid(f"record {i}: a suggestion needs a value")
    if not str(r.get("note") or "").strip():
        raise Invalid(f"record {i}: a suggestion needs a note")
    return dict(r, suggest_kind=kind, suggested_refs=suggested_refs(r.get("suggested_refs"), i))


def line_record(api, i, r, line, card, rec):
    """Every line record carries suggest_kind and suggested_refs, empty unless it is a suggest (the fields push.py and suggestions.py read)."""
    sug = rec["decision"] == "suggest" and not rec["undecided"]
    rec["suggest_kind"] = r.get("suggest_kind", "value") if sug else ""
    rec["suggested_refs"] = list(r.get("suggested_refs") or []) if sug else []
    return [rec]


def index_entry(obj, group, e):
    """The packed index carries the record fields, so the page's store writes the same records."""
    e["f"] = record_fields(None, obj, group)
    return e


def exports(api):
    return {"SUGGEST_KINDS": SUGGEST_KINDS, "CONFLICT_CALLS": CONFLICT_CALLS, "SYNC_REVIEWER": SYNC_REVIEWER,
            "ITEMS_PID": ITEMS_PID, "suggestable": suggestable, "suggested_refs": suggested_refs}


def dynamic_caps(app):
    """Sync and push work only on the loopback server that can pull the backend."""
    return {"refresh": callable(getattr(app, "refresh", None)), "push": callable(getattr(app, "push_apply", None))}


def routes(app):
    """Sync (POST /api/refresh), the push plan and the push call methods the LNG App subclass provides. The push writes the backend sheet: it runs only on a person's confirm in the page, with the token of the plan they saw."""
    def need(name):
        fn = getattr(app, name, None)
        if not callable(fn):
            raise Refusal(409, f"this server cannot {name.replace('_', ' ')}")
        return fn

    def body(h):
        try:
            return h.body() or {}
        except (ValueError, UnicodeDecodeError):
            raise Refusal(400, "body is not JSON")

    def guarded(what, fn):
        try:
            return fn()
        except Refusal:
            raise
        except (Exception, SystemExit) as e:
            print(f"review app: {what} failed: {e!r}", file=sys.stderr)
            raise Refusal(500, f"{what} failed: {e}")

    def refresh(h):
        return guarded("sync", need("refresh"))

    def push_plan(h):
        b = body(h)
        return guarded("push plan", lambda: need("push_plan")(b.get("batch") or None))

    def push(h):
        b = body(h)
        fn = need("push_apply")
        return guarded("push", lambda: fn(str(b.get("token") or ""), bool(b.get("include_applied")), b.get("batch") or None))

    return [("POST", "/api/refresh", refresh), ("POST", "/api/push/plan", push_plan), ("POST", "/api/push", push)]


CONFIG = TrackerConfig(
    name="lng",
    title="LNG carriers reviewer",
    cards_key="vessels",
    line_kinds=LINE_KINDS,
    item_kinds=ITEM_KINDS,
    item_calls={"conflict": CONFLICT_CALLS + ("resolved",)},
    other_calls=OTHER_CALLS,
    machine_reviewers=set(MACHINE_REVIEWERS),
    references=False,
    record_fields=record_fields,
    line_request=line_request,
    line_record=line_record,
    index_entry=index_entry,
    exports=exports,
    routes=routes,
    caps={"decide": True, "refresh": False, "push": False},
    dynamic_caps=dynamic_caps,
    web_dir=Path(__file__).resolve().parent / "web",
    port=8765,
)
