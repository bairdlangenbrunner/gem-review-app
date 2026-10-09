"""Shared fixtures: a synthetic tracker config and dataset, so the core tests need no researcher repo."""
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from review_core.config import TrackerConfig  # noqa: E402
from review_core.store import bind  # noqa: E402


def make_config(**over):
    """A made-up tracker: two line kinds, a concern with its own calls, a watch item whose
    "drop" call needs a note, and a "star" marker."""
    base = dict(
        name="widgets", title="Widget reviewer", cards_key="widgets",
        line_kinds=("fill", "change"), item_kinds=("concern", "watch", "other"),
        item_calls={"concern": ("confirmed", "dismissed"), "watch": ("keep", "drop")},
        note_required={("watch", "drop")},
        markers={"star": {"prefix": "star::", "value": "star", "card_tag": "widget", "field": "star"}},
        record_fields=lambda card, obj, grp: {"record_id": obj.get("record_id")},
    )
    base.update(over)
    return TrackerConfig(**base)


def make_data(labels):
    """One card per staging dir label: two lines (one defaulting to reject) and two items."""
    out = []
    for i, d in enumerate(labels):
        pid = f"W{i + 1}"
        out.append({"pid": pid, "name": f"widget {i + 1}", "dir": d,
                    "lines": [{"key": f"{d}::{pid}:size", "record_id": f"{pid}:size", "pid": pid, "dir": d,
                               "kind": "fill", "column": "Size"},
                              {"key": f"{d}::{pid}:color", "record_id": f"{pid}:color", "pid": pid, "dir": d,
                               "kind": "change", "column": "Color", "default": "reject"}],
                    "items": [{"key": f"{d}::{pid}:qa-1", "record_id": f"{pid}:qa-1", "pid": pid, "dir": d,
                               "kind": "concern", "title": "size looks high"},
                              {"key": f"{d}::{pid}:watch-1", "record_id": f"{pid}:watch-1", "pid": pid, "dir": d,
                               "kind": "watch", "title": "proposed site"}]})
    return {"dirs": list(labels), "built": "2026-10-08T09:00:00-04:00", "widgets": out}


@pytest.fixture
def world(tmp_path):
    """Two staging dirs under tmp_path, the bound store, and the dataset."""
    labels = ["batches/a/staging", "batches/b/staging"]
    for d in labels:
        (tmp_path / d).mkdir(parents=True)
    api = bind(make_config(), tmp_path)
    data = make_data(labels)
    return {"root": tmp_path, "api": api, "data": data, "labels": labels,
            "dirs": api["dir_paths"](data)}
