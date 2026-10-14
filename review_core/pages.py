"""
Published-page registry logic: what a live review page was built from, and whether it is still current.

A review page is a snapshot. Each researcher repo keeps `review_app/artifacts.json` ({"pages": [entry, ...]}) with one entry per live page, and this module answers "is that page stale, and why" from content hashes alone (never mtimes, never the network). The core never imports from a researcher repo: the repo passes a PageAdapter that knows where its staged files, decision logs and builder live. See docs/refresh.md.

An entry's `published` block holds what the live page was built from:

    {"built": ts, "at": ts, "profile": "gem"|"personal", "fingerprint": sha, "parts": {...}}

`parts` is {"interface": sha, "builder": sha, "dirs": {label: sha}, "decisions": {label: sha}, **extra_inputs}. `fingerprint` is the hash of `parts`; `parts` exists so a check can say which input changed.
"""
from dataclasses import dataclass, field
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Callable, Optional

CORE = Path(__file__).resolve().parent
REPO = CORE.parent
LAST_BUILD = "work/review_pages_last_build.json"


class PublishError(Exception):
    """mark_published refused: the inputs changed between the build and the publish."""


@dataclass
class PageAdapter:
    """What a researcher repo tells the core about its pages. Paths are absolute or relative to `root`.

    resolve_dirs(entry) -> staging dirs the entry's dataset is built from (explicit `dirs`, or the review-app batch).
    staged_files(dir) -> names of the files in a dir the dataset builder reads; those that exist are hashed.
    decision_files -> names of the decision logs in a dir.
    extra_inputs(entry) -> {part name: value}: the manifest sha, the snapshot name, an export csv sha.
    builder_files -> repo files whose change means rebuild.
    """
    root: Path
    resolve_dirs: Callable
    staged_files: Callable
    decision_files: tuple = ("review_log.jsonl",)
    extra_inputs: Optional[Callable] = None
    builder_files: tuple = ()
    build: Optional[Callable] = None


def _sha(paths):
    """sha256 over (relative name, content) of the existing files, in sorted-name order."""
    h = hashlib.sha256()
    for name, p in sorted(paths):
        if Path(p).is_file():
            h.update(name.encode() + b"\0" + Path(p).read_bytes() + b"\0")
    return h.hexdigest()


def sha_file(path):
    """sha256 of one file ('' when it is missing); handy for an adapter's extra_inputs."""
    p = Path(path)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else ""


def _tree(base, names_or_dir):
    base = Path(base)
    if isinstance(names_or_dir, (list, tuple)):
        return [(str(Path(n)), base / n) for n in names_or_dir]
    return [(str(p.relative_to(base)), p) for p in sorted(Path(names_or_dir).rglob("*")) if p.is_file()]


def interface_hash(config):
    """The page interface: shared web files, the single-file builder and both configs."""
    files = []
    files += [(f"core/{n}", p) for n, p in _tree(CORE / "web", CORE / "web")]
    if config.web_dir and Path(config.web_dir).is_dir():
        files += [(f"{config.name}/{n}", p) for n, p in _tree(config.web_dir, config.web_dir)]
    files += [("core/build_static.py", CORE / "build_static.py"), ("core/config.py", CORE / "config.py")]
    cfg = REPO / "trackers" / config.name / "config.py"
    files.append((f"{config.name}/config.py", cfg))
    return _sha(files)


def _label(root, d):
    d, root = Path(d), Path(root)
    try:
        return d.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(d)


def _abs(root, p):
    p = Path(p)
    return p if p.is_absolute() else Path(root) / p


def fingerprint(entry, adapter, config):
    """(fingerprint, parts) for the entry's inputs as they are on disk now."""
    root = Path(adapter.root)
    dirs, decisions = {}, {}
    for d in adapter.resolve_dirs(entry):
        d = _abs(root, d)
        label = _label(root, d)
        dirs[label] = _sha([(n, d / n) for n in adapter.staged_files(d)])
        decisions[label] = _sha([(n, d / n) for n in adapter.decision_files])
    builder = _sha([(str(p), _abs(root, p)) for p in adapter.builder_files])
    parts = {"interface": interface_hash(config), "builder": builder}
    parts.update(adapter.extra_inputs(entry) if adapter.extra_inputs else {})
    parts["dirs"], parts["decisions"] = dirs, decisions
    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest(), parts


def _date(name):
    m = re.search(r"\d{8}", str(name))
    return m.group(0) if m else str(name)


def reasons(old, new):
    """Plain-word reasons the page built from `old` parts differs from `new`. Staged-work reasons come
    before decision reasons, because the first kind is what reviewers are waiting for."""
    out = []
    for k in ("interface", "builder"):
        if old.get(k) != new.get(k):
            out.append(f"{k} changed")
    for k in sorted((set(old) | set(new)) - {"interface", "builder", "dirs", "decisions"}):
        if old.get(k) != new.get(k):
            out.append(f"{k} changed ({_date(old.get(k))} to {_date(new.get(k))})" if k == "snapshot" else f"{k} changed")
    od, nd = old.get("dirs", {}), new.get("dirs", {})
    out += [f"new staging dir {d}" for d in sorted(set(nd) - set(od))]
    out += [f"staging dir gone {d}" for d in sorted(set(od) - set(nd))]
    out += [f"staged work changed in {d}" for d in sorted(set(od) & set(nd)) if od[d] != nd[d]]
    odec, ndec = old.get("decisions", {}), new.get("decisions", {})
    out += [f"decisions changed in {d}" for d in sorted(set(odec) & set(ndec)) if odec[d] != ndec[d]]
    return out


def check(entries, adapter, config):
    """One report per entry: {name, kind, url, status: fresh|stale|unmarked, reasons, fingerprint, parts}."""
    out = []
    for e in entries:
        fp, parts = fingerprint(e, adapter, config)
        pub = e.get("published") or {}
        rep = {"name": e.get("name"), "kind": e.get("kind", "artifact"), "url": e.get("url", ""),
               "fingerprint": fp, "parts": parts, "reasons": []}
        if not pub.get("fingerprint"):
            rep["status"] = "unmarked"
        elif pub["fingerprint"] == fp:
            rep["status"] = "fresh"
        else:
            rep["status"], rep["reasons"] = "stale", reasons(pub.get("parts", {}), parts)
        out.append(rep)
    return out


def load_entries(path):
    return json.loads(Path(path).read_text(encoding="utf-8")).get("pages", [])


def current_profile():
    """'gem' when running under the work config dir, else 'personal'."""
    return "gem" if os.environ.get("CLAUDE_CONFIG_DIR", "").rstrip("/").endswith(".claude-gem") else "personal"


def record_build(path, name, fp, parts, built, file=None):
    """Remember what a build of page `name` was made from, for mark_published."""
    p = Path(path)
    cur = json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {}
    cur[name] = {"built": built, "fingerprint": fp, "parts": parts, "file": str(file) if file else None}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cur, indent=2, sort_keys=True), encoding="utf-8")


def _fmt(v, ind):
    pad = "  " * ind
    if isinstance(v, dict):
        flat = json.dumps(v, ensure_ascii=False)
        if all(not isinstance(x, (dict, list)) for x in v.values()) and len(flat) <= 80:
            return flat
        body = ",\n".join(f'{pad}  {json.dumps(k, ensure_ascii=False)}: {_fmt(x, ind + 1)}' for k, x in v.items())
        return "{\n" + body + "\n" + pad + "}"
    if isinstance(v, list) and any(isinstance(x, (dict, list)) for x in v):
        return "[\n" + ",\n".join(f"{pad}  {_fmt(x, ind + 1)}" for x in v) + "\n" + pad + "]"
    return json.dumps(v, ensure_ascii=False)


def _entry_span(text, name):
    """(start, end) of the object in "pages" whose "name" is `name`, string-aware so braces in values are safe."""
    starts, depth, i, in_str = [], 0, 0, False
    spans = []
    while i < len(text):
        c = text[i]
        if in_str:
            if c == "\\":
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            starts.append(i)
            depth += 1
        elif c == "}":
            s = starts.pop()
            depth -= 1
            spans.append((s, i + 1, depth))
        i += 1
    for s, e, depth in spans:
        if depth == 1:
            try:
                if json.loads(text[s:e]).get("name") == name:
                    return s, e
            except ValueError:
                pass
    raise KeyError(name)


def mark_published(entries_path, name, last_build_path, adapter, config, now=None, profile=None):
    """Record the last build of page `name` as the published state. Refuses (PublishError) when the
    inputs changed since that build. Only the named entry's text is rewritten; the rest of the file is left byte-identical."""
    from datetime import datetime
    entries_path = Path(entries_path)
    text = entries_path.read_text(encoding="utf-8")
    entry = next((e for e in json.loads(text).get("pages", []) if e.get("name") == name), None)
    if entry is None:
        raise KeyError(name)
    last = json.loads(Path(last_build_path).read_text(encoding="utf-8")).get(name)
    if not last:
        raise PublishError(f"no recorded build of {name}: run build_all.py first")
    fp, parts = fingerprint(entry, adapter, config)
    if fp != last["fingerprint"]:
        raise PublishError(f"{name} changed since it was built ({'; '.join(reasons(last['parts'], parts)) or 'inputs differ'}): build again")
    entry = {k: v for k, v in entry.items() if k != "published"}
    entry["published"] = {"built": last["built"], "at": now or datetime.now().astimezone().isoformat(timespec="seconds"),
                          "profile": profile or current_profile(), "fingerprint": fp, "parts": last["parts"]}
    s, e = _entry_span(text, name)
    line_start = text.rfind("\n", 0, s) + 1
    ind = (s - line_start) // 2
    entries_path.write_text(text[:s] + _fmt(entry, ind) + text[e:], encoding="utf-8")
    return entry["published"]
