"""
Claude Code hook output for the page check (docs/refresh.md, section 4). The researcher repo's `build_all.py --hook <event>` reads the event JSON on stdin, runs pages.check, and prints what `hook` returns (nothing when every page is fresh). The hooks never build, never publish, and write only two files under work/: the session file (page fingerprints at session start) and the last report printed.
"""
import json
from pathlib import Path

from review_core import pages


def _session_id(event):
    return "".join(c for c in str(event.get("session_id") or "unknown") if c.isalnum() or c in "-_") or "unknown"


def session_file(work, sid):
    return Path(work) / f".review_pages_session_{sid}.json"


def report_file(work, sid):
    return Path(work) / f".review_pages_report_{sid}.txt"


def _instruction(r, profile):
    if r["kind"] == "google":
        return "refresh with publish.py --upload --yes (ask Baird first)"
    where = r["url"] or "its url"
    return (f"rebuild with build_all.py --only {r['name']}, publish to {where} with the Artifact tool "
            f"from the work profile, then build_all.py --mark-published {r['name']}")


def format_report(reports, profile):
    """One line per page that is not fresh, plus a profile warning when a publish is owed."""
    lines = []
    for r in reports:
        if r["status"] == "stale":
            lines.append(f"Review page {r['name']} is stale ({'; '.join(r['reasons'])}): {_instruction(r, profile)}.")
        elif r["status"] == "unmarked":
            lines.append(f"Review page {r['name']} was never marked published: {_instruction(r, profile)}.")
    if lines and profile != "gem":
        lines.append("This session is on the personal profile. Publishing from it is a known defect "
                     "(the artifact's shared log cannot be read from the work account): publish from ~/.claude-gem.")
    return "\n".join(lines)


def _context(event_name, text):
    return json.dumps({"hookSpecificOutput": {"hookEventName": event_name, "additionalContext": text}})


def hook(event, stdin_json, reports, work, profile=None):
    """The stdout for a hook event ('SessionStart', 'UserPromptSubmit' or 'Stop'), or None for no output."""
    ev = stdin_json if isinstance(stdin_json, dict) else json.loads(stdin_json or "{}")
    profile = profile or pages.current_profile()
    sid = _session_id(ev)
    work = Path(work)
    text = format_report(reports, profile)
    if event == "SessionStart":
        work.mkdir(parents=True, exist_ok=True)
        session_file(work, sid).write_text(json.dumps({r["name"]: r["parts"] for r in reports}), encoding="utf-8")
        report_file(work, sid).write_text(text, encoding="utf-8")
        return _context(event, text) if text else None
    if event == "UserPromptSubmit":
        rf = report_file(work, sid)
        last = rf.read_text(encoding="utf-8") if rf.is_file() else ""
        if text == last:
            return None
        work.mkdir(parents=True, exist_ok=True)
        rf.write_text(text, encoding="utf-8")
        return _context(event, text) if text else None
    if event == "Stop":
        if ev.get("stop_hook_active"):
            return None
        sf = session_file(work, sid)
        if not sf.is_file():
            return None
        start = json.loads(sf.read_text(encoding="utf-8"))
        owed = []
        for r in reports:
            # stale now, and this session changed something other than routine decisions in its inputs
            mine = [x for x in pages.reasons(start[r["name"]], r["parts"]) if not x.startswith("decisions changed")] if r["name"] in start else []
            if r["status"] == "stale" and mine:
                owed.append(dict(r, reasons=mine))
        if not owed:
            return None
        why = " ".join(f"Review page {r['name']} is stale from this session's changes ({'; '.join(r['reasons'])}): "
                       f"{_instruction(r, profile)}." for r in owed)
        return json.dumps({"decision": "block", "reason": why})
    return None
