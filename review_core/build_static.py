"""
The single-file review page: the shared page plus one tracker's extension, with the dataset inside it. There is no server behind it. review_core/web/static_store.js checks each decision against the packed key index and keeps the records in the reviewer's browser and, on a published claude.ai artifact, in the artifact's shared database.

The page has no doctype, html, head or body tags of its own: the Artifact tool wraps it, and a browser opening the file from disk does the same. In order it holds:

  1. <title> (the tracker's title, or the one given)
  2. <style>: review_core/web/style.css, then the tracker's web/ext.css
  3. the body of review_core/web/index.html, with its local script and stylesheet tags taken out
  4. the dataset: <script type="application/octet-stream" id="review-blob">, base64 of gzip {data, index}
  5. <script>window.REVIEW_STATIC = {reviewer, built, ledger_url, logged, tracker}</script>, where tracker is TrackerConfig.page_block() and logged is the ids of page records already in the decision log (logged_ids)
  6. review_core/web/static_store.js, review_core/web/app.js, then the tracker's web/ext.js

A missing ext.css or ext.js counts as empty. The dataset and its reviewer settings come before the scripts so every script can read them as it loads.

The packed index is {"v": 2, "dirs": [label], "keys": [{rest: entry}]}, the two lists aligned, where rest is the key without its "<dir>::" prefix. A line entry is {k kind, p pid, d default (left out when "accept")}; an item entry is {i kind, p pid, c0 the call the dataset already holds}. A tracker adds fields through config.index_entry (GOGPT: f, the record fields), and through config.index_extras for anything that needs the whole index or dataset (pipelines: concern answers x, the top-level w and cmd).
"""
import base64
import gzip
from html import escape
import json
import re
from pathlib import Path

from review_core.config import web_file
from review_core.store import cards, read_log

CORE_WEB = Path(__file__).resolve().parent / "web"
CORE_SCRIPTS = ("static_store.js", "app.js")
MAX_BYTES = 16 * 1024 * 1024          # the Artifact tool's page limit
BLOB_ID = "review-blob"


def pack_index(data, config):
    """The key index the page's store checks each record against (see the module docstring)."""
    dirs, groups = [], []
    for card in cards(data, config):
        for grp in ("lines", "items"):
            for o in card.get(grp, []):
                key, d = o["key"], o.get("dir") or card.get("dir")
                if not key.startswith(f"{d}::"):
                    raise SystemExit(f"key {key!r} does not start with its dir {d!r}: the index cannot be packed")
                if d not in dirs:
                    dirs.append(d)
                    groups.append({})
                pid = o.get("pid") or card["pid"]
                if grp == "items":
                    e = {"i": o["kind"], "p": pid}
                    if o.get("call"):
                        e["c0"] = o["call"]
                else:
                    e = {"k": o["kind"], "p": pid}
                    if (o.get("default") or "accept") != "accept":
                        e["d"] = o["default"]
                if config.index_entry:
                    e = config.index_entry(o, grp, e)
                groups[dirs.index(d)][key[len(d) + 2:]] = e
    for d in data.get("dirs", []):      # a dir with nothing to decide still belongs to the page
        if d not in dirs:
            dirs.append(d)
            groups.append({})
    index = {"v": 2, "dirs": dirs, "keys": groups}
    if config.index_extras:
        index = config.index_extras(data, index)
    return index


def blob(data, index):
    raw = json.dumps({"data": data, "index": index}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(gzip.compress(raw, 9, mtime=0)).decode("ascii")


def unblob(text):
    """The {data, index} a blob holds (for tests and checks)."""
    return json.loads(gzip.decompress(base64.b64decode(text)).decode("utf-8"))


def read_blob(html):
    """The {data, index} inside a built page."""
    m = re.search(rf'<script type="application/octet-stream" id="{BLOB_ID}">([^<]*)</script>', html)
    if not m:
        raise ValueError("no dataset block in this page")
    return unblob(m.group(1))


def _read(path):
    return Path(path).read_text(encoding="utf-8") if path else ""


def _inline_js(name, text):
    # an inline script ends at the first "</script" whatever the JS meant by it
    if re.search(r"</script", text, re.I) or "<!--" in text:
        raise SystemExit(f"{name}: contains '</script' or '<!--', which would break an inline <script>: "
                         "split the string ('<' + '/script>')")
    return f"<script>\n{text.rstrip()}\n</script>"


def logged_ids(data, root):
    """The ids of the page records already in the decision log: the records import_log.py brought in from an artifact (origin 'artifact'), read from each dir's review_log.jsonl under `root`. The page leaves these out of a "push to log" count."""
    out = set()
    for d in data.get("dirs", []):
        for r in read_log(Path(root) / d):
            if r.get("id") and r.get("origin") == "artifact":
                out.add(str(r["id"]))
    return sorted(out)


def render(data, reviewer, config, index=None, title=None, ledger_url="", root=None):
    """The page as one html string (see the module docstring). `index` defaults to pack_index. With `root` (the researcher repo, which the dir labels are relative to), the page also gets `logged`, the ids logged_ids finds."""
    html = (CORE_WEB / "index.html").read_text(encoding="utf-8")
    css = _read(CORE_WEB / "style.css").rstrip() + "\n" + _read(web_file(config, "ext.css")).rstrip()
    if "</style" in css.lower():
        raise SystemExit("style.css or ext.css contains '</style'")
    title = escape(title or config.title, quote=False)
    b = re.search(r"<body[^>]*>(.*)</body>", html, re.S)
    if not b:
        raise SystemExit("index.html: no <body>")
    body = b.group(1).replace("{{title}}", title)
    body = re.sub(r"(<h1[^>]*>).*?(</h1>)", lambda m: m.group(1) + title + m.group(2), body, count=1, flags=re.S)
    body = re.sub(r'<script\b[^>]*\bsrc="(?!https?:)[^"]*"[^>]*>\s*</script>\s*', "", body)
    body = re.sub(r'<link\b[^>]*\bhref="(?!https?:)[^"]*"[^>]*>\s*', "", body)
    left = re.findall(r'<(?:script|link)[^>]+(?:src|href)="(?!https?:)[^"]*"', body)
    if left:
        raise SystemExit(f"index.html still references local files the page cannot load: {left}")
    cfg = json.dumps({"reviewer": reviewer or "", "built": data.get("built", ""), "ledger_url": ledger_url or "",
                      "logged": logged_ids(data, root) if root else [],
                      "tracker": config.page_block()}, ensure_ascii=False).replace("</", "<\\/")
    scripts = [_inline_js(n, _read(CORE_WEB / n)) for n in CORE_SCRIPTS]
    ext_js = _read(web_file(config, "ext.js"))
    if ext_js.strip():
        scripts.append(_inline_js("ext.js", ext_js))
    if index is None:
        index = pack_index(data, config)
    return (f"<title>{title}</title>\n<style>\n{css.strip()}\n</style>\n"
            f"{body.strip()}\n"
            f'<script type="application/octet-stream" id="{BLOB_ID}">{blob(data, index)}</script>\n'
            f"<script>window.REVIEW_STATIC = {cfg};</script>\n"
            + "\n".join(scripts) + "\n")
