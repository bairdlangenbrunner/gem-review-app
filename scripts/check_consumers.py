"""
Run the page check in each sibling researcher repo, so a session opened in gem-review-app hears about stale
live review pages after a change to the shared interface (docs/refresh.md, step 4).

    python scripts/check_consumers.py --check            # each repo's build_all.py --check; exit 1 if any page is not fresh
    python scripts/check_consumers.py --hook EVENT       # Claude Code hook: stdin is the event JSON, stdout the merged hook output

A checkout that is missing, or has no review_app/build_all.py, is skipped. The hook mode hands the same event to each repo's own `build_all.py --hook EVENT` (each keeps its own session files under its own work/) and reads the JSON contract it prints (review_core/hooks.py: {"stale": [...], "warnings": [...]}). Lines of stdout that are not a JSON object are ignored. It prints the same contract, merged, with each entry's `repo` added, and forwards one plain sentence per stale page: as context lines for SessionStart and UserPromptSubmit, and as the block reason for Stop. Nothing here builds, publishes or writes outside what those hooks write.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
REPOS = ("gogpt-researcher", "pipelines-researcher", "lng-carriers-researcher")


def consumers(base=None):
    """(name, repo path) of each sibling checkout that has a page registry."""
    base = Path(base) if base else HERE.parent
    return [(n, base / n) for n in REPOS if (base / n / "review_app" / "build_all.py").is_file()]


def run(repo, args, stdin=None):
    return subprocess.run([sys.executable, "review_app/build_all.py", *args], cwd=repo, input=stdin,
                          capture_output=True, text=True, env={**os.environ, "CLAUDE_PROJECT_DIR": str(repo)})


def parse(raw):
    """The contract objects in one repo's stdout: each line that is a JSON object; other lines are ignored."""
    out = []
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if isinstance(o, dict):
            out.append(o)
    return out


def merge(event, outputs):
    """One hook output (the merged contract, plus Claude Code's fields when there is something to say) from the repos' outputs: [(repo name, stdout)]."""
    stale, warnings = [], []
    for name, raw in outputs:
        for o in parse(raw):
            stale += [dict(e, repo=name) for e in o.get("stale") or []]
            warnings += [f"[{name}] {w}" for w in o.get("warnings") or []]
    out = {"stale": stale, "warnings": warnings}
    texts = [f"[{e['repo']}] {e.get('text') or e.get('name')}" for e in stale]
    if event == "Stop":
        if texts:
            out.update(decision="block", reason=" ".join(texts))
    elif texts or warnings:
        out["hookSpecificOutput"] = {"hookEventName": event, "additionalContext": "\n".join(texts + warnings)}
    return json.dumps(out)


def main(argv=None, base=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--hook", metavar="EVENT")
    a = ap.parse_args(argv)
    found = consumers(base)
    if a.hook:
        stdin = sys.stdin.read()
        print(merge(a.hook, [(n, run(r, ["--hook", a.hook], stdin).stdout) for n, r in found]))
        return 0
    bad = False
    for n, r in found:
        p = run(r, ["--check"])
        print(f"{n}:")
        print("".join(f"  {l}\n" for l in p.stdout.splitlines()) + (f"  {p.stderr.strip()}\n" if p.returncode not in (0, 1) else ""), end="")
        bad = bad or p.returncode != 0
    if not found:
        print("no sibling researcher checkout has review_app/build_all.py")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
