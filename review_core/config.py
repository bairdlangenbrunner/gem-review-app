"""
TrackerConfig: everything the shared review core needs to know about one tracker.

The core never names a tracker. A researcher repo builds one TrackerConfig (trackers/<name>/config.py) and hands it to review_core.store.bind, review_core.server.App and review_core.build_static.render. Every field has a default, so a tracker sets only what it differs on.

Hook signatures (all optional; `api` is the bound store namespace from store.bind):

    record_fields(card, obj, group) -> dict
        Tracker fields copied from a card line or item onto the record a call writes
        (GOGPT: record_id and column; pipelines: pid, sheet_row and ref_col).
    legacy_keys(key) -> [older keys]
        Keys the same line was logged under before a key change. A person's live call on exactly
        one of them speaks for the line when the line has no record of its own.
    line_request(api, i, request, line, card) -> request
        Rewrites a line request before it is checked (pipelines: taking a concern's candidate).
    line_record(api, i, request, line, card, record) -> [records]
        The records one validated line request writes: the record itself plus any it owes
        (pipelines: the same call on every covered record).
    decide_extras(api, records, dataset) -> [item requests]
        Item calls a batch of person decisions owes, written in the same transaction
        (pipelines: concern calls answered by a line). Machine reviewers never owe any.
    overlay_extras(api, dataset, speak)
        Runs after the core overlay. `speak(dir, key)` returns (record that speaks, latest
        machine record) for any key.
    index_entry(line_or_item, group, entry) -> entry
        Extra packed-index fields for the single-file page (pipelines: sheet row, covers).
    index_extras(dataset, index) -> index
        Runs once on the whole packed index after every entry is made, for fields that need more
        than one line (pipelines: concern answers per line, watched cells, the commodity).
    exports(api) -> dict
        Extra names the tracker's store shim must keep exporting (GOGPT: FLAG_PREFIX, FLAGS,
        plant_flag_key; pipelines: SYNC_REVIEWER, sync_backend and the concern helpers).
    routes(app) -> [(method, path, handler)]
        Extra loopback routes. A path ending in "/" matches as a prefix. handler(request) returns
        a JSON-ready object, or None when it already sent its own response.
    dynamic_caps(app) -> dict
        Caps that depend on how the server was started (pipelines: refresh, push).

Markers (`markers`) are flag-style records that sit beside a decision without replacing it. Each one is {name: {"prefix", "value", "card_tag", "field"}}. The core turns each into a validator (validate_<name>s), a writer (record_<name>s), a POST /api/<name> route and an overlay that fills <field>_flag, <field>_note and <field>_by. The page store reads the same block, so both sides write identical records.
"""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from review_core.store import page_rules


DEFAULT_DECISIONS = ("accept", "hold", "reject", "suggest")
DEFAULT_OTHER_CALLS = ("noted", "todo", "dismissed")
DEFAULT_MACHINE_REVIEWERS = frozenset({"push", "backend sync"})


@dataclass
class TrackerConfig:
    name: str = "tracker"
    title: str = "GEM reviewer"
    cards_key: str = "cards"
    line_kinds: tuple = ()
    item_kinds: tuple = ()
    item_calls: dict = field(default_factory=dict)
    other_calls: tuple = DEFAULT_OTHER_CALLS
    decisions: tuple = DEFAULT_DECISIONS
    note_required: set = field(default_factory=set)
    machine_reviewers: set = field(default_factory=lambda: set(DEFAULT_MACHINE_REVIEWERS))
    info_kinds: set = field(default_factory=set)
    references: bool = True
    markers: dict = field(default_factory=dict)
    extra_record_types: dict = field(default_factory=dict)
    record_fields: Optional[Callable] = None
    legacy_keys: Optional[Callable] = None
    line_request: Optional[Callable] = None
    line_record: Optional[Callable] = None
    decide_extras: Optional[Callable] = None
    overlay_extras: Optional[Callable] = None
    index_entry: Optional[Callable] = None
    index_extras: Optional[Callable] = None
    exports: Optional[Callable] = None
    routes: Optional[Callable] = None
    caps: dict = field(default_factory=lambda: {"decide": True})
    dynamic_caps: Optional[Callable] = None
    web_dir: Optional[Path] = None
    port: int = 8767
    extra: dict = field(default_factory=dict)

    def calls_for(self, kind):
        """The call vocabulary for an item kind."""
        return tuple(self.item_calls.get(kind, self.other_calls))

    def page_block(self):
        """The tracker block the page's store reads (window.REVIEW_STATIC.tracker): only plain
        JSON values, no hooks. `rules` is store.page_rules(), the checks the page has to make the
        way the store makes them."""
        return {"name": self.name, "title": self.title, "cards_key": self.cards_key,
                "line_kinds": list(self.line_kinds), "item_kinds": list(self.item_kinds),
                "decisions": sorted(self.decisions),
                "item_calls": {k: list(self.calls_for(k)) for k in self.item_kinds},
                "other_calls": list(self.other_calls),
                "note_required": sorted(f"{k}:{c}" for k, c in self.note_required),
                "machine_reviewers": sorted(self.machine_reviewers),
                "info_kinds": sorted(self.info_kinds), "references": self.references,
                "caps": dict(self.caps), "markers": {k: dict(v) for k, v in self.markers.items()},
                "rules": page_rules()}


def web_file(config, name):
    """A file in the tracker's web folder, or None when the tracker has none."""
    if not config.web_dir:
        return None
    p = Path(config.web_dir) / name
    return p if p.is_file() else None
