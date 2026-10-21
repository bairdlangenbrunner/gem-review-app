"""
Published-page registry logic: what a live review page was built from, and whether it is still current.

A review page is a snapshot. Each researcher repo keeps `review_app/artifacts.json` ({"pages": [entry, ...]}) with one entry per live page, and this module answers "is that page stale, and why" from content hashes (never the network). A file's size and modification time only decide whether it must be read and hashed again (FileCache); the fingerprint is always the hash of the content, so a touched file with the same bytes is still fresh. The core never imports from a researcher repo: the repo passes a PageAdapter that knows where its staged files, decision logs and builder live. `cli` is the whole `build_all.py` command line both repos share. See docs/refresh.md.

An entry's `published` block holds what the live page was built from:

    {"built": ts, "at": ts, "profile": "gem"|"personal", "fingerprint": sha, "parts": {...}}

`parts` is {"interface": sha, "builder": sha, "dirs": {label: sha}, "decisions": {label: sha}, **extra_inputs}. `fingerprint` is the hash of `parts`; `parts` exists so a check can say which input changed.
"""
import argparse
from dataclasses import dataclass
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Callable, Optional

CORE = Path(__file__).resolve().parent
REPO = CORE.parent
LAST_BUILD = "work/review_pages_last_build.json"
CACHE = ".review_pages_cache.json"          # FileCache file name, kept in the repo's gitignored work dir
GOOGLE_REFRESH = "python review_app/publish.py --upload --yes"


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
    cache -> a FileCache, so files whose size and modification time did not change are not read again (None: read every file).
    """
    root: Path
    resolve_dirs: Callable
    staged_files: Callable
    decision_files: tuple = ("review_log.jsonl",)
    extra_inputs: Optional[Callable] = None
    builder_files: tuple = ()
    build: Optional[Callable] = None
    cache: Optional["FileCache"] = None


class FileCache:
    """Values worked out from files (a group of files' sha256, or a few fields read from one file), remembered by each file's path, size and modification time.

    When every file behind a value has the same size and modification time as last time, the value is reused without reading the files. Any change to either, including a plain `touch`, means the files are read again, so a touched file still counts as changed for the cache (its fingerprint only changes when its bytes do). With a `path` the cache is kept as JSON between runs; `save` writes only the entries this run used, so files that left every page drop out on their own. Without a path it lasts for the process.
    """
    VERSION = 1

    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.old, self.used = {}, {}
        if self.path and self.path.is_file():
            try:
                body = json.loads(self.path.read_text(encoding="utf-8"))
                if body.get("version") == self.VERSION:
                    self.old = body.get("entries") or {}
            except (OSError, ValueError):
                pass

    def value(self, kind, files, work):
        """The cached value for `files` ([(name, path)]), or work() when any file's size or modification time changed. A missing file counts as part of the stamp, so a file appearing or going away is a change too."""
        names, stamp = [], []
        for name, p in files:
            ap = os.path.abspath(p)
            names.append(f"{name}\t{ap}")
            try:
                st = os.stat(ap)
                stamp.append([st.st_size, st.st_mtime_ns])
            except OSError:
                stamp.append(None)
        key = kind + "\n" + "\n".join(names)
        hit = self.used.get(key) or self.old.get(key)
        val = hit[1] if hit and hit[0] == stamp else work()
        self.used[key] = [stamp, val]
        return val

    def file(self, kind, path, read):
        """read(path) for one file, cached the same way."""
        return self.value(kind, [("", path)], lambda: read(Path(path)))

    def save(self):
        """Write the entries this run used (atomically). A cache that cannot be written is skipped: it only saves time."""
        if not self.path or self.used == self.old:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + f".{os.getpid()}.tmp")
            tmp.write_text(json.dumps({"version": self.VERSION, "entries": self.used}), encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError:
            pass


def _sha_files(paths):
    h = hashlib.sha256()
    for name, p in sorted(paths):
        if Path(p).is_file():
            h.update(name.encode() + b"\0" + Path(p).read_bytes() + b"\0")
    return h.hexdigest()


def _sha(paths, cache=None):
    """sha256 over (relative name, content) of the existing files, in sorted-name order. With a cache, files whose size and modification time are unchanged are not read again; the hash is the same either way."""
    paths = sorted((n, Path(p)) for n, p in paths)
    if cache is None:
        return _sha_files(paths)
    return cache.value("sha", paths, lambda: _sha_files(paths))


def sha_file(path, cache=None):
    """sha256 of one file ('' when it is missing); handy for an adapter's extra_inputs. A FileCache skips the read when the file is unchanged."""
    def read(p):
        return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else ""
    return read(Path(path)) if cache is None else cache.file("file-sha", path, read)


def _tree(base, names_or_dir):
    base = Path(base)
    if isinstance(names_or_dir, (list, tuple)):
        return [(str(Path(n)), base / n) for n in names_or_dir]
    return [(str(p.relative_to(base)), p) for p in sorted(Path(names_or_dir).rglob("*")) if p.is_file()]


def interface_hash(config, cache=None):
    """The page interface: shared web files, the single-file builder and both configs."""
    files = []
    files += [(f"core/{n}", p) for n, p in _tree(CORE / "web", CORE / "web")]
    if config.web_dir and Path(config.web_dir).is_dir():
        files += [(f"{config.name}/{n}", p) for n, p in _tree(config.web_dir, config.web_dir)]
    files += [("core/build_static.py", CORE / "build_static.py"), ("core/config.py", CORE / "config.py")]
    cfg = REPO / "trackers" / config.name / "config.py"
    files.append((f"{config.name}/config.py", cfg))
    return _sha(files, cache)


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
    cache = adapter.cache
    dirs, decisions = {}, {}
    for d in adapter.resolve_dirs(entry):
        d = _abs(root, d)
        label = _label(root, d)
        dirs[label] = _sha([(n, d / n) for n in adapter.staged_files(d)], cache)
        decisions[label] = _sha([(n, d / n) for n in adapter.decision_files], cache)
    builder = _sha([(str(p), _abs(root, p)) for p in adapter.builder_files], cache)
    parts = {"interface": interface_hash(config, cache), "builder": builder}
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


LOCK = ".review_publish.lock"             # in the work dir: which session is between a build and its --mark-published
LOCK_TTL = 15 * 60                         # seconds; a lock older than this is abandoned and may be taken over


class LockHeld(Exception):
    """Another session is between a build and its publish of these pages."""

    def __init__(self, lock):
        self.lock = lock
        super().__init__(f"another session is publishing {', '.join(lock['pages'])} since {lock['started'][11:16]} "
                         f"(session {lock['session'][:8]}, lock {lock['path']}): let it finish, or --force-lock to take over")


def session_id():
    """This Claude Code session's id (CLAUDE_CODE_SESSION_ID), else the process id."""
    return os.environ.get("CLAUDE_CODE_SESSION_ID") or f"pid-{os.getpid()}"


def lock_path(work):
    return Path(work) / LOCK


def read_lock(work, now=None):
    """The live lock as a dict (session, pid, started, pages, path), or None when there is none, it is unreadable, or it is older than LOCK_TTL."""
    from datetime import datetime
    p = lock_path(work)
    if not p.is_file():
        return None
    try:
        lock = json.loads(p.read_text(encoding="utf-8"))
        started = datetime.fromisoformat(lock["started"])
    except (ValueError, KeyError, TypeError):
        return None
    now = now or datetime.now().astimezone()
    if (now - started).total_seconds() > LOCK_TTL:
        return None
    lock["path"] = str(p)
    return lock


def acquire_lock(work, pages_, session=None, force=False, now=None):
    """Take the publish lock for `pages_` (names). Raises LockHeld when another session holds a live one, unless `force`. A session re-taking its own lock refreshes it and adds the pages."""
    from datetime import datetime
    session = session or session_id()
    live = read_lock(work, now)
    names = list(pages_)
    if live and live["session"] == session:
        names = live["pages"] + [n for n in names if n not in live["pages"]]
    elif live and not force:
        raise LockHeld(live)
    lock = {"session": session, "pid": os.getpid(), "started": (now or datetime.now().astimezone()).isoformat(timespec="seconds"),
            "pages": names}
    p = lock_path(work)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(lock), encoding="utf-8")
    tmp.replace(p)
    lock["path"] = str(p)
    return lock


def release_lock(work, page=None, session=None):
    """Drop `page` (or every page) from this session's lock; the file goes when nothing is left. Another session's lock is never touched. Returns True when the file was removed."""
    session = session or session_id()
    p = lock_path(work)
    live = read_lock(work)
    if live is None:
        if p.is_file() and page is None:
            p.unlink()          # expired leftovers
        return not p.is_file()
    if live["session"] != session:
        return False
    rest = [n for n in live["pages"] if page is not None and n != page]
    if rest:
        live["pages"] = rest
        p.write_text(json.dumps({k: v for k, v in live.items() if k != "path"}), encoding="utf-8")
        return False
    p.unlink()
    return True


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


def mark_current(entries_path, name, last_build_path, adapter, config, built):
    """Record the inputs as they are now as what page `name` was built from, then mark it published. For a page whose own publish step already ran its pull and build (the Google page: publish.py after a successful upload)."""
    entry = next((e for e in load_entries(entries_path) if e["name"] == name), None)
    if entry is None:
        raise KeyError(name)
    fp, parts = fingerprint(entry, adapter, config)
    record_build(last_build_path, name, fp, parts, built)
    return mark_published(entries_path, name, last_build_path, adapter, config)


def _url(e):
    return e.get("url", "")


def cli(adapter, registry, build_page, argv=None, *, config, last_build, work, description="",
        columns=(("url", _url),), pull=None):
    """The `build_all.py` command line both researcher repos share. Flags:

        --check               fresh / stale (why) / unmarked per page; exit 1 if any is not fresh
        [--only NAME] [--all] build the stale or unmarked artifact pages (--all: every one), then print name, columns, file
        --no-pull             build without reading the Google decision store first
        --list                the page table: name, columns, published at
        --mark-published NAME after publishing NAME's file to its url; releases this session's publish lock on NAME
        --force-lock          build even while another session holds the publish lock (its build is abandoned)
        --hook EVENT          Claude Code hook mode: prints the JSON contract of hooks.hook

    adapter: the repo's PageAdapter (its cache, when set, is saved after each full check). registry: review_app/artifacts.json. build_page(entry, args) -> (file, built timestamp) builds one artifact page; `args.no_pull` says whether it may pull. pull(args), when given, runs before the stale check of a build, so decisions pulled into the local logs count as inputs (gogpt). Without it the build does its own pull (pipelines' build_static, which warns and goes on from the local logs when the pull fails). columns: [(header, entry -> text)] shown after the name. A google page is never built here: the build prints its refresh command, and --mark-published refuses it because that command marks it itself.

    One session publishes at a time: a build takes `work/.review_publish.lock` (this session's id, the pages being built) before it writes anything, and `--mark-published` releases it. While another session holds a live lock (younger than LOCK_TTL) the build exits 3 with that session's id and start time, so two sessions never build the same html and race for the artifact. A build that fails releases the lock itself; a session that never marks leaves it to expire.
    """
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--only", help="build just this page name")
    ap.add_argument("--all", action="store_true", help="build every page, not just the stale or unmarked ones")
    ap.add_argument("--check", action="store_true", help="report which pages are stale; exit 1 if any is not fresh")
    ap.add_argument("--mark-published", metavar="NAME", help="record the last build of NAME as published")
    ap.add_argument("--no-pull", action="store_true", help="build without first pulling the decision store into the local logs")
    ap.add_argument("--force-lock", action="store_true", help="build even while another session holds the publish lock")
    ap.add_argument("--list", action="store_true", help="print the page table from artifacts.json")
    ap.add_argument("--hook", metavar="EVENT", help="Claude Code hook mode (SessionStart, UserPromptSubmit, Stop)")
    a = ap.parse_args(argv)

    def reports():
        out = check(load_entries(registry), adapter, config)
        if adapter.cache is not None:
            adapter.cache.save()
        return out

    if a.hook:
        from review_core import hooks
        stdin = sys.stdin.read()
        try:
            reps = reports()
        except Exception as e:      # a hook must not break the session: say what failed instead
            print(hooks.failed(a.hook, e))
            return 0
        print(hooks.hook(a.hook, stdin, reps, work))
        return 0
    if a.mark_published:
        name = a.mark_published
        entry = next((e for e in load_entries(registry) if e["name"] == name), None)
        if entry and entry.get("kind") == "google":
            raise SystemExit(f"{name} is the Google page: {GOOGLE_REFRESH} marks it")
        try:
            pub = mark_published(registry, name, last_build, adapter, config)
        except (PublishError, KeyError) as e:
            raise SystemExit(f"not marked: {e}")
        print(f"{name} marked published ({pub['profile']} profile, built {pub['built']})"
              + ("; publish lock released" if release_lock(work, name) else ""))
        return 0
    if a.list:
        print("\t".join(["name", *[h for h, _ in columns], "published at"]))
        for e in load_entries(registry):
            print("\t".join([e["name"], *[str(f(e)) for _, f in columns], (e.get("published") or {}).get("at", "")]))
        return 0
    if a.check:
        bad = False
        for r in reports():
            print(f"{r['name']}\t{r['status']}" + (f"\t{'; '.join(r['reasons'])}" if r["reasons"] else ""))
            bad = bad or r["status"] != "fresh"
        live = read_lock(work)
        if live:
            who = "this session" if live["session"] == session_id() else f"session {live['session'][:8]}"
            print(f"lock\t{who} is publishing {', '.join(live['pages'])} since {live['started'][11:16]}")
        sys.exit(1 if bad else 0)
    if pull:
        pull(a)        # before the stale check: pulled calls change what a page is built from
    entries = load_entries(registry)
    if a.only:
        entries = [e for e in entries if e["name"] == a.only]
        if not entries:
            raise SystemExit(f"no page named {a.only} in artifacts.json")
    elif not a.all:
        todo = {r["name"] for r in reports() if r["status"] != "fresh"}
        entries = [e for e in entries if e["name"] in todo]
    if not entries:
        print("every page is fresh; nothing to build (--all to rebuild anyway)")
        return 0
    rows = []
    artifact = [e for e in entries if e.get("kind") != "google"]
    for e in entries:
        if e.get("kind") == "google":
            print(f"{e['name']}\tgoogle\trefresh with: {GOOGLE_REFRESH} (ask Baird first)")
    if not artifact:
        return 0
    try:
        acquire_lock(work, [e["name"] for e in artifact], force=a.force_lock)
    except LockHeld as e:
        print(f"not built: {e}", file=sys.stderr)
        sys.exit(3)
    try:
        for e in artifact:
            out, built = build_page(e, a)
            fp, parts = fingerprint(e, adapter, config)     # after the build: a build that pulls rewrites the logs it reads
            record_build(last_build, e["name"], fp, parts, built, out)
            rows.append([e["name"], *[str(f(e)) for _, f in columns], str(out)])
    except BaseException:
        release_lock(work)          # nothing to publish from this run; do not keep others waiting
        raise
    for r in rows:
        print("\t".join(r))
    return 0
