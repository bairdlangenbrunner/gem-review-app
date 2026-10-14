"""Page registry: fingerprints, staleness reasons, mark_published and the hook output, on a fake adapter over temp dirs."""
import json
import os
import shutil
import time

import pytest

from conftest import make_config
from review_core import hooks, pages


@pytest.fixture
def env(tmp_path):
    root = tmp_path / "repo"
    for d in ("batches/a/staging", "batches/b/staging"):
        (root / d).mkdir(parents=True)
        (root / d / "staged.json").write_text('{"x": 1}')
        (root / d / "review_log.jsonl").write_text("")
    (root / "builder.py").write_text("v1")
    (root / "manifest.json").write_text("m1")
    (root / "work").mkdir()
    state = {"dirs": ["batches/a/staging", "batches/b/staging"], "snapshot": "snap_20261002.csv"}
    adapter = pages.PageAdapter(
        root=root, resolve_dirs=lambda e: [root / d for d in state["dirs"]],
        staged_files=lambda d: ("staged.json",), builder_files=("builder.py",),
        extra_inputs=lambda e: {"manifest": pages.sha_file(root / "manifest.json"), "snapshot": state["snapshot"]})
    entries = root / "artifacts.json"
    entries.write_text(json.dumps({"pages": [
        {"name": "one", "url": "https://claude.ai/artifact/x", "dirs": []},
        {"name": "two", "kind": "google", "url": ""}]}, indent=2))
    return {"root": root, "adapter": adapter, "config": make_config(), "state": state, "entries": entries,
            "last": root / "work/last.json"}


def entry(env, name="one"):
    return next(e for e in pages.load_entries(env["entries"]) if e["name"] == name)


def publish(env, name="one"):
    fp, parts = pages.fingerprint(entry(env, name), env["adapter"], env["config"])
    pages.record_build(env["last"], name, fp, parts, "2026-10-09T10:00:00-04:00")
    return pages.mark_published(env["entries"], name, env["last"], env["adapter"], env["config"],
                                now="2026-10-09T10:05:00-04:00", profile="gem")


def status(env, name="one"):
    return next(r for r in pages.check(pages.load_entries(env["entries"]), env["adapter"], env["config"]) if r["name"] == name)


def test_fingerprint_stable_and_mtime_blind(env, tmp_path):
    a = pages.fingerprint(entry(env), env["adapter"], env["config"])
    assert a == pages.fingerprint(entry(env), env["adapter"], env["config"])
    f = env["root"] / "batches/a/staging/staged.json"
    os.utime(f, (time.time() + 999, time.time() + 999))
    assert pages.fingerprint(entry(env), env["adapter"], env["config"]) == a
    clone = tmp_path / "clone"
    shutil.copytree(env["root"], clone)
    env["adapter"].root = clone
    env["adapter"].resolve_dirs = lambda e: [clone / d for d in env["state"]["dirs"]]
    assert pages.fingerprint(entry(env), env["adapter"], env["config"]) == a


@pytest.mark.parametrize("change,expect", [
    (lambda e: (e["root"] / "batches/a/staging/staged.json").write_text('{"x": 2}'), "staged work changed in batches/a/staging"),
    (lambda e: (e["root"] / "batches/a/staging/review_log.jsonl").write_text("{}\n"), "decisions changed in batches/a/staging"),
    (lambda e: (e["root"] / "builder.py").write_text("v2"), "builder changed"),
    (lambda e: (e["root"] / "manifest.json").write_text("m2"), "manifest changed"),
    (lambda e: e["state"].update(snapshot="snap_20261005.csv"), "snapshot changed (20261002 to 20261005)"),
])
def test_each_change_gives_its_reason_once(env, change, expect):
    publish(env)
    assert status(env)["status"] == "fresh"
    change(env)
    r = status(env)
    assert r["status"] == "stale" and r["reasons"] == [expect]


def test_unmarked_then_fresh(env):
    assert status(env)["status"] == "unmarked"
    publish(env)
    assert status(env)["status"] == "fresh"


def test_interface_change(env, monkeypatch, tmp_path):
    publish(env)
    web = tmp_path / "web"
    web.mkdir()
    (web / "ext.js").write_text("a")
    env["config"].web_dir = web
    assert status(env)["reasons"] == ["interface changed"]
    publish(env)
    (web / "ext.js").write_text("b")
    assert status(env)["reasons"] == ["interface changed"]


def test_new_and_gone_dirs_and_ordering(env):
    publish(env)
    new = env["root"] / "batches/c/staging"
    new.mkdir(parents=True)
    (new / "staged.json").write_text("{}")
    env["state"]["dirs"] = ["batches/b/staging", "batches/c/staging"]
    (env["root"] / "batches/b/staging/review_log.jsonl").write_text("{}\n")
    assert status(env)["reasons"] == ["new staging dir batches/c/staging", "staging dir gone batches/a/staging",
                                      "decisions changed in batches/b/staging"]


def test_mark_published_writes_block_and_leaves_others_byte_identical(env):
    before = env["entries"].read_text()
    pub = publish(env)
    assert pub["profile"] == "gem" and pub["at"] == "2026-10-09T10:05:00-04:00" and pub["built"] == "2026-10-09T10:00:00-04:00"
    e = entry(env)
    assert e["published"]["fingerprint"] == status(env)["fingerprint"] and "interface" in e["published"]["parts"]
    after = env["entries"].read_text()
    two = before[before.index('    {\n      "name": "two"'):]
    assert two.rstrip("]}\n ") in after
    publish(env)  # republish replaces the block, not a second key
    assert env["entries"].read_text().count('"published"') == 1


def test_mark_published_refuses_when_tree_changed(env):
    fp, parts = pages.fingerprint(entry(env), env["adapter"], env["config"])
    pages.record_build(env["last"], "one", fp, parts, "t")
    (env["root"] / "batches/a/staging/staged.json").write_text('{"x": 3}')
    with pytest.raises(pages.PublishError):
        pages.mark_published(env["entries"], "one", env["last"], env["adapter"], env["config"])
    assert "published" not in entry(env)


def run_hook(env, event, sid="s1", **ev):
    return hooks.hook(event, {"session_id": sid, **ev}, pages.check(pages.load_entries(env["entries"]), env["adapter"], env["config"]),
                      env["root"] / "work", profile="gem")


def test_session_start_output_and_session_file(env):
    out = json.loads(run_hook(env, "SessionStart"))
    assert out["hookSpecificOutput"]["hookEventName"] == "SessionStart"
    assert "one was never marked published" in out["hookSpecificOutput"]["additionalContext"]
    assert set(json.loads(hooks.session_file(env["root"] / "work", "s1").read_text())) == {"one", "two"}


def test_all_fresh_is_silent(env):
    publish(env, "one")
    publish(env, "two")
    assert run_hook(env, "SessionStart") is None
    assert run_hook(env, "UserPromptSubmit") is None
    assert run_hook(env, "Stop") is None


def test_prompt_hook_prints_only_on_change(env):
    publish(env, "one")
    publish(env, "two")
    run_hook(env, "SessionStart")
    assert run_hook(env, "UserPromptSubmit") is None
    (env["root"] / "batches/a/staging/staged.json").write_text('{"x": 9}')
    first = run_hook(env, "UserPromptSubmit")
    assert "staged work changed in batches/a/staging" in first
    assert run_hook(env, "UserPromptSubmit") is None


def test_stop_blocks_once_for_session_change(env):
    publish(env, "one")
    publish(env, "two")
    run_hook(env, "SessionStart")
    (env["root"] / "batches/a/staging/staged.json").write_text('{"x": 9}')
    out = json.loads(run_hook(env, "Stop"))
    assert out["decision"] == "block" and "stale from this session's changes" in out["reason"] and "claude.ai/artifact/x" in out["reason"]
    assert run_hook(env, "Stop", stop_hook_active=True) is None


def test_stop_ignores_preexisting_stale_decisions_and_published(env):
    publish(env, "one")
    publish(env, "two")
    (env["root"] / "batches/a/staging/staged.json").write_text('{"x": 9}')   # stale before the session
    run_hook(env, "SessionStart")
    assert run_hook(env, "Stop") is None
    publish(env, "one")
    (env["root"] / "batches/a/staging/review_log.jsonl").write_text("{}\n")  # routine decisions only
    assert run_hook(env, "Stop") is None


def test_stop_without_session_file_is_silent(env):
    assert run_hook(env, "Stop", sid="never") is None


def test_check_consumers_skips_missing_and_merges(tmp_path, monkeypatch, capsys):
    import sys as _sys
    _sys.path.insert(0, str(os.path.join(os.path.dirname(__file__), "..", "scripts")))
    import check_consumers as cc
    assert cc.consumers(tmp_path) == []
    assert cc.main(["--check"], base=tmp_path) == 0 and "no sibling" in capsys.readouterr().out
    ctx = lambda t: json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": t}})
    out = json.loads(cc.merge("SessionStart", [("a", ctx("page x is stale")), ("b", ""), ("c", ctx("page y is stale"))]))
    assert out["hookSpecificOutput"]["additionalContext"] == "[a] page x is stale\n[c] page y is stale"
    assert cc.merge("SessionStart", [("a", ""), ("b", "")]) is None
    block = lambda r: json.dumps({"decision": "block", "reason": r})
    assert json.loads(cc.merge("Stop", [("a", block("republish x")), ("b", block("republish y"))]))["reason"] == "[a] republish x [b] republish y"
    assert cc.merge("Stop", [("a", "")]) is None
