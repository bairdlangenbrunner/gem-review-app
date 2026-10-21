"""
The GOGPT review config: every decision is a call on one staged record (its stable `record_id`, written by the gogpt-researcher repo's scripts/assemble_state.py).

Line kinds: fill (a blank cell gets a value), change (a value is replaced), reverified (the current value was checked and stands, new Data Source link only), delete (a value is cleared), plant (a plant-level change applied to every unit row), new_row (a new unit or plant).

Item kinds and their calls: a concern (qa lane) is confirmed, dismissed or sent back for more research. A watch item (monitor lane) is added to the database, held, sent to the possible-updates sheet, or removed from the watchlist; removing needs a note saying why. Everything else is noted, todo or dismissed. Items never write a cell.

An ask-the-PM flag is a marker: {key: "pm::" + line or item key, or "pm::" + dir + "::plant:" + pid, flag: "pm", on, note}. It sits beside a decision and never replaces it, so one line can be accepted and flagged.

The watch-item vocabulary (WATCH_CALLS) is defined here. The gogpt-researcher repo's review_app/checklist.py imports it from this file, so this folder loads on its own.
"""
from pathlib import Path

from review_core.config import TrackerConfig

# `remove` makes assemble_state.py drop the candidate if a later sweep proposes it again.
WATCH_CALLS = ("add_to_database", "hold", "possible_updates", "remove")
LINE_KINDS = ("fill", "change", "reverified", "delete", "plant", "new_row")
ITEM_KINDS = ("concern", "monitor", "entity", "other")
CONCERN_CALLS = ("confirmed", "dismissed", "needs_research")
OTHER_CALLS = ("noted", "todo", "dismissed")
FLAG_PREFIX = "pm::"
FLAGS = ("pm",)


def record_fields(card, obj, group):
    """GOGPT records name the staged record, and a line record also names its column."""
    if group == "lines":
        return {"record_id": obj.get("record_id"), "column": obj.get("column") or ""}
    return {"record_id": obj.get("record_id")}


def index_entry(obj, group, entry):
    """The single-file page's packed index carries the same record fields."""
    entry["f"] = record_fields(None, obj, group)
    return entry


def exports(api):
    """Names the gogpt store shim has always exported beyond the core ones."""
    def plant_flag_key(label, pid):
        return api.marker_key("flag", label, pid)
    return {"CONCERN_CALLS": CONCERN_CALLS, "FLAG_PREFIX": FLAG_PREFIX, "FLAGS": FLAGS,
            "plant_flag_key": plant_flag_key}


CONFIG = TrackerConfig(
    name="gogpt",
    title="GOGPT reviewer",
    cards_key="plants",
    line_kinds=LINE_KINDS,
    item_kinds=ITEM_KINDS,
    item_calls={"concern": CONCERN_CALLS, "monitor": WATCH_CALLS},
    other_calls=OTHER_CALLS,
    note_required={("monitor", "remove")},
    machine_reviewers=set(),     # gogpt has no push and no backend sync, so no machine reviewer
    references=True,
    markers={"flag": {"prefix": FLAG_PREFIX, "value": FLAGS[0], "card_tag": "plant", "field": "pm"}},
    record_fields=record_fields,
    index_entry=index_entry,
    exports=exports,
    caps={"decide": True, "flag": True},   # flag: the ask-the-PM marker; the core derives no cap from a marker
    web_dir=Path(__file__).resolve().parent / "web",
    port=8767,
)
