"""The shared store on a made-up tracker: names, round trips, latest wins, rollback."""
import json
from types import SimpleNamespace

import pytest

from conftest import make_config
from review_core import store as core


def ns(world):
    return SimpleNamespace(**world["api"])


def test_bind_exports_the_names_a_shim_needs(world):
    api = world["api"]
    for name in ("LINE_KINDS", "ITEM_KINDS", "ITEM_CALLS", "OTHER_CALLS", "NOTE_REQUIRED", "DECISIONS", "LOG_NAME",
                 "DERIVED_NAME", "ET", "_INITIALS_RE", "_EMAIL_RE", "_URL_RE", "MACHINE_REVIEWERS", "_LOCK",
                 "Invalid", "initials", "is_machine", "read_jsonl", "read_log", "latest", "read_decisions",
                 "reviewed", "dir_paths", "overlay", "now", "index", "validate", "validate_items", "atomic_write",
                 "append_jsonl", "rollback", "write_derived", "_write", "decide", "append_records", "record_items",
                 "ROOT", "CONFIG", "validate_stars", "record_stars"):
        assert name in api, name
    assert api["ITEM_CALLS"] == {"concern": ("confirmed", "dismissed"), "watch": ("keep", "drop"),
                                 "other": ("noted", "todo", "dismissed")}
    assert api["Invalid"] is core.Invalid
    # the shim pattern: names land in a module namespace and keep working there
    mod = {}
    mod.update(api)
    assert mod["initials"]("Baird Langenbrunner") == "BL" and mod["initials"]("push") == "push"


def test_exports_hook_adds_tracker_names(tmp_path):
    api = core.bind(make_config(exports=lambda a: {"STAR_KEY": a.marker_key("star", "d", "W1")}), tmp_path)
    assert api["STAR_KEY"] == "star::d::widget:W1"


def test_decide_item_undo_round_trip(world):
    s, data, dirs = ns(world), world["data"], world["dirs"]
    card = data["widgets"][0]
    size, color = card["lines"]
    qa, watch = card["items"]
    saved = s.decide([{"key": size["key"], "decision": "suggest", "suggested_value": "12",
                       "reference": "https://example.com/spec"}], data, "Baird Langenbrunner", dirs)
    assert saved[0]["reviewer"] == "BL" and saved[0]["record_id"] == "W1:size" and saved[0]["ts"]
    s.record_items([{"key": qa["key"], "call": "confirmed"}], data, "BL", dirs)
    s.record_stars([{"key": size["key"], "on": True, "note": "ask"}], data, "BL", dirs)
    s.record_stars([{"pid": "W1", "dir": card["dir"], "on": True, "note": "whole widget"}], data, "BL", dirs)
    s.overlay(data, dirs)
    assert (size["decision"], size["suggested_value"], size["reference"], size["reviewed"], size["decided_by"]) == \
        ("suggest", "12", "https://example.com/spec", True, "BL")
    assert (qa["call"], qa["reviewed"]) == ("confirmed", True)
    assert (size["star_flag"], size["star_note"], card["star_flag"], card["star_note"]) == (True, "ask", True, "whole widget")
    # undo: the line goes back to undecided, the record keeps the line's default decision
    s.decide([{"key": color["key"], "decision": "accept"}], data, "BL", dirs)
    out = s.decide([{"key": color["key"], "undo": True}], data, "BL", dirs)
    assert out[0]["undecided"] is True and out[0]["decision"] == "reject"
    s.record_items([{"key": qa["key"], "undo": True}], data, "BL", dirs)
    s.overlay(data, dirs)
    assert (color["decision"], color["reviewed"], qa["call"], qa["reviewed"]) == (None, False, None, False)
    derived = json.loads((dirs[card["dir"]] / s.DERIVED_NAME).read_text())
    assert derived["decisions"][color["key"]]["undecided"] is True
    assert len(s.read_log(dirs[card["dir"]])) == 7


def test_refusals_write_nothing(world):
    s, data, dirs = ns(world), world["data"], world["dirs"]
    card = data["widgets"][0]
    size = card["lines"][0]
    qa, watch = card["items"]
    cases = [
        (s.decide, [{"key": "nope", "decision": "accept"}], "unknown key"),
        (s.decide, [{"key": qa["key"], "decision": "accept"}], "is an item, not a line"),
        (s.decide, [{"key": size["key"]}], "no decision given"),
        (s.decide, [{"key": size["key"], "decision": "maybe"}], "not one of accept, hold, reject, suggest"),
        (s.decide, [{"key": size["key"], "decision": "suggest"}], "needs a suggested_value or a note"),
        (s.decide, [{"key": size["key"], "decision": "accept", "reference": "example.com"}], "not a web address"),
        (s.record_items, [{"key": size["key"], "call": "confirmed"}], "is a line, not an item"),
        (s.record_items, [{"key": watch["key"], "call": "confirmed"}], "not one of keep, drop"),
        (s.record_items, [{"key": watch["key"], "call": "drop"}], "needs a note"),
        (s.record_stars, [{"key": "nope", "on": True}], "unknown key"),
        (s.decide, [], "non-empty list"),
    ]
    for fn, body, msg in cases:
        with pytest.raises(core.Invalid, match=msg):
            fn(body, data, "BL", dirs)
    assert all(not (d / s.LOG_NAME).exists() for d in dirs.values())


def test_latest_wins_and_machine_records_never_speak_over_a_person(world):
    s, data, dirs = ns(world), world["data"], world["dirs"]
    size = data["widgets"][0]["lines"][0]
    s.decide([{"key": size["key"], "decision": "hold"}], data, "BL", dirs)
    s.decide([{"key": size["key"], "decision": "accept", "note": "checked"}], data, "AL", dirs)
    s.overlay(data, dirs)
    assert (size["decision"], size["decided_by"], size["decision_note"]) == ("accept", "AL", "checked")
    s.decide([{"key": size["key"], "decision": "reject"}], data, "push", dirs)    # a machine record
    s.overlay(data, dirs)
    assert (size["decision"], size["decided_by"], size["reviewed"]) == ("accept", "AL", True)
    log = s.read_log(dirs[size["dir"]])
    assert s.latest(log)[size["key"]]["reviewer"] == "push" and s.is_machine(log[-1])


def test_decide_extras_owe_item_calls_in_the_same_write(tmp_path):
    def owed(api, recs, data):
        return [{"key": r["key"].replace(":size", ":qa-1"), "call": "dismissed", "note": "resolved by the line"}
                for r in recs if r["decision"] == "accept" and r["key"].endswith(":size")]
    api = core.bind(make_config(decide_extras=owed), tmp_path)
    from conftest import make_data
    data = make_data(["s"])
    (tmp_path / "s").mkdir()
    dirs = api["dir_paths"](data)
    out = api["decide"]([{"key": "s::W1:size", "decision": "accept"}], data, "BL", dirs)
    assert [r.get("decision") or r.get("call") for r in out] == ["accept", "dismissed"]
    assert api["decide"]([{"key": "s::W1:size", "decision": "accept"}], data, "push", dirs)[1:] == []


def test_failed_write_rolls_every_dir_back(world, monkeypatch):
    s, data, dirs = ns(world), world["data"], world["dirs"]
    a, b = data["widgets"]
    s.decide([{"key": a["lines"][0]["key"], "decision": "hold"}], data, "BL", dirs)
    before = (dirs[a["dir"]] / s.LOG_NAME).read_bytes()
    calls = {"n": 0}
    real = core.write_derived

    def flaky(d, ts):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk full")
        return real(d, ts)
    monkeypatch.setattr(core, "write_derived", flaky)
    with pytest.raises(OSError):
        s.decide([{"key": a["lines"][1]["key"], "decision": "accept"},
                  {"key": b["lines"][0]["key"], "decision": "accept"}], data, "BL", dirs)
    monkeypatch.setattr(core, "write_derived", real)
    assert (dirs[a["dir"]] / s.LOG_NAME).read_bytes() == before
    assert not (dirs[b["dir"]] / s.LOG_NAME).exists()
    assert len(json.loads((dirs[a["dir"]] / s.DERIVED_NAME).read_text())["decisions"]) == 1


def test_append_records_keeps_records_as_given(world):
    s, dirs = ns(world), world["dirs"]
    d = world["labels"][0]
    rec = {"key": f"{d}::W1:size", "dir": d, "decision": "accept", "reviewer": "AL", "ts": "2026-10-01T10:00:00-04:00",
           "undecided": False, "id": "x"}
    s.append_records([rec], dirs)
    assert s.read_log(dirs[d]) == [rec]
    with pytest.raises(core.Invalid, match="not known"):
        s.append_records([dict(rec, dir="elsewhere")], dirs)


def test_legacy_keys_speak_for_a_line_with_no_record(tmp_path):
    api = core.bind(make_config(legacy_keys=lambda k: [k + "-old"]), tmp_path)
    from conftest import make_data
    data = make_data(["s"])
    (tmp_path / "s").mkdir()
    dirs = api["dir_paths"](data)
    api["append_records"]([{"key": "s::W1:size-old", "dir": "s", "decision": "accept", "reviewer": "AL",
                            "ts": "2026-10-01T10:00:00-04:00", "undecided": False}], dirs)
    api["overlay"](data, dirs)
    assert data["widgets"][0]["lines"][0]["decision"] == "accept"


def test_via_says_how_a_call_was_made(world):
    s, data, dirs = ns(world), world["data"], world["dirs"]
    size, color = data["widgets"][0]["lines"]
    out = s.decide([{"key": size["key"], "decision": "accept", "via": "bulk:q=widget"},
                    {"key": color["key"], "decision": "accept", "via": "linked"}], data, "BL", dirs)
    assert [r["via"] for r in out] == ["bulk:q=widget", "linked"]
    # a plain call carries no via at all; an empty one is dropped
    out = s.decide([{"key": size["key"], "undo": True, "via": ""}], data, "BL", dirs)
    assert "via" not in out[0]
    with pytest.raises(core.Invalid, match="via"):
        s.validate([{"key": size["key"], "decision": "accept", "via": "x" * 301}], data)
    with pytest.raises(core.Invalid, match="via"):
        s.validate([{"key": size["key"], "decision": "accept", "via": 3}], data)
