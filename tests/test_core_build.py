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


def test_logged_ids_are_the_imported_page_records(web, tmp_path):
    data = make_data(["batches/a/staging", "batches/b/staging"])
    a = tmp_path / "repo" / "batches/a/staging"
    a.mkdir(parents=True)
    (a / "review_log.jsonl").write_text("\n".join(json.dumps(r) for r in [
        {"id": "p1", "origin": "artifact", "key": "k"},
        {"id": "s1", "origin": "local", "key": "k"},
        {"origin": "artifact", "key": "k"},
        {"id": "p0", "origin": "artifact", "key": "k"}]) + "\n")
    html = build_static.render(data, "BL", make_config(web_dir=web), root=tmp_path / "repo")
    cfg_js = json.loads(re.search(r"window.REVIEW_STATIC = (\{.*?\});</script>", html).group(1))
    assert cfg_js["logged"] == ["p0", "p1"]
    html = build_static.render(data, "BL", make_config(web_dir=web))
    assert json.loads(re.search(r"window.REVIEW_STATIC = (\{.*?\});</script>", html).group(1))["logged"] == []


def test_geo_script_and_leaflet_css_are_inlined(web):
    geo_js = "window.ReviewGeo = {a: 1};\nvar GEO_END = 1;"
    (build_static.CORE_WEB / "geo.js").write_text(geo_js)
    (build_static.CORE_WEB / "leaflet.css").write_text(".leaflet-container{overflow:hidden}")
    (web / "ext.css").write_text(".x{}")
    (web / "ext.js").write_text("var EXT = 1;")
    html = build_static.render(make_data(["s"]), "BL", make_config(web_dir=web))
    assert geo_js in html and ".leaflet-container{overflow:hidden}" in html
    # scripts: the store, then geo.js, then app.js, then the tracker's; styles: style.css, leaflet.css, then ext.css
    marks = ["var STORE = 1;", "window.ReviewGeo", "var APP = 1;", "var EXT = 1;"]
    at = [html.index(m) for m in marks]
    assert at == sorted(at)
    assert html.index("body{color:#000}") < html.index(".leaflet-container") < html.index(".x{}")
    assert html.count("<script>") == 5


def test_missing_geo_script_and_leaflet_css_build_as_before(web):
    assert not (build_static.CORE_WEB / "geo.js").exists() and not (build_static.CORE_WEB / "leaflet.css").exists()
    html = build_static.render(make_data(["s"]), "BL", make_config(web_dir=web))
    assert "ReviewGeo" not in html and "leaflet" not in html
    assert "var STORE = 1;" in html and "var APP = 1;" in html
    # a core script that is not optional is still required
    (build_static.CORE_WEB / "app.js").unlink()
    with pytest.raises(FileNotFoundError):
        build_static.render(make_data(["s"]), "BL", make_config(web_dir=web))


def test_route_geometry_over_the_limit_is_refused(web):
    def with_geo(n):
        data = make_data(["s"])
        data["widgets"][0]["lines"][0]["geo"] = {"candidate": {"coords": "x" * n}}
        return data
    cfg = make_config(web_dir=web)
    small = with_geo(1000)
    assert 1000 < build_static.geo_bytes(small, cfg) < 1100
    assert build_static.geo_bytes(make_data(["s"]), cfg) == 0
    assert build_static.read_blob(build_static.render(small, "BL", cfg))["data"] == small
    big = with_geo(build_static.MAX_GEO_BYTES)
    assert build_static.geo_bytes(big, cfg) > build_static.MAX_GEO_BYTES
    with pytest.raises(SystemExit, match=r"route geometry.*3 MB limit"):
        build_static.render(big, "BL", cfg)
