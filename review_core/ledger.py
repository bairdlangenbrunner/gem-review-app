"""
The decision ledger: the code both researcher repos share. The ledger is the `log` tab of the store spreadsheet (review_app/google.json: store_sheet_id), one row per record. Everything that writes a staging dir's review_log.jsonl writes to the store first and to the sidecars second, so the store holds every decision and the sidecars are its committed mirror.

Rules
  * The store comes first. A record is appended to the sheet, read back by `id`, and only then written to the sidecar. If the store cannot be reached the decision is refused (StoreError, which the server turns into HTTP 502 and the CLI into exit 2) and nothing is written anywhere. There is no offline mode, because an offline decision is exactly the divergence the ledger exists to end. `--no-store` on server.py is for tests and dev only and says so on every start.
  * The store keeps the reviewer's email address; the sidecars keep initials (store.initials). Machine reviewers are kept as they are.
  * A record's `id` is a uuid4 stamped here. An id already present (a carry-forward's `~rekey`, or the id the artifact page gives every record) is kept, so pull.py's mirror, which dedupes by id, never writes the same record twice.
  * The sheet append is verified: the rows the API says it wrote are read again, and their `id` column must hold these records' ids. A mismatch (another writer landing on the same rows in the same instant) is retried once, then refused.
  * Records go to the sheet APPEND_CHUNK rows per gws call, because the rows ride on the command line and 2,323 of them overflowed it in the pipelines app (2026-10-14).

A researcher repo's review_app/ledger.py is a thin adapter. It defines the tracker's side of the ledger and then calls `bind(sys.modules[__name__], pull=pull, store=store)`:

    COLS          the `log` tab header, verbatim
    ORIGINS       the origins a record may carry
    row_of(rec)   one sheet row (len(COLS) strings) for a record; record_json(rec) gives its `json` column
    scope_of(data) (scope id, snapshot) of a built dataset

bind adds LOG_TAB, MAX_JSON, APPEND_CHUNK (unless the adapter set its own), StoreError, cell, stamp_fields, append, Ledger and whoami. The bound functions look the adapter's names up when they run (COLS, row_of, scope_of, ORIGINS, APPEND_CHUNK, and the adapter's pull and store modules), so a test can replace any of them on the adapter module.
"""
import json
import re
import uuid

MAX_JSON = 49000          # a cell holds 50k chars (Code.gs refuses a longer record too)
APPEND_CHUNK = 100        # rows per gws call (see the rules above)
_FORMULA = re.compile(r"^[=+\-@]")
_RANGE = re.compile(r"^'?(?P<tab>[^'!]+)'?!(?P<c1>[A-Z]+)(?P<r1>\d+)(?::(?P<c2>[A-Z]+)(?P<r2>\d+))?$")


class StoreError(RuntimeError):
    """The store could not be written (or read back as written): nothing was recorded anywhere."""


def cell(v):
    """A display column is never a formula and never longer than a cell (Code.gs cell_)."""
    s = "" if v is None else str(v)
    if _FORMULA.match(s):
        s = "'" + s
    return s[:2000] + "…" if len(s) > 2000 else s


def record_json(rec):
    """The `json` column of a record's row. Raises StoreError when the record is too long for a cell."""
    j = json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
    if len(j) > MAX_JSON:
        raise StoreError("a record is too long to store: shorten the note")
    return j


def _range_rows(rng):
    m = _RANGE.match(rng or "")
    if not m:
        raise StoreError(f"cannot read the range the store reports: {rng!r}")
    r1 = int(m.group("r1"))
    return r1, int(m.group("r2") or r1)


class Ledger:
    """A configured sink: `sink(recs, dirs, stamp=True)` has store._write's signature and is passed to store.decide, record_items, record_flags, sync_backend or append_records. `reviewer_email` is the address written on a person's store rows (the account that writes the store, by default). bind makes a subclass of this for each adapter, whose `_ns` is the adapter module."""

    _ns = None

    def __init__(self, sheet_id, scope, snapshot, origin, reviewer_email=None, gws=None, emails=None):
        if not sheet_id:
            raise ValueError("no store configured (review_app/google.json: store_sheet_id)")
        self.sheet_id, self.scope, self.snapshot, self.origin = sheet_id, scope, snapshot, origin
        self.reviewer_email = reviewer_email or ""
        self.emails = dict(emails or {})      # store record id -> address (pull.mirror's), for copies of others' records
        self.gws = gws or self._ns.pull.gws
        self.written = 0
        self.last_row = 0                     # the last store row this ledger wrote

    @classmethod
    def for_data(cls, data, origin, cfg=None, reviewer_email=None, gws=None):
        """A ledger for a built dataset, or None when no store is configured."""
        cfg = cls._ns.pull.config() if cfg is None else cfg
        sheet = (cfg or {}).get("store_sheet_id") or ""
        if not sheet:
            return None
        sid, snap = cls._ns.scope_of(data)
        return cls(sheet, sid, snap, origin, reviewer_email=reviewer_email, gws=gws)

    def to_store(self, rec):
        """The store's copy of a record: a person's initials become an address, the original decider's when this is a copy of a store record (`emails`, by the id before `~`), else the writer's. A machine reviewer is kept as is."""
        r = dict(rec)
        who = r.get("reviewer")
        if who and who not in self._ns.store.MACHINE_REVIEWERS:
            orig = self.emails.get(str(r.get("id") or "").split("~")[0])
            if orig or self.reviewer_email:
                r["reviewer"] = orig or self.reviewer_email
        return r

    def sink(self, recs, dirs, stamp=True):
        """Store first, sidecars second (the caller holds store._LOCK). Stamps id, scope, batch, snapshot and origin (and ts unless the records bring their own). The local copy keeps the initials and every stamped field, exactly what pull.mirror would write for the same store row, so a later pull dedupes it by id. Raises StoreError before anything local is written."""
        ns = self._ns
        store = ns.store
        recs = list(recs)
        if not recs:
            return []
        ts = store.now() if stamp else None
        for r in recs:
            if stamp:
                r["ts"] = ts
            r["reviewer"] = store.initials(r.get("reviewer"))
            if r["dir"] not in dirs:          # refuse an unknown dir BEFORE the store write, as _write would
                raise store.Invalid(f"staging dir not known to the server: {r['dir']}")
        ns.stamp_fields(recs, self.scope, self.snapshot, self.origin, ts=ts)
        rows = [self.to_store(r) for r in recs]
        first, last = ns.append(rows, self.sheet_id, gws=self.gws)
        store._write([dict(r) for r in recs], dirs, stamp=False)
        for r, s in zip(recs, rows):
            r["row"] = s.get("row")
        self.written += len(recs)
        self.last_row = max(self.last_row, last)
        return recs


def bind(into, *, pull, store):
    """Put the ledger API into the adapter module `into`, which already holds COLS, ORIGINS, row_of and scope_of. `pull` and `store` are the repo's bound pull and store modules. Returns `into`."""
    ns = into

    def stamp_fields(recs, scope, snapshot, origin, batch=None, ts=None):
        """Stamping for records written here (Code.gs write_'s): every record gets this `origin` and one `batch` uuid per call; `id`, `scope`, `snapshot` and `ts` are filled only where missing (a carry-forward or a record from the artifact page keeps the id, scope, snapshot and time it came with). Returns recs."""
        if origin not in ns.ORIGINS:
            raise ValueError(f"origin {origin!r} is not one of {ns.ORIGINS}")
        batch = batch or str(uuid.uuid4())
        ts = ts or ns.store.now()
        for r in recs:
            r["id"] = r.get("id") or str(uuid.uuid4())
            r["scope"] = r.get("scope") or scope
            r["batch"] = batch
            r["snapshot"] = r.get("snapshot") if r.get("snapshot") not in (None, "") else snapshot
            r["origin"] = origin
            if not r.get("ts"):
                r["ts"] = ts
        return recs

    def append(recs, sheet_id, gws=None, profile=None, read_profile=None, retries=1):
        """Append the records to the store's `log` tab, APPEND_CHUNK per call (see _append_chunk). Returns (first row, last row). A failure part way raises StoreError naming the chunks already in the store; those rows stand (the store is the source of truth, and a pull brings them home)."""
        if not recs:
            return None
        gws = gws or ns.pull.gws
        profile = profile or ns.pull.WRITE_PROFILE
        read_profile = read_profile or ns.pull.READ_PROFILE
        size = ns.APPEND_CHUNK
        first = last = None
        for i in range(0, len(recs), size):
            try:
                f, last = ns._append_chunk(recs[i:i + size], sheet_id, gws, profile, read_profile, retries)
            except StoreError as e:
                if i:
                    raise StoreError(f"{e} (records 1-{i} of {len(recs)} are already in the store, rows {first}-{last})") from e
                raise
            first = f if first is None else first
        return first, last

    def _append_chunk(recs, sheet_id, gws, profile, read_profile, retries):
        """Append the records to the store's `log` tab (one RAW row each, after the last row) and verify by reading the `id` column of the rows the API reports. Returns (first row, last row). Raises StoreError. There is nothing to clean up: a failed append wrote nothing we can rely on, and a verified mismatch means our rows were overwritten, so the retry appends again."""
        p = ns.pull
        cols = ns.COLS
        rows = [ns.row_of(r) for r in recs]
        ids = [r["id"] for r in recs]
        idc = p._col_letter(cols.index("id"))
        last_err = None
        for attempt in range(retries + 1):
            try:
                resp = gws(profile, "sheets", "spreadsheets", "values", "append",
                           "--params", json.dumps({"spreadsheetId": sheet_id, "range": f"{p.LOG_TAB}!A:{p._col_letter(len(cols) - 1)}",
                                                   "valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS",
                                                   "includeValuesInResponse": False}),
                           "--json", json.dumps({"majorDimension": "ROWS", "values": rows}, ensure_ascii=False))
            except p.GwsError as e:
                raise StoreError(f"the decision store could not be written: {e}") from e
            upd = (resp or {}).get("updates") or {}
            first, last = _range_rows(upd.get("updatedRange"))
            if last - first + 1 != len(rows):
                raise StoreError(f"the store reports {last - first + 1} rows written for {len(rows)} records ({upd.get('updatedRange')})")
            try:
                got = gws(read_profile, "sheets", "spreadsheets", "values", "get", "--params",
                          json.dumps({"spreadsheetId": sheet_id, "range": f"{p.LOG_TAB}!{idc}{first}:{idc}{last}",
                                      "majorDimension": "ROWS", "valueRenderOption": "UNFORMATTED_VALUE"}))
            except p.GwsError as e:
                raise StoreError(f"written to the store (rows {first}-{last}) but the read-back failed: {e}") from e
            back = [(r[0] if r else "") for r in (got.get("values") or [])]
            back += [""] * (len(ids) - len(back))
            if back == ids:
                for r, i in zip(recs, range(first, last + 1)):
                    r["row"] = i
                return first, last
            last_err = StoreError(f"the store's rows {first}-{last} do not hold these records after the append "
                                  f"(another writer landed on them); " + ("retried once" if attempt else "retrying"))
        raise last_err

    def whoami(gws=None, profile=None):
        """The address of the account that writes the store (Drive `about.user`), or '' when it cannot be read. The store row's reviewer must be the account that wrote it, so this is the default."""
        gws = gws or ns.pull.gws
        try:
            body = gws(profile or ns.pull.WRITE_PROFILE, "drive", "about", "get", "--params", json.dumps({"fields": "user"}))
        except ns.pull.GwsError:
            return ""
        return str(((body or {}).get("user") or {}).get("emailAddress") or "")

    led = type("Ledger", (Ledger,), {"_ns": into, "__module__": into.__name__, "__doc__": Ledger.__doc__})
    names = dict(pull=pull, store=store, LOG_TAB=pull.LOG_TAB, MAX_JSON=MAX_JSON, StoreError=StoreError, cell=cell,
                 record_json=record_json, stamp_fields=stamp_fields, append=append, _append_chunk=_append_chunk,
                 Ledger=led, whoami=whoami)
    for k, v in names.items():
        setattr(into, k, v)
    if not hasattr(into, "APPEND_CHUNK"):
        into.APPEND_CHUNK = APPEND_CHUNK
    return into
