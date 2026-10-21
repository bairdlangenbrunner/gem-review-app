"""The Python side of the JS parity tests (tests/js/parity.test.js). It prints one JSON object on stdout.

    python3 parity_world.py overlay <fixture.jsonl>     the page a reviewer opens and what the store's overlay says it should show
    python3 parity_world.py requests <requests.json>    the page, and each request with what the store's validators make of it

The tracker is the made-up one in tests/conftest.py, with two staging folders "a" and "b", two older keys for every key (<key>-old and <key>-older), and the record fields carried in the packed index.

For an overlay fixture, the records in <fixture.jsonl> are the ones in the reviewer's browser. When <fixture>.built.jsonl exists, its records were already in the log when the page was built: the page's data is the store's overlay of those, the way build_all.py builds a page. The expected data is the store's overlay of both files together.

A request file is a list of {"via": "decide" | "item" | "star", "records": [...]}. Two placeholders make the long cases: the string "$LONG" is 5001 characters, and {"$many": n, "of": record} is n copies of the record."""
import json
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent.parent), str(HERE.parent)]

from conftest import make_config, make_data  # noqa: E402
from review_core import build_static  # noqa: E402
from review_core.store import Invalid, bind  # noqa: E402

LABELS = ["a", "b"]
REVIEWER = "BL"


def config():
    return make_config(legacy_keys=lambda k: [k + "-old", k + "-older"],
                       index_entry=lambda o, g, e: dict(e, f={"record_id": o.get("record_id")}))


def dir_of(key):
    """The staging folder a record belongs to: the part of its key before the first "::", after any marker prefix."""
    key = key[len("star::"):] if key.startswith("star::") else key
    return key.split("::", 1)[0]


def read(path):
    return [json.loads(x) for x in Path(path).read_text(encoding="utf-8").splitlines() if x.strip()]


def write_logs(root, records):
    for r in records:
        r.setdefault("dir", dir_of(r["key"]))
        log = root / r["dir"] / "review_log.jsonl"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as f:
            f.write(json.dumps(r) + "\n")


def page(data, cfg):
    """The page settings (window.REVIEW_STATIC) and the dataset blob, taken out of a real build."""
    html = build_static.render(data, REVIEWER, cfg)
    settings = json.loads(re.search(r"window.REVIEW_STATIC = (\{.*?\});</script>", html).group(1))
    blob = re.search(r'id="review-blob">([^<]*)</script>', html).group(1)
    return {"static": settings, "blob": blob,
            "log_key": "review-log:" + data.get("built", "") + ":" + ",".join(data.get("dirs", []))}


def overlay_case(fixture):
    cfg = config()
    browser = read(fixture)
    built_path = Path(str(fixture)[:-len(".jsonl")] + ".built.jsonl")
    built = read(built_path) if built_path.exists() else []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for d in LABELS:
            (root / d).mkdir()
        api = bind(cfg, root)
        write_logs(root, [dict(r) for r in built])
        shown = api["overlay"](make_data(LABELS))
        out = page(shown, cfg)
        write_logs(root, [dict(r) for r in browser])
        out["expected"] = api["overlay"](make_data(LABELS))
    for r in browser:
        r.setdefault("dir", dir_of(r["key"]))
    out["browser"] = browser
    return out


def expand(v):
    """A request with its placeholders filled in."""
    if v == "$LONG":
        return "x" * 5001
    if isinstance(v, dict) and "$many" in v:
        return [expand(v["of"]) for _ in range(v["$many"])]
    if isinstance(v, dict):
        return {k: expand(x) for k, x in v.items()}
    if isinstance(v, list):
        return [expand(x) for x in v]
    return v


def requests_case(path):
    cfg = config()
    api = bind(cfg, Path(tempfile.gettempdir()))
    data = make_data(LABELS)
    check = {"decide": api["validate"], "item": api["validate_items"], "star": api["validate_stars"]}
    out = page(api["overlay"](make_data(LABELS), dirs={}), cfg)
    cases = []
    for c in json.loads(Path(path).read_text(encoding="utf-8")):
        recs = expand(c["records"])
        case = {"via": c["via"], "records": recs, "what": c.get("what", "")}
        try:
            case["ok"] = check[c["via"]](json.loads(json.dumps(recs)), data, REVIEWER)
        except Invalid as e:
            case["error"] = str(e)
        cases.append(case)
    out["cases"] = cases
    return out


if __name__ == "__main__":
    mode, arg = sys.argv[1], sys.argv[2]
    result = overlay_case(arg) if mode == "overlay" else requests_case(arg)
    json.dump(result, sys.stdout, ensure_ascii=False)
