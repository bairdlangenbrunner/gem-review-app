"""
Bring decisions made on the artifact page into the decision ledger: the code both researcher repos share.

The input is what the page's "download decisions" button saves, or the artifact's shared `logs` collection saved as JSON (an ArtifactData `list` or `get` result). Either way it holds one or more log documents, each {reviewer, email?, records: [...]}; read_docs finds them inside any wrapper.

Every new record goes through the ledger like any other decision: appended to the store spreadsheet's `log` tab first (origin 'artifact', under the reviewer's own address), then to the staging dir's review_log.jsonl. Each record keeps the id and the time the page gave it. The shared rules:

  - a record whose id is already in a staging dir's log is skipped, so importing the same file twice, or a later download that repeats an earlier one, is safe
  - a record is skipped as superseded when the log already holds a later decision by a person on the same key (someone decided it on another surface afterwards)
  - a record must carry a usable time with a time zone and a person's initials as its reviewer, or the import stops before anything is written
  - the page is not given reviewers' addresses, only their names, so each one is named with --reviewer EMAIL (matched to its initials) or --reviewer XX=EMAIL; a one-letter name from a one-word profile is widened to the address's initials
  - one set of initials under two addresses stops the import

What a record must match in the current dataset is the tracker's business. A researcher repo's review_app/import_log.py is a thin adapter: it calls `bind(sys.modules[__name__], ...)` with these hooks:

    ledger, store     the repo's bound ledger and store modules
    required          the fields every record must carry, in the order the error names them
    rules(ds, dirs)   an object with place(r, where, email) that returns the record to import (the same one, or a copy under another key) or None when it parks the record itself, and extra() for the plan keys it adds (for example rekeyed and parked)
    fill_id(r)        optional: an id for a record the page wrote without one
    flags             count ask-the-PM flags apart in the report
    bare_jsonl        read a file that is not JSON as one document of JSON lines
    add_args(ap)      the CLI arguments that pick the dataset
    dataset_for(a, docs) the dataset and its {label: Path} dirs for those arguments
    after_plan(pl)    optional: runs after a real (not dry) plan, before the write; returns lines to print
    next_step         the sentence printed after a write

bind adds ORIGIN, read_docs, plan, runs, write, report and main to the adapter. The bound functions look the hooks and the adapter's ledger and store up on the adapter module when they run.
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

ORIGIN = "artifact"


def when(ts):
    """A record's time, or None when it cannot be read."""
    try:
        return datetime.fromisoformat(str(ts))
    except ValueError:
        return None


def find_docs(body):
    """Every log document ({records: [...]}) inside a parsed body, in order."""
    docs = []

    def walk(x):
        if isinstance(x, dict):
            if isinstance(x.get("records"), list):
                docs.append(x)
            else:
                for v in x.values():
                    walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(body)
    return docs


def history(dirs, store):
    """(ids already in the staging dirs' logs, {key: the latest time a person decided it})."""
    have, last = set(), {}
    for d in dirs.values():
        for r in store.read_log(d):
            if r.get("id"):
                have.add(str(r["id"]))
            t = when(r.get("ts"))
            if r.get("key") and t and not store.is_machine(r) and (r["key"] not in last or t > last[r["key"]]):
                last[r["key"]] = t
    return have, last


def runs(new):
    """Consecutive records of one address, so the log keeps time order across reviewers."""
    out = []
    for email, r in new:
        if out and out[-1][0] == email:
            out[-1][1].append(r)
        else:
            out.append((email, [r]))
    return out


def parse_emails(values, store):
    """{initials: address} from the --reviewer values (EMAIL or XX=EMAIL)."""
    emails = {}
    for v in values:
        who, _, addr = v.rpartition("=")
        emails[who.strip() or store.initials(addr.strip())] = addr.strip()
    return emails


def bind(into, *, required, rules, add_args, dataset_for, next_step, fill_id=None, flags=False, bare_jsonl=False,
         after_plan=None):
    """Put the import API into the adapter module `into`, which already holds its `ledger` and `store` modules. The hooks are described at the top. Returns `into`."""
    ns = into
    ns._rules, ns._fill_id, ns._after_plan = rules, fill_id, after_plan
    ns._add_args, ns._dataset_for = add_args, dataset_for

    def read_docs(path):
        """Every log document in a file, wherever it sits: the download ({logs: [...]}), one document, or an ArtifactData result that wraps documents in its own envelope."""
        text = Path(path).read_text(encoding="utf-8")
        if not bare_jsonl:
            return find_docs(json.loads(text))
        try:
            body = json.loads(text)
        except json.JSONDecodeError:
            recs = ns.store.read_jsonl(path)
            return [{"reviewer": "", "records": recs}] if recs else []
        return find_docs(body)
    if bare_jsonl:
        read_docs.__doc__ += " A bare .jsonl of records is one document with no reviewer name."

    def plan(docs, ds, dirs, emails=None):
        """Returns {"new": [(email, record), ...] in time order, "dup": n, "stale": [records], "people": {initials: email}} plus the keys the tracker's rules add. SystemExit on a record no dataset could take; nothing is written here."""
        store = ns.store
        rl = ns._rules(ds, dirs)
        have, last = history(dirs, store)
        new, stale, people, dup, seen = [], [], {}, 0, set()
        for doc in docs:
            doc_email = str(doc.get("email") or "").strip()
            for i, r in enumerate(doc["records"]):
                where = f"{doc.get('reviewer') or '?'} record {i + 1}"
                if not isinstance(r, dict) or not all(r.get(f) for f in required):
                    raise SystemExit(f"{where}: not a review record (needs {', '.join(required)})")
                if not r.get("id") and ns._fill_id:
                    r["id"] = ns._fill_id(r)
                t = when(r.get("ts"))
                if t is None or t.tzinfo is None:
                    raise SystemExit(f"{where}: no usable time ({r.get('ts')!r})")
                if store.is_machine(r) or not store._INITIALS_RE.match(str(r["reviewer"])):
                    raise SystemExit(f"{where}: reviewer {r['reviewer']!r} is not a person's initials")
                if str(r["id"]) in have or str(r["id"]) in seen:
                    dup += 1
                    continue
                seen.add(str(r["id"]))
                hint = doc_email or (emails or {}).get(r["reviewer"]) or ""
                r = rl.place(r, where, hint)
                if r is None:
                    continue
                email = hint
                if not email:
                    raise SystemExit(f"{where}: the log of {r['reviewer']} carries no address: pass --reviewer {r['reviewer']}=EMAIL")
                full = store.initials(email)         # a one-word profile name logs "B": record "BL" (Baird 2026-10-05)
                if len(r["reviewer"]) < 2 and full.startswith(r["reviewer"]):
                    r["reviewer"] = full
                if people.setdefault(r["reviewer"], email) != email:
                    raise SystemExit(f"{where}: {r['reviewer']} appears under two addresses ({people[r['reviewer']]}, {email})")
                if r["key"] in last and last[r["key"]] > t:
                    stale.append(r)
                    continue
                new.append((t, email, r))
        new.sort(key=lambda x: x[0])
        out = {"new": [(e, r) for _, e, r in new], "dup": dup, "stale": stale, "people": people}
        out.update(rl.extra())
        return out

    def write(pl, ds, dirs, cfg=None, gws=None):
        """Append the planned records, store first. Returns the saved records (each with its store `row`)."""
        saved = []
        for email, recs in runs(pl["new"]):
            led = ns.ledger.Ledger.for_data(ds, ORIGIN, cfg=cfg, reviewer_email=email, gws=gws)
            if led is None:
                raise SystemExit("no store configured (review_app/google.json: store_sheet_id): nothing was recorded")
            saved += ns.store.append_records([dict(r) for r in recs], dirs, sink=led.sink)
        return saved

    def report(pl):
        store = ns.store
        out, by = [], {}
        for email, r in pl["new"]:
            by.setdefault((r["reviewer"], email), []).append(r)
        for (who, email), recs in sorted(by.items()):
            n_flag = sum(1 for r in recs if r.get("flag"))
            n_item = sum(1 for r in recs if "call" in r and not r.get("flag"))
            undo = sum(1 for r in recs if r.get("undecided"))
            counts = f"{len(recs) - n_item - n_flag} line decisions, {n_item} item calls" + (f", {n_flag} flags" if flags else "")
            out.append(f"{who} ({email}): {counts}"
                       + (f", {undo} of them undos" if undo else "")
                       + (f"  [note: the address reads as {store.initials(email)}]" if store.initials(email) != who else ""))
        out.append(f"{len(pl['new'])} new, {pl['dup']} already in the log, {len(pl['stale'])} superseded by a later decision")
        for r in pl["stale"][:20]:
            out.append(f"  superseded: {r['key']} ({r['reviewer']}, {r.get('ts')})")
        if pl.get("rekeyed"):
            out.append(f"{len(pl['rekeyed'])} moved to the line's current key (its sheet row moved, or an old one-column key)")
            out += [f"  {r['rekeyed_from']}  ->  {r['key']}" for r in pl["rekeyed"][:20]]
        if pl.get("parked"):
            out.append(f"{len(pl['parked'])} parked: they match nothing in the current dataset and are left out")
            out += [f"  {x['record']['key']}: {x['reason']}" for x in pl["parked"][:20]]
        return "\n".join(out)

    def main(argv=None):
        ap = argparse.ArgumentParser(description=(into.__doc__ or "").strip().split("\n\n")[0])
        ap.add_argument("file", nargs="+", help="the page's download, or the artifact's `logs` collection saved as JSON")
        ns._add_args(ap)
        ap.add_argument("--reviewer", action="append", default=[], metavar="EMAIL or XX=EMAIL",
                        help="a reviewer's address, for a log that carries none (the page is not given addresses); "
                             "repeat per reviewer. A bare EMAIL is matched to its own initials")
        ap.add_argument("--dry-run", action="store_true", help="report only; write nothing")
        a = ap.parse_args(argv)
        docs = [d for f in a.file for d in ns.read_docs(f)]
        if not any(d["records"] for d in docs):
            raise SystemExit("no records in " + ", ".join(a.file))
        ds, dirs = ns._dataset_for(a, docs)
        pl = ns.plan(docs, ds, dirs, emails=parse_emails(a.reviewer, ns.store))
        print(ns.report(pl))
        if a.dry_run:
            print("dry run: nothing written")
            return 0
        for line in (ns._after_plan(pl) if ns._after_plan else None) or []:
            print(line)
        if not pl["new"]:
            return 0
        try:
            saved = ns.write(pl, ds, dirs)
        except ns.ledger.StoreError as e:
            sys.exit(f"{e}\nthe records of this run were not recorded; run the import again (earlier runs are skipped by id)")
        print(f"{len(saved)} records in the store (rows {min(r['row'] for r in saved)}-{max(r['row'] for r in saved)}) "
              f"and in {len({r['dir'] for r in saved})} staging dir(s). {next_step}")
        return 0

    names = dict(ORIGIN=ORIGIN, _when=when, read_docs=read_docs, plan=plan, runs=runs, write=write, report=report, main=main)
    for k, v in names.items():
        setattr(into, k, v)
    return into
