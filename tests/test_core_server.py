"""The shared loopback server on a made-up tracker: page, files, writes, refusals."""
import json
import threading
import urllib.error
import urllib.request

import pytest

from conftest import make_config, make_data
from review_core import server
from review_core.store import bind


@pytest.fixture
def running(tmp_path, monkeypatch):
    core_web = tmp_path / "core_web"
    core_web.mkdir()
    (core_web / "index.html").write_text("<html><head><title>x</title></head><body><h1>x</h1>"
                                         "<script src=\"/core/app.js\"></script></body></html>")
    (core_web / "app.js").write_text("// core")
    monkeypatch.setattr(server, "CORE_WEB", core_web)
    tracker_web = tmp_path / "tracker_web"
    tracker_web.mkdir()
    (tracker_web / "ext.js").write_text("// tracker")       # no ext.css on purpose
    root = tmp_path / "repo"
    labels = ["batches/a/staging"]
    (root / labels[0]).mkdir(parents=True)
    data_path = tmp_path / "data.json"
    data_path.write_text(json.dumps(make_data(labels)))
    api = bind(make_config(web_dir=tracker_web, title="Widget <reviewer>"), root)
    app = server.App(data_path, "Baird Langenbrunner", api)
    httpd = server.make_server(app, port=0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", app, root / labels[0]
    httpd.shutdown()
    httpd.server_close()


def get(url):
    with urllib.request.urlopen(url) as r:
        return r.status, r.read().decode("utf-8")


def post(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_refuses_to_bind_beyond_loopback():
    with pytest.raises(ValueError, match="loopback-only"):
        server.ensure_loopback("0.0.0.0")


def test_page_and_files(running):
    base, app, _ = running
    status, html = get(base + "/")
    assert status == 200 and "<title>Widget &lt;reviewer&gt;</title>" in html and "<h1>Widget &lt;reviewer&gt;</h1>" in html
    assert get(base + "/core/app.js") == (200, "// core")
    assert get(base + "/tracker/ext.js") == (200, "// tracker")
    assert get(base + "/tracker/ext.css") == (200, "")          # missing ext counts as empty
    for bad in ("/tracker/other.js", "/core/../conftest.py", "/app.js", "/api/nope"):
        with pytest.raises(urllib.error.HTTPError) as e:
            get(base + bad)
        assert e.value.code == 404
    who = json.loads(get(base + "/api/whoami")[1])
    assert who == {"reviewer": "BL", "caps": {"decide": True}, "store": False}


def get_raw(url):
    with urllib.request.urlopen(url) as r:
        return r.status, r.headers, r.read()


def test_asset_route_serves_only_made_pictures(running):
    base, app, _ = running
    folder = app.root / "work" / "review_assets"
    folder.mkdir(parents=True)
    jpg, png, absent = "a" * 64 + ".jpg", "b" * 64 + ".png", "c" * 64 + ".jpg"
    (folder / jpg).write_bytes(b"\xff\xd8jpeg")
    (folder / png).write_bytes(b"\x89PNGbytes")
    (folder / "notes.jpg").write_bytes(b"x")           # in the folder, but not a name the assets module makes
    (app.root / "work" / "secret.txt").write_text("no")
    status, headers, body = get_raw(base + "/asset/" + jpg)
    assert (status, headers["Content-Type"], body) == (200, "image/jpeg", b"\xff\xd8jpeg")
    assert "immutable" in headers["Cache-Control"]
    status, headers, body = get_raw(base + "/asset/" + png)
    assert (status, headers["Content-Type"], body) == (200, "image/png", b"\x89PNGbytes")
    for bad in (absent, "notes.jpg", "../secret.txt", "..%2Fsecret.txt", jpg + ".txt", jpg.upper(), ""):
        with pytest.raises(urllib.error.HTTPError) as e:
            get(base + "/asset/" + bad)
        assert e.value.code == 404


def test_write_round_trip(running):
    base, app, staging = running
    key = "batches/a/staging::W1:size"
    assert post(base + "/api/decide", [{"key": key, "decision": "hold", "reviewer": "ZZ"}])[0] == 200
    status, out = post(base + "/api/item", [{"key": "batches/a/staging::W1:watch-1", "call": "keep"}])
    assert status == 200 and out["saved"][0]["reviewer"] == "BL"
    assert post(base + "/api/star", [{"key": key, "on": True}])[0] == 200
    data = json.loads(get(base + "/api/data")[1])
    line = data["widgets"][0]["lines"][0]
    assert (line["decision"], line["decided_by"], line["star_flag"]) == ("hold", "BL", True)
    recs = json.loads(get(base + "/api/decisions?dir=batches/a/staging")[1])["decisions"]
    assert recs[key]["decision"] == "hold"
    assert len((staging / "review_log.jsonl").read_text().splitlines()) == 3


def test_refusals(running):
    base, _, staging = running
    status, out = post(base + "/api/decide", [{"key": "nope", "decision": "accept"}])
    assert status == 400 and "unknown key" in out["error"]
    status, out = post(base + "/api/item", [{"key": "batches/a/staging::W1:watch-1", "call": "drop"}])
    assert status == 400 and "needs a note" in out["error"]
    assert not (staging / "review_log.jsonl").exists()


def test_store_errors_answer_502_and_tracker_routes(tmp_path, monkeypatch):
    class Down(Exception):
        pass

    class Ledger:
        origin = None

        def sink(self, *a, **k):
            raise Down("sheet unreachable")

    def ping(handler):
        return {"pong": handler.query.get("x", [""])[0]}

    def nope(handler):
        raise server.Refusal(409, "not now")
    core_web = tmp_path / "w"
    core_web.mkdir()
    monkeypatch.setattr(server, "CORE_WEB", core_web)
    root = tmp_path / "repo"
    (root / "s").mkdir(parents=True)
    data_path = tmp_path / "d.json"
    data_path.write_text(json.dumps(make_data(["s"])))
    cfg = make_config(routes=lambda app: [("GET", "/api/ping", ping), ("POST", "/api/nope", nope)],
                      dynamic_caps=lambda app: {"push": False})
    app = server.App(data_path, "AL", bind(cfg, root), ledger=Ledger(), store_errors=(Down,))
    httpd = server.make_server(app, port=0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        status, out = post(base + "/api/decide", [{"key": "s::W1:size", "decision": "accept"}])
        assert status == 502 and "nothing saved" in out["error"]
        assert not (root / "s" / "review_log.jsonl").exists()
        assert json.loads(get(base + "/api/ping?x=1")[1]) == {"pong": "1"}
        assert post(base + "/api/nope", {}) == (409, {"error": "not now"})
        assert json.loads(get(base + "/api/whoami")[1])["caps"] == {"decide": True, "push": False}
        with pytest.raises(urllib.error.HTTPError) as e:
            get(base + "/")
        assert e.value.code == 404
    finally:
        httpd.shutdown()
        httpd.server_close()
