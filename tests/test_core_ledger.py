"""The shared Google store code (review_core pull, ledger and import_log) on the synthetic tracker, with a fake gws standing in for the store spreadsheet."""
import json
import types

import pytest

from conftest import make_config, make_data
from review_core import import_log as import_core
from review_core import ledger as ledger_core
from review_core import pull as pull_core
from review_core.store import bind

AL = "analyst.lead@globalenergymonitor.org"
TS = "2026-10-08T10:00:00-04:00"
COLS = ["ts", "reviewer", "key", "decision", "call", "note", "id", "scope", "json"]


class FakeSheet:
    """The store's `log` tab: values get (header, json column, id read-back), values append, drive about."""

    def __init__(self, fail=False):
        self.rows = [list(COLS)]
        self.calls = []
        self.fail = fail

    def __call__(self, profile, *args, parse=True):
        self.calls.append((profile, args[:5]))
        if args[:2] == ("drive", "about"):
            return {"user": {"emailAddress": AL}}
        verb = args[3]
        if verb == "append":
            if self.fail:
                raise pull_core.GwsError("auth expired")
            vals = json.loads(args[args.index("--json") + 1])["values"]
            first = len(self.rows) + 1
            self.rows += vals
            return {"updates": {"updatedRange": f"log!A{first}:I{len(self.rows)}"}}
        rng = json.loads(args[args.index("--params") + 1])["range"]
        if rng == "log!1:1":
            return {"values": [self.rows[0]]}
        col, r1, r2 = _parse(rng)
        return {"values": [[row[col]] if col < len(row) else [] for row in self.rows[r1 - 1:r2]]}

    def json_cells(self):
        c = COLS.index("json")
        return [r[c] for r in self.rows]


def _parse(rng):
    """log!I1:I or log!G2:G4 -> (column index, first row, last row)."""
    body = rng.split("!")[1]
    a, b = body.split(":")
    col = ord(a[0]) - 65
    r1 = int(a[1:])
    r2 = int(b[1:]) if b[1:] else 10 ** 6
    return col, r1, r2


@pytest.fixture
def repo(tmp_path):
    """A researcher repo in miniature: the store, pull, ledger and import_log adapters bound to the synthetic tracker."""
    labels = ["batches/a/staging", "batches/b/staging"]
    for d in labels:
        (tmp_path / d).mkdir(parents=True)
    (tmp_path / "google.json").write_text(json.dumps({"store_sheet_id": "S"}), encoding="utf-8")
    store = types.ModuleType("widgets_store")
    bind(make_config(), tmp_path, into=store)
    pull = types.ModuleType("widgets_pull")
    pull_core.bind(pull, root=tmp_path, store=store, config_path=tmp_path / "google.json")
    sheet = FakeSheet()
    pull.gws = sheet
    ledger = types.ModuleType("widgets_ledger")
    ledger.COLS = COLS
    ledger.ORIGINS = ("local", "artifact", "chat")
    ledger.scope_of = lambda data: ("widgets", str(data.get("built") or ""))
    ledger.row_of = lambda r: [str(r.get("ts") or ""), str(r.get("reviewer") or ""), ledger_core.cell(r.get("key")),
                               str(r.get("decision") or ""), str(r.get("call") or ""), ledger_core.cell(r.get("note")),
                               str(r.get("id") or ""), str(r.get("scope") or ""), ledger_core.record_json(r)]
    ledger_core.bind(ledger, pull=pull, store=store)
    data = make_data(labels)
    store.overlay(data, store.dir_paths(data))
    return types.SimpleNamespace(root=tmp_path, store=store, pull=pull, ledger=ledger, sheet=sheet, data=data,
                                 labels=labels, dirs=store.dir_paths(data))


def line(repo, i=0, decision="accept", **kw):
    d = repo.labels[i]
    return dict({"key": f"{d}::W{i + 1}:size", "dir": d, "decision": decision}, **kw)


# ---- pull --------------------------------------------------------------------------

def test_pull_mirrors_the_store_with_initials_and_skips_what_it_has(repo):
    recs = [dict(line(repo, 0), id="r1", reviewer=AL, ts=TS),
            dict(line(repo, 1, "reject"), id="r2", reviewer=AL, ts=TS),
            {"key": "x", "dir": "elsewhere/staging", "id": "r3", "reviewer": AL, "ts": TS}]
    cells = ["json"] + [json.dumps(r) for r in recs] + ["not json"]
    res = repo.pull.pull(reader=lambda sheet: cells)
    assert res["new"] == 2 and res["rows"] == 3 and res["cursor"] == 5 and res["bad_rows"] == [5]
    assert res["skipped"] == {"elsewhere/staging": 1} and res["emails"] == {"r1": AL, "r2": AL, "r3": AL}
    log = repo.store.read_log(repo.dirs[repo.labels[0]])
    assert [(r["id"], r["reviewer"]) for r in log] == [("r1", "AL")] and "row" not in log[0]
    assert repo.pull.pull(reader=lambda sheet: cells)["new"] == 0
    assert "SKIPPED 1 records" in repo.pull.report(res)


def test_pull_reads_through_the_gws_on_the_adapter_module(repo):
    repo.sheet.rows.append(["", "", "", "", "", "", "r9", "", json.dumps(dict(line(repo), id="r9", reviewer=AL, ts=TS))])
    res = repo.pull.pull()
    assert res["new"] == 1 and res["configured"]
    assert repo.pull.pull(cfg={})["configured"] is False


# ---- ledger ------------------------------------------------------------------------

def test_sink_writes_the_store_first_in_chunks_then_the_sidecar(repo, monkeypatch):
    monkeypatch.setattr(repo.ledger, "APPEND_CHUNK", 2)
    led = repo.ledger.Ledger.for_data(repo.data, "local", cfg={"store_sheet_id": "S"}, reviewer_email=AL)
    assert led.scope == "widgets"
    recs = [line(repo, 0), line(repo, 1, "reject")] + [dict(line(repo, 0), decision="hold") for _ in range(3)]
    for r in recs:
        r["reviewer"] = "Analyst Lead"
    with repo.store._LOCK:
        saved = led.sink(recs, repo.dirs)
    appends = [c for c in repo.sheet.calls if c[1][3] == "append"]
    assert len(appends) == 3 and [r["row"] for r in saved] == [2, 3, 4, 5, 6]
    stored = [json.loads(c) for c in repo.sheet.json_cells()[1:]]
    assert {r["reviewer"] for r in stored} == {AL} and {r["origin"] for r in stored} == {"local"}
    side = repo.store.read_log(repo.dirs[repo.labels[0]])
    assert len(side) == 4 and {r["reviewer"] for r in side} == {"AL"}
    assert [r["id"] for r in stored] == [r["id"] for r in saved]


def test_a_store_that_cannot_be_written_records_nothing(repo):
    repo.sheet.fail = True
    led = repo.ledger.Ledger("S", "widgets", "", "local", reviewer_email=AL)
    with pytest.raises(repo.ledger.StoreError), repo.store._LOCK:
        led.sink([dict(line(repo), reviewer="AL")], repo.dirs)
    assert repo.store.read_log(repo.dirs[repo.labels[0]]) == []
    assert repo.ledger.StoreError is ledger_core.StoreError


def test_ledger_reads_the_adapter_hooks_when_it_runs(repo, monkeypatch):
    monkeypatch.setattr(repo.ledger, "scope_of", lambda data: ("replaced", "snap"))
    led = repo.ledger.Ledger.for_data(repo.data, "chat", cfg={"store_sheet_id": "S"})
    assert (led.scope, led.snapshot) == ("replaced", "snap")
    assert repo.ledger.Ledger.for_data(repo.data, "chat", cfg={}) is None
    with pytest.raises(ValueError):
        repo.ledger.stamp_fields([{}], "s", "", "gas")
    assert repo.ledger.whoami() == AL
    with pytest.raises(repo.ledger.StoreError):
        repo.ledger.record_json({"note": "x" * 50000})
    assert repo.ledger.cell("=SUM(A1)") == "'=SUM(A1)"


# ---- import_log --------------------------------------------------------------------

class Rules:
    """Park any key the dataset does not have; take the rest as they are."""

    def __init__(self, ds, dirs):
        self.idx, self.parked = repo_index(ds), []

    def place(self, r, where, email):
        if r["key"] not in self.idx:
            self.parked.append({"reason": "gone", "email": email, "record": r})
            return None
        return r

    def extra(self):
        return {"parked": self.parked}


repo_index = None


def importer(repo):
    global repo_index
    repo_index = repo.store.index
    mod = types.ModuleType("widgets_import")
    mod.ledger, mod.store = repo.ledger, repo.store
    import_core.bind(mod, required=("key", "id", "reviewer", "dir"), rules=Rules, add_args=lambda ap: None,
                     dataset_for=lambda a, docs: (repo.data, repo.dirs), next_step="Then rebuild.")
    return mod


def test_import_plans_dedupes_supersedes_parks_and_writes_through_the_ledger(repo, tmp_path, capsys):
    imp = importer(repo)
    with repo.store._LOCK:
        repo.store._write([dict(line(repo, 1, "hold"), id="old", reviewer="BL", ts="2026-10-08T12:00:00-04:00")],
                          repo.dirs, stamp=False)
    recs = [dict(line(repo, 0), id="a", reviewer="A", ts=TS),
            dict(line(repo, 1, "reject"), id="b", reviewer="AL", ts=TS),
            dict(line(repo, 0), id="a", reviewer="AL", ts=TS),
            dict(line(repo, 0), key="batches/a/staging::W9:size", id="c", reviewer="AL", ts=TS)]
    f = tmp_path / "download.json"
    f.write_text(json.dumps({"logs": [{"reviewer": "Analyst", "email": AL, "records": recs}]}), encoding="utf-8")
    docs = imp.read_docs(f)
    pl = imp.plan(docs, repo.data, repo.dirs)
    assert [r["id"] for _, r in pl["new"]] == ["a"] and pl["new"][0][1]["reviewer"] == "AL"
    assert pl["dup"] == 1 and [r["id"] for r in pl["stale"]] == ["b"] and pl["people"] == {"AL": AL}
    assert [x["record"]["id"] for x in pl["parked"]] == ["c"]
    assert "1 parked" in imp.report(pl)
    assert imp.main([str(f), "--dry-run"]) == 0 and "dry run: nothing written" in capsys.readouterr().out
    assert imp.main([str(f)]) == 0
    out = capsys.readouterr().out
    assert "1 records in the store (rows 2-2)" in out and "Then rebuild." in out
    assert json.loads(repo.sheet.json_cells()[1])["origin"] == "artifact"
    assert imp.plan(imp.read_docs(f), repo.data, repo.dirs)["dup"] == 2


def test_import_stops_on_a_record_it_cannot_take(repo):
    imp = importer(repo)
    bad = [{"reviewer": "x", "records": [dict(line(repo), reviewer="AL", ts=TS)]},
           {"reviewer": "x", "records": [dict(line(repo), id="z", reviewer="AL", ts="2026-10-08T10:00:00")]},
           {"reviewer": "x", "records": [dict(line(repo), id="z", reviewer="backend sync", ts=TS)]},
           {"reviewer": "x", "records": [dict(line(repo), id="z", reviewer="AL", ts=TS)]}]
    for doc, why in zip(bad, ("needs key, id, reviewer, dir", "no usable time", "is not a person's initials",
                              "carries no address")):
        with pytest.raises(SystemExit, match=why):
            imp.plan([doc], repo.data, repo.dirs)
