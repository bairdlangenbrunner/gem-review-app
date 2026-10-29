"""The LNG tracker config: suggest rules, record fields, and its sync and push routes on a made-up App (nothing reaches a sheet)."""
import types

import pytest

from review_core.server import Refusal
from review_core.store import Invalid
from trackers.lng import config as lng

FILL = {"kind": "fill", "id": "10|Price", "column": "Price", "row_id": "u-10", "flags": []}


def test_a_suggest_needs_a_value_a_note_and_url_refs():
    r = {"decision": "suggest", "suggested_value": "250000000 USD", "note": "order total / 2",
         "suggested_refs": "https://a.example/x, https://a.example/x\nhttps://b.example/y"}
    out = lng.line_request(None, 0, r, FILL, {})
    assert out["suggest_kind"] == "value" and out["suggested_refs"] == ["https://a.example/x", "https://b.example/y"]
    for bad in ({"suggested_value": ""}, {"note": " "}, {"suggest_kind": "other"}, {"suggested_refs": ["ftp://x"]}):
        with pytest.raises(Invalid):
            lng.line_request(None, 0, dict(r, **bad), FILL, {})
    for line in ({"kind": "ref"}, {"kind": "new_row"}, dict(FILL, flags=["ref_only"])):
        with pytest.raises(Invalid, match="nothing to suggest"):
            lng.line_request(None, 0, r, line, {})
    assert lng.line_request(None, 0, {"decision": "accept"}, {"kind": "ref"}, {}) == {"decision": "accept"}


def test_line_record_carries_suggest_fields_only_on_a_suggest():
    rec = lng.line_record(None, 0, {"suggest_kind": "cosmetic", "suggested_refs": ["https://a.example"]}, FILL, {},
                          {"decision": "suggest", "undecided": False})[0]
    assert rec["suggest_kind"] == "cosmetic" and rec["suggested_refs"] == ["https://a.example"]
    rec = lng.line_record(None, 0, {"suggest_kind": "cosmetic"}, FILL, {}, {"decision": "reject", "undecided": False})[0]
    assert rec["suggest_kind"] == "" and rec["suggested_refs"] == []


def test_record_fields():
    assert lng.record_fields(None, FILL, "lines") == {"record_id": "10|Price", "column": "Price", "row_id": "u-10"}
    conflict = {"conflict_index": 3, "conflict_match": ("u-10", "Price")}
    assert lng.record_fields(None, conflict, "items") == {"conflict_index": 3, "conflict_match": ["u-10", "Price"]}
    assert lng.record_fields(None, {"kind": "flag"}, "items") == {}
    assert lng.index_entry(FILL, "lines", {})["f"]["record_id"] == "10|Price"


class Handler:
    def __init__(self, body):
        self._body = body

    def body(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def handlers(app):
    return {(m, p): fn for m, p, fn in lng.routes(app)}


def test_routes_refuse_without_the_app_methods():
    hs = handlers(types.SimpleNamespace())
    assert lng.dynamic_caps(types.SimpleNamespace()) == {"refresh": False, "push": False}
    for key in hs:
        with pytest.raises(Refusal) as e:
            hs[key](Handler({}))
        assert e.value.status == 409


def test_routes_pass_the_plan_token_and_wrap_failures():
    seen = []

    def push_apply(token, include_applied, batch):
        seen.append((token, include_applied, batch))
        return {"written": 0}

    def push_plan(batch):
        raise RuntimeError("pull failed")
    app = types.SimpleNamespace(refresh=lambda: {"ok": True}, push_plan=push_plan, push_apply=push_apply)
    assert lng.dynamic_caps(app) == {"refresh": True, "push": True}
    hs = handlers(app)
    assert hs[("POST", "/api/refresh")](Handler({})) == {"ok": True}
    assert hs[("POST", "/api/push")](Handler({"token": "t1", "batch": "b"})) == {"written": 0}
    assert seen == [("t1", False, "b")]
    with pytest.raises(Refusal) as e:
        hs[("POST", "/api/push/plan")](Handler({}))
    assert e.value.status == 500 and "pull failed" in str(e.value)
    with pytest.raises(Refusal) as e:
        hs[("POST", "/api/push")](Handler(ValueError("bad")))
    assert e.value.status == 400
