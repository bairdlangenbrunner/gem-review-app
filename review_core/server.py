"""
The shared loopback review server. Standard library only; it binds a loopback address and refuses anything else (the data is unreleased).

    GET  /                  the page (review_core/web/index.html, titled for the tracker)
    GET  /core/<file>       a file from review_core/web
    GET  /tracker/<file>    a file from the tracker's web folder (a missing ext.css or ext.js is served empty)
    GET  /asset/<name>      a picture from <root>/work/review_assets (names the assets module made: <sha256>.jpg or .png)
    GET  /api/data          the dataset with every staging dir's decisions laid over it (gzip when asked)
    GET  /api/whoami        {"reviewer", "caps", "store"}
    GET  /api/decisions?dir=<label>   that staging dir's latest record per key
    POST /api/decide        line decisions; reviewer and ts are stamped here, never taken from the client
    POST /api/item          item calls
    POST /api/<type>        one route per tracker record type and marker (GOGPT: /api/flag)

main() is the command line both researcher repos share (see its docstring). A tracker adds routes through config.routes(app) and caps through config.caps and config.dynamic_caps(app). Answers: 400 when the store refuses a request, the status a Refusal names, 502 when the decision store cannot be written (nothing saved anywhere), 500 for any other failed write (the logs were rolled back).
"""
import argparse
import gzip
from html import escape
import ipaddress
import json
import mimetypes
import re
import subprocess
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote, urlsplit

from review_core.assets import ASSET_RE, asset_dir
from review_core.store import Invalid

CORE_WEB = Path(__file__).resolve().parent / "web"
OPTIONAL_EXT = ("ext.css", "ext.js")


def ensure_loopback(host):
    """Raise ValueError unless `host` is a loopback address."""
    if host == "localhost":
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise ValueError(f"refusing to bind {host!r}: the review server is loopback-only")


class Refusal(Exception):
    """A request a tracker route turns down: (HTTP status, message)."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def as_api(api):
    """The bound store as attributes, whether given as bind()'s dict or a shim module."""
    return SimpleNamespace(**api) if isinstance(api, dict) else api


def page_html(config):
    """index.html with the tracker's title in <title> and the first <h1>."""
    html = (CORE_WEB / "index.html").read_text(encoding="utf-8")
    title = escape(config.title, quote=False)
    html = html.replace("{{title}}", title)
    html = re.sub(r"<title>.*?</title>", lambda m: f"<title>{title}</title>", html, count=1, flags=re.S)
    html = re.sub(r"(<h1[^>]*>).*?(</h1>)", lambda m: m.group(1) + title + m.group(2), html, count=1, flags=re.S)
    return html


class App:
    """Server state: the dataset, who is reviewing, and where decisions are written.

    `api` is the store bound to the tracker (review_core.store.bind, or a shim module that holds
    it). `ledger` is the researcher repo's ledger (the Google store first) or None for the sidecars
    alone; `scope_of(dataset)` gives the (scope, snapshot) the ledger stamps; `store_errors` are
    the ledger's "store unreachable" exceptions (answered 502)."""

    def __init__(self, data_path, reviewer, api, root=None, ledger=None, scope_of=None, store_errors=()):
        self.api = as_api(api)
        self.config = self.api.CONFIG
        self.data_path = Path(data_path)
        self.reviewer = self.api.initials(reviewer)     # people are recorded by initials
        self.root = Path(root) if root else Path(self.api.ROOT)
        self.ledger = ledger
        self.scope_of = scope_of
        self.store_errors = tuple(store_errors)
        self.lock = threading.Lock()
        self.load()

    def load(self):
        raw = self.data_path.read_bytes()
        self.data = json.loads(raw.decode("utf-8"))   # refuse to serve a file that is not JSON

    def dirs(self):
        return self.api.dir_paths(self.data, self.root)

    def sink(self, origin="local"):
        """The write path for the store: the ledger's (store first), or None for the sidecars alone."""
        if self.ledger is None:
            return None
        self.ledger.origin = origin
        if self.scope_of:
            self.ledger.scope, self.ledger.snapshot = self.scope_of(self.data)
        return self.ledger.sink

    def current(self):
        """(raw, gz) of the dataset with every staging dir's sidecars laid over it right now."""
        with self.lock:
            self.api.overlay(self.data, self.dirs())
            raw = json.dumps(self.data, ensure_ascii=False).encode("utf-8")
        return raw, gzip.compress(raw, 6)

    def decide(self, records):
        """The overlay runs first so calls a decision owes see every item call made since the last
        /api/data. The dataset on disk is never rewritten."""
        with self.lock:
            self.api.overlay(self.data, self.dirs())
            return self.api.decide(records, self.data, self.reviewer, self.dirs(), sink=self.sink())

    def item(self, records):
        with self.lock:
            return self.api.record_items(records, self.data, self.reviewer, self.dirs(), sink=self.sink())

    def record(self, name, records):
        """Records of a tracker record type or marker (GOGPT: flag)."""
        fn = getattr(self.api, f"record_{name}s")
        with self.lock:
            return fn(records, self.data, self.reviewer, self.dirs(), sink=self.sink())

    def decisions(self, label):
        d = self.dirs().get(label)
        if d is None:
            return None
        return self.api.latest(self.api.read_log(d))

    def caps(self):
        caps = dict(self.config.caps)
        if self.config.dynamic_caps:
            caps.update(self.config.dynamic_caps(self))
        return caps

    def whoami(self):
        return {"reviewer": self.reviewer, "caps": self.caps(), "store": self.ledger is not None}

    def post_routes(self):
        """POST path to handler for the core write routes and one per record type."""
        out = {"/api/decide": self.decide, "/api/item": self.item}
        for name in getattr(self.api, "RECORD_TYPES", {}):
            out[f"/api/{name}"] = (lambda n: lambda body: self.record(n, body))(name)
        return out

    def tracker_routes(self):
        return list(self.config.routes(self)) if self.config.routes else []


def _match(routes, method, path):
    for m, p, fn in routes:
        if m == method and (path == p or (p.endswith("/") and path.startswith(p))):
            return fn
    return None


def make_handler(app, server_version="gem_review_app/1"):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

        def _host_ok(self):
            # DNS-rebinding guard: only answer requests addressed to a loopback host
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
            try:
                ensure_loopback(host)
                return True
            except ValueError:
                return False

        def _send(self, body, ctype, status=HTTPStatus.OK, extra=None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            if not extra or "Cache-Control" not in extra:
                self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, status=HTTPStatus.OK):
            self._send(json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

        send_json = _json

        def _file(self, base, rel, suffixes=None, optional=False):
            """Serve base/rel if it resolves inside base (no traversal, no symlink escape). An
            optional file that is missing is served empty."""
            ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            if base is None:
                return self._send(b"", ctype) if optional else self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            base = Path(base).resolve()
            try:
                f = (base / rel).resolve()
            except (OSError, ValueError):
                return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            if base not in f.parents or not f.is_file() or (suffixes and f.suffix.lower() not in suffixes):
                if optional and base in f.parents:
                    return self._send(b"", ctype)
                return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            if f.suffix.lower() == ".geojson":
                ctype = "application/geo+json"
            self._send(f.read_bytes(), ctype)

        serve_file = _file

        def _asset(self, name):
            """Serve a content-addressed picture: only a name the assets module makes, only from its folder."""
            if not ASSET_RE.match(name):
                return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            base = asset_dir(app.root).resolve()
            f = (base / name).resolve()
            if base not in f.parents or not f.is_file():
                return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            self._send(f.read_bytes(), "image/png" if name.endswith(".png") else "image/jpeg",
                       extra={"Cache-Control": "public, max-age=31536000, immutable"})

        def body(self):
            """The request body as JSON (ValueError when it is not JSON)."""
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n).decode("utf-8") or "null")

        @property
        def query(self):
            return parse_qs(urlsplit(self.path).query)

        def _run(self, fn, *args):
            try:
                out = fn(*args)
            except Refusal as e:
                return self._json({"error": str(e)}, e.status)
            except Invalid as e:
                return self._json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
            except app.store_errors as e:      # the store refused: nothing recorded anywhere
                print(f"review app: decision store unreachable: {e}", file=sys.stderr)
                return self._json({"error": f"decision store unreachable, nothing saved: {e}"}, HTTPStatus.BAD_GATEWAY)
            except (ValueError, UnicodeDecodeError) as e:
                return self._json({"error": f"bad request: {e}"}, HTTPStatus.BAD_REQUEST)
            except Exception as e:     # a failed write (the logs were rolled back): say so loudly
                print(f"review app: {self.path} failed: {e!r}", file=sys.stderr)
                return self._json({"error": f"write failed: {e}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            if out is not None:
                return self._json(out)

        def do_GET(self):
            if not self._host_ok():
                return self._json({"error": "bad host"}, HTTPStatus.FORBIDDEN)
            path = unquote(self.path.split("?", 1)[0])
            if path == "/api/data":
                raw, gz = app.current()
                if "gzip" in (self.headers.get("Accept-Encoding") or ""):
                    return self._send(gz, "application/json; charset=utf-8", extra={"Content-Encoding": "gzip"})
                return self._send(raw, "application/json; charset=utf-8")
            if path == "/api/whoami":
                return self._json(app.whoami())
            if path == "/api/decisions":
                label = (self.query.get("dir") or [""])[0]
                recs = app.decisions(label)
                if recs is None:
                    return self._json({"error": "unknown dir"}, HTTPStatus.NOT_FOUND)
                return self._json({"dir": label, "decisions": recs})
            fn = _match(app.tracker_routes(), "GET", path)
            if fn:
                return self._run(fn, self)
            if path.startswith("/api/"):
                return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            if path in ("/", "", "/index.html"):
                if not (CORE_WEB / "index.html").is_file():
                    return self._json({"error": "the page is missing: review_core/web/index.html"}, HTTPStatus.NOT_FOUND)
                return self._send(page_html(app.config).encode("utf-8"), "text/html; charset=utf-8")
            if path.startswith("/core/"):
                return self._file(CORE_WEB, path[len("/core/"):])
            if path.startswith("/asset/"):
                return self._asset(path[len("/asset/"):])
            if path.startswith("/tracker/"):
                rel = path[len("/tracker/"):]
                return self._file(app.config.web_dir, rel, optional=rel in OPTIONAL_EXT)
            return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)

        def do_POST(self):
            if not self._host_ok():
                return self._json({"error": "bad host"}, HTTPStatus.FORBIDDEN)
            path = unquote(self.path.split("?", 1)[0])
            core = app.post_routes()
            if path in core:
                try:
                    body = self.body()
                except (ValueError, UnicodeDecodeError):
                    return self._json({"error": "body is not JSON"}, HTTPStatus.BAD_REQUEST)
                return self._run(lambda: {"saved": core[path](body)})
            fn = _match(app.tracker_routes(), "POST", path)
            if fn:
                return self._run(fn, self)
            return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    Handler.server_version = server_version
    return Handler


def make_server(app, host="127.0.0.1", port=None, server_version="gem_review_app/1"):
    ensure_loopback(host)
    return ThreadingHTTPServer((host, app.config.port if port is None else port), make_handler(app, server_version))


def git_user(root):
    """git config user.name in `root`, or "reviewer"."""
    try:
        return subprocess.run(["git", "config", "user.name"], capture_output=True, text=True,
                              cwd=root).stdout.strip() or "reviewer"
    except OSError:
        return "reviewer"


def main(argv=None, *, description, port, add_args, build_argv, build_data, make_app, make_server, pull, ledger,
         data_default, git_root, no_store_note, auth_hint, where):
    """The server command line both researcher repos share. The repo's review_app/server.py passes its hooks:

    add_args(ap)               the arguments that pick the dataset
    build_argv(args, data_path) the review_data.main arguments for a build (SystemExit when the arguments cannot build)
    build_data(argv)           review_data.main
    make_app(data_path, reviewer, build, led) the repo's App; `build` is None with --no-build
    make_server(app, host, port) the repo's make_server
    pull, ledger               the repo's bound pull and ledger modules
    data_default               the dataset path without --data (work/review_data.json)
    git_root                   where git_user reads user.name
    no_store_note              what --no-store prints on stderr
    auth_hint                  what to do when the store account's address cannot be read
    where(led)                 the startup line's middle part: where decisions are written

    The common arguments are --data, --reviewer, --reviewer-email, --no-store, --host, --port, --no-open and --no-build. A non-loopback --host stops before anything is built."""
    ap = argparse.ArgumentParser(description=description)
    add_args(ap)
    ap.add_argument("--data", default=None, help="dataset path (default work/review_data.json)")
    ap.add_argument("--reviewer", default=None, help="default: git config user.name; recorded as initials (store.initials)")
    ap.add_argument("--reviewer-email", default=None,
                    help="the address written on this person's rows in the Google decision store "
                         "(default: the gws-gem-write account's address)")
    ap.add_argument("--no-store", action="store_true",
                    help="DEV/TESTS ONLY: write the staging-dir sidecars alone, skipping the Google decision store")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=port)
    ap.add_argument("--no-open", action="store_true", help="do not open the browser")
    ap.add_argument("--no-build", action="store_true", help="serve --data as it is; do not rebuild")
    args = ap.parse_args(argv)
    try:
        ensure_loopback(args.host)
    except ValueError as e:
        raise SystemExit(str(e))
    data_path = Path(args.data) if args.data else Path(data_default)
    build = None
    if not args.no_build:
        build = build_argv(args, data_path)
        build_data(build)
    elif not data_path.exists():
        raise SystemExit(f"{data_path} not found: run without --no-build, or pass --data")
    led = None
    if args.no_store:
        print(f"review app: --no-store: {no_store_note}", file=sys.stderr)
    else:
        cfg = pull.config()
        if not cfg.get("store_sheet_id"):
            raise SystemExit("no decision store configured (review_app/google.json: store_sheet_id); "
                             "pass --no-store only for dev/tests")
        email = args.reviewer_email or ledger.whoami()
        if not email:
            raise SystemExit(f"cannot read the store account's address (gws-gem-write auth?): pass --reviewer-email, {auth_hint}")
        data0 = json.loads(data_path.read_text(encoding="utf-8"))
        led = ledger.Ledger(cfg["store_sheet_id"], *ledger.scope_of(data0), "local", reviewer_email=email)
    app = make_app(data_path, args.reviewer or git_user(git_root), build, led)
    httpd = make_server(app, args.host, args.port)
    url = f"http://{args.host}:{httpd.server_address[1]}/"
    print(f"review app: {url}  (reviewer: {app.reviewer}; {where(led)}; Ctrl-C to stop)", file=sys.stderr)
    if not args.no_open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
