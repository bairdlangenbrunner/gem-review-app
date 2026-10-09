"""The single-file page builder on a made-up tracker: order, blob round trip, refusals."""
import json
import re

import pytest

from conftest import make_config, make_data
from review_core import build_static


@pytest.fixture
def web(tmp_path, monkeypatch):
    core_web = tmp_path / "core_web"
    core_web.mkdir()
    (core_web / "index.html").write_text(
        '<html><head><link rel="stylesheet" href="/core/style.css"></head><body><h1>x</h1><main id="m"></main>'
        '<script src="/core/static_store.js"></script><script src="/core/app.js"></script></body></html>')
    (core_web / "style.css").write_text("body{color:#000}")
    (core_web / "static_store.js").write_text("var STORE = 1;")
    (core_web / "app.js").write_text("var APP = 1;")
    monkeypatch.setattr(build_static, "CORE_WEB", core_web)
    tracker = tmp_path / "tracker_web"
    tracker.mkdir()
    return tracker


def test_page_order_and_blob_round_trip(web):
    (web / "ext.css").write_text(".x{}")
    (web / "ext.js").write_text("var EXT = 1;")
    data = make_data(["batches/a/staging", "batches/b/staging"])
    data["dirs"].append("batches/empty/staging")
    data["widgets"][0]["lines"][1]["default"] = "reject"
    data["widgets"][0]["items"][0]["call"] = "confirmed"
    cfg = make_config(web_dir=web, index_entry=lambda o, g, e: dict(e, f=o["record_id"]))
    html = build_static.render(data, "BL", cfg, ledger_url="https://example.com/log")
    marks = ["<title>Widget reviewer</title>", "body{color:#000}", ".x{}", '<main id="m">', 'id="review-blob"',
             "window.REVIEW_STATIC", "var STORE = 1;", "var APP = 1;", "var EXT = 1;"]
    at = [html.index(m) for m in marks]
    assert at == sorted(at)
    assert "<link" not in html and 'src="/core' not in html
    cfg_js = json.loads(re.search(r"window.REVIEW_STATIC = (\{.*?\});</script>", html).group(1))
    assert cfg_js["reviewer"] == "BL" and cfg_js["ledger_url"] == "https://example.com/log"
    assert cfg_js["built"] == data["built"] and "data" not in cfg_js
    t = cfg_js["tracker"]
    assert t["cards_key"] == "widgets" and t["note_required"] == ["watch:drop"]
    assert t["markers"]["star"]["prefix"] == "star::"
    got = build_static.read_blob(html)
    assert got["data"] == data
    idx = got["index"]
    assert idx["v"] == 2 and idx["dirs"] == ["batches/a/staging", "batches/b/staging", "batches/empty/staging"]
    assert idx["keys"][0]["W1:color"] == {"k": "change", "p": "W1", "d": "reject", "f": "W1:color"}
    assert idx["keys"][0]["W1:qa-1"] == {"i": "concern", "p": "W1", "c0": "confirmed", "f": "W1:qa-1"}
    assert idx["keys"][2] == {}


def test_missing_ext_counts_as_empty(web):
    html = build_static.render(make_data(["s"]), "BL", make_config(web_dir=web), title="A <b> title")
    assert "<title>A &lt;b&gt; title</title>" in html and "<h1>A &lt;b&gt; title</h1>" in html
    assert html.count("<script>") == 3        # the boot settings, static_store.js, app.js


def test_refusals(web):
    (web / "ext.js").write_text("var s = '</script>';")
    with pytest.raises(SystemExit, match="ext.js"):
        build_static.render(make_data(["s"]), "BL", make_config(web_dir=web))
    data = make_data(["s"])
    data["widgets"][0]["lines"][0]["key"] = "elsewhere::W1:size"
    with pytest.raises(SystemExit, match="does not start with its dir"):
        build_static.pack_index(data, make_config())
