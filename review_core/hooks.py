"""
Hook output for the page check (docs/refresh.md, section 4). The researcher repo's `build_all.py --hook <event>` reads the event JSON on stdin, runs pages.check, and prints what `hook` returns: always one JSON object on one line. The hooks never build, never publish, and write only two files under work/: the session file (page fingerprints at the start of the current turn) and the last report printed.

The object is a contract other scripts read (scripts/check_consumers.py):

    {"stale": [entry, ...], "warnings": [text, ...]}

Each entry is one page this event should speak about: {"name", "kind", "status" (stale or unmarked), "reasons", "url", "rebuild", "publish", "mark", "text"}. `rebuild` and `mark` are shell commands run from the repo root; `publish` says where the built file goes, or is null for a page whose rebuild command publishes it (the google kind, whose `mark` is null too). `text` is the plain sentence a person reads. The list is what to say now, not every stale page: UserPromptSubmit lists nothing when the report has not changed since the last one in this session, and Stop lists only the pages this turn made stale, with only this turn's reasons. An entry whose page another session is publishing right now (pages.read_lock: a live `work/.review_publish.lock` held by a different session) carries `locked_by` (that session's id) and a `text` that says to leave it to that session; Stop never blocks for such a page. `warnings` are sentences about the session rather than one page (the personal-profile warning), or a page check that failed.

Several sessions share one checkout, so the Stop guard cannot tell whose edit it sees: it compares the fingerprints now with those at the start of this turn (SessionStart and every UserPromptSubmit write the session file), which is the narrowest window the hooks have. An edit another session makes inside that window still looks like this turn's until that session takes the publish lock.

The same object also carries Claude Code's own fields, because the researcher repos run this command directly as their hook: `hookSpecificOutput.additionalContext` (SessionStart, UserPromptSubmit) or `decision` and `reason` (Stop), holding the same sentences. Claude Code ignores the other keys, and an object with no field of its own (nothing to say) has no effect.
"""
import json
from pathlib import Path

from review_core import pages

BUILD_ALL = "python review_app/build_all.py"
PROFILE_WARNING = ("This session is on the personal profile. Publishing from it is a known defect "
                   "(the artifact's shared log cannot be read from the work account): publish from ~/.claude-gem.")


def _session_id(event):
    return "".join(c for c in str(event.get("session_id") or "unknown") if c.isalnum() or c in "-_") or "unknown"


def session_file(work, sid):
    return Path(work) / f".review_pages_session_{sid}.json"


def report_file(work, sid):
    return Path(work) / f".review_pages_report_{sid}.txt"


def _instruction(r):
    if r["kind"] == "google":
        return "refresh with publish.py --upload --yes"
    where = r["url"] or "its url"
    return (f"rebuild with build_all.py --only {r['name']}, publish to {where} with the Artifact tool "
            f"from the work profile, then build_all.py --mark-published {r['name']}")


def _sentence(r, session=False, lock=None):
    if lock:
        state = "was never marked published" if r["status"] == "unmarked" else f"is stale ({'; '.join(r['reasons'])})"
        return (f"Review page {r['name']} {state}; another session (session {lock['session'][:8]}) has been rebuilding it "
                f"since {lock['started'][11:16]}: leave the publish to that session, do not rebuild or publish it from this one.")
    if r["status"] == "unmarked":
        return f"Review page {r['name']} was never marked published: {_instruction(r)}."
    why = "from this turn's changes " if session else ""
    return f"Review page {r['name']} is stale {why}({'; '.join(r['reasons'])}): {_instruction(r)}."


def entry(r, session=False, lock=None):
    """The contract entry for one report from pages.check. `lock`: another session's live publish lock covering this page, when there is one."""
    google = r["kind"] == "google"
    return {"name": r["name"], "kind": r["kind"], "status": r["status"], "reasons": list(r["reasons"]),
            "url": r["url"],
            "rebuild": pages.GOOGLE_REFRESH if google else f"{BUILD_ALL} --only {r['name']}",
            "publish": None if google else f"publish the built file to {r['url'] or 'its url'} with the Artifact tool from the work profile",
            "mark": None if google else f"{BUILD_ALL} --mark-published {r['name']}",
            "locked_by": lock["session"] if lock else None,
            "text": _sentence(r, session, lock)}


def _owed(reports):
    return [r for r in reports if r["status"] in ("stale", "unmarked")]


def other_lock(work, sid):
    """Another session's live publish lock, or None. The lock names the session by CLAUDE_CODE_SESSION_ID, which is the hook event's session_id."""
    lock = pages.read_lock(work)
    return lock if lock and lock["session"] not in (sid, pages.session_id()) else None


def _lock_for(lock, name):
    return lock if lock and name in lock.get("pages", []) else None


def format_report(reports, profile, lock=None):
    """One line per page that is not fresh, plus a profile warning when a publish is owed."""
    lines = [_sentence(r, lock=_lock_for(lock, r["name"])) for r in _owed(reports)]
    if lines and profile != "gem":
        lines.append(PROFILE_WARNING)
    return "\n".join(lines)


def _out(event, stale, warnings, block=False):
    out = {"stale": stale, "warnings": warnings}
    texts = [s["text"] for s in stale]
    if block:
        if texts:
            out.update(decision="block", reason=" ".join(texts))
    elif texts or warnings:
        out["hookSpecificOutput"] = {"hookEventName": event, "additionalContext": "\n".join(texts + warnings)}
    return json.dumps(out)


def failed(event, err):
    """The hook output when the page check itself failed: a warning, never a block."""
    return _out(event, [], [f"The review page check failed ({type(err).__name__}: {err}); run {BUILD_ALL} --check to see why."],
                block=event == "Stop")


def hook(event, stdin_json, reports, work, profile=None):
    """The stdout for a hook event ('SessionStart', 'UserPromptSubmit' or 'Stop'): the JSON contract described at the top."""
    ev = stdin_json if isinstance(stdin_json, dict) else json.loads(stdin_json or "{}")
    profile = profile or pages.current_profile()
    sid = _session_id(ev)
    work = Path(work)
    lock = other_lock(work, sid)
    text = format_report(reports, profile, lock)
    warnings = [PROFILE_WARNING] if text and profile != "gem" else []
    now = [entry(r, lock=_lock_for(lock, r["name"])) for r in _owed(reports)]
    baseline = json.dumps({r["name"]: r["parts"] for r in reports})
    if event == "SessionStart":
        work.mkdir(parents=True, exist_ok=True)
        session_file(work, sid).write_text(baseline, encoding="utf-8")
        report_file(work, sid).write_text(text, encoding="utf-8")
        return _out(event, now, warnings)
    if event == "UserPromptSubmit":
        work.mkdir(parents=True, exist_ok=True)
        session_file(work, sid).write_text(baseline, encoding="utf-8")    # the Stop guard measures this turn, not the session
        rf = report_file(work, sid)
        last = rf.read_text(encoding="utf-8") if rf.is_file() else ""
        if text == last:
            return _out(event, [], [])
        rf.write_text(text, encoding="utf-8")
        return _out(event, now, warnings)
    if event == "Stop":
        sf = session_file(work, sid)
        if ev.get("stop_hook_active") or not sf.is_file():
            return _out(event, [], [], block=True)
        start = json.loads(sf.read_text(encoding="utf-8"))
        owed = []
        for r in reports:
            # stale now, and this turn changed something other than routine decisions in its inputs,
            # and no other session is already between a build and a publish of it
            mine = [x for x in pages.reasons(start[r["name"]], r["parts"]) if not x.startswith("decisions changed")] if r["name"] in start else []
            if r["status"] == "stale" and mine and not _lock_for(lock, r["name"]):
                owed.append(entry(dict(r, reasons=mine), session=True))
        return _out(event, owed, [], block=True)
    return _out(event, [], [])
