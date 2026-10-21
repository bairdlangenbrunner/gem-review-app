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
    return json.loads(hooks.hook(event, {"session_id": sid, **ev}, pages.check(pages.load_entries(env["entries"]), env["adapter"], env["config"]),
                                 env["root"] / "work", profile="gem"))


def silent(out):
    """Nothing to say: an empty contract and none of Claude Code's fields."""
    return out == {"stale": [], "warnings": []}


def test_session_start_output_and_session_file(env):
    out = run_hook(env, "SessionStart")
    assert out["hookSpecificOutput"]["hookEventName"] == "SessionStart"
    assert "one was never marked published" in out["hookSpecificOutput"]["additionalContext"]
    assert set(json.loads(hooks.session_file(env["root"] / "work", "s1").read_text())) == {"one", "two"}
    one, two = out["stale"]
    assert one == {"name": "one", "kind": "artifact", "status": "unmarked", "reasons": [], "url": "https://claude.ai/artifact/x",
                   "rebuild": "python review_app/build_all.py --only one",
                   "publish": "publish the built file to https://claude.ai/artifact/x with the Artifact tool from the work profile",
                   "mark": "python review_app/build_all.py --mark-published one", "locked_by": None, "text": one["text"]}
    assert one["text"].startswith("Review page one was never marked published: rebuild with build_all.py --only one")
    assert two["kind"] == "google" and two["rebuild"] == pages.GOOGLE_REFRESH and two["publish"] is None and two["mark"] is None
    assert out["warnings"] == []


def test_personal_profile_warning_is_a_warning(env):
    out = json.loads(hooks.hook("SessionStart", {"session_id": "p"}, pages.check(pages.load_entries(env["entries"]), env["adapter"], env["config"]),
                                env["root"] / "work", profile="personal"))
    assert out["warnings"] == [hooks.PROFILE_WARNING]
    assert out["hookSpecificOutput"]["additionalContext"].endswith(hooks.PROFILE_WARNING)


def test_all_fresh_is_silent(env):
    publish(env, "one")
    publish(env, "two")
    assert silent(run_hook(env, "SessionStart"))
    assert silent(run_hook(env, "UserPromptSubmit"))
    assert silent(run_hook(env, "Stop"))


def test_prompt_hook_prints_only_on_change(env):
    publish(env, "one")
    publish(env, "two")
    run_hook(env, "SessionStart")
    assert silent(run_hook(env, "UserPromptSubmit"))
    (env["root"] / "batches/a/staging/staged.json").write_text('{"x": 9}')
    first = run_hook(env, "UserPromptSubmit")
    assert first["stale"][0]["reasons"] == ["staged work changed in batches/a/staging"]
    assert "staged work changed in batches/a/staging" in first["hookSpecificOutput"]["additionalContext"]
    assert silent(run_hook(env, "UserPromptSubmit"))


def test_stop_blocks_once_for_session_change(env):
    publish(env, "one")
    publish(env, "two")
    run_hook(env, "SessionStart")
    (env["root"] / "batches/a/staging/staged.json").write_text('{"x": 9}')
    out = run_hook(env, "Stop")
    assert out["decision"] == "block" and "stale from this turn's changes" in out["reason"] and "claude.ai/artifact/x" in out["reason"]
    assert [e["name"] for e in out["stale"]] == ["one", "two"] and out["reason"] == " ".join(e["text"] for e in out["stale"])
    assert silent(run_hook(env, "Stop", stop_hook_active=True))


def test_stop_ignores_preexisting_stale_decisions_and_published(env):
    publish(env, "one")
    publish(env, "two")
    (env["root"] / "batches/a/staging/staged.json").write_text('{"x": 9}')   # stale before the session
    run_hook(env, "SessionStart")
    assert silent(run_hook(env, "Stop"))
    publish(env, "one")
    (env["root"] / "batches/a/staging/review_log.jsonl").write_text("{}\n")  # routine decisions only
    assert silent(run_hook(env, "Stop"))


def test_stop_without_session_file_is_silent(env):
    assert silent(run_hook(env, "Stop", sid="never"))


def test_stop_measures_the_turn_not_the_session(env):
    publish(env, "one")
    publish(env, "two")
    run_hook(env, "SessionStart")
    (env["root"] / "batches/a/staging/staged.json").write_text('{"x": 9}')   # changed before this turn (another session, say)
    run_hook(env, "UserPromptSubmit")
    assert silent(run_hook(env, "Stop"))
    (env["root"] / "batches/b/staging/staged.json").write_text('{"x": 9}')   # changed during this turn
    out = run_hook(env, "Stop")
    assert out["decision"] == "block" and out["stale"][0]["reasons"] == ["staged work changed in batches/b/staging"]


def test_hooks_defer_to_another_sessions_lock(env):
    publish(env, "one")
    publish(env, "two")
    run_hook(env, "SessionStart")
    (env["root"] / "batches/a/staging/staged.json").write_text('{"x": 9}')
    pages.acquire_lock(env["root"] / "work", ["one", "two"], session="s2")
    out = run_hook(env, "UserPromptSubmit")
    assert out["stale"][0]["locked_by"] == "s2" and "another session (session s2)" in out["stale"][0]["text"]
    assert "do not rebuild or publish it from this one" in out["hookSpecificOutput"]["additionalContext"]
    (env["root"] / "batches/b/staging/staged.json").write_text('{"x": 9}')   # this turn's own change
    assert silent(run_hook(env, "Stop"))                                  # s2 is publishing: never block for it
    pages.release_lock(env["root"] / "work", session="s2")
    out = run_hook(env, "Stop")
    assert out["decision"] == "block" and out["stale"][0]["locked_by"] is None
    pages.acquire_lock(env["root"] / "work", ["one"], session="s1")       # my own lock is not "another session"
    out = run_hook(env, "Stop")
    assert out["decision"] == "block" and "another session" not in out["reason"]


def test_lock_acquire_release_and_expiry(env):
    from datetime import datetime, timedelta
    work = env["root"] / "work"
    assert pages.read_lock(work) is None
    lock = pages.acquire_lock(work, ["one"], session="s1")
    assert lock["pages"] == ["one"] and pages.read_lock(work)["session"] == "s1"
    with pytest.raises(pages.LockHeld, match="another session is publishing one since"):
        pages.acquire_lock(work, ["two"], session="s2")
    assert pages.acquire_lock(work, ["two"], session="s1")["pages"] == ["one", "two"]   # my own: refreshed and extended
    assert pages.release_lock(work, "one", session="s2") is False and pages.read_lock(work)["pages"] == ["one", "two"]
    assert pages.release_lock(work, "one", session="s1") is False and pages.read_lock(work)["pages"] == ["two"]
    assert pages.release_lock(work, "two", session="s1") is True and pages.read_lock(work) is None
    pages.acquire_lock(work, ["one"], session="s2", now=datetime.now().astimezone() - timedelta(seconds=pages.LOCK_TTL + 1))
    assert pages.read_lock(work) is None                                   # expired: anyone may take it
    assert pages.acquire_lock(work, ["one"], session="s1")["session"] == "s1"
    pages.acquire_lock(work, ["one"], session="s2", force=True)
    assert pages.read_lock(work)["session"] == "s2"


def test_a_failed_check_is_a_warning_not_a_block():
    out = json.loads(hooks.failed("Stop", ValueError("bad registry")))
    assert out["stale"] == [] and "bad registry" in out["warnings"][0] and "decision" not in out
    out = json.loads(hooks.failed("SessionStart", ValueError("bad registry")))
    assert "bad registry" in out["hookSpecificOutput"]["additionalContext"]


def test_check_consumers_skips_missing_and_merges(tmp_path, monkeypatch, capsys):
    import sys as _sys
    _sys.path.insert(0, str(os.path.join(os.path.dirname(__file__), "..", "scripts")))
    import check_consumers as cc
    assert cc.consumers(tmp_path) == []
    assert cc.main(["--check"], base=tmp_path) == 0 and "no sibling" in capsys.readouterr().out

    def contract(*texts, warnings=()):
        return json.dumps({"stale": [{"name": t.split()[1], "text": t} for t in texts], "warnings": list(warnings),
                           "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "ignored by merge"}})
    noisy = "WARN something printed first\n" + contract("page x is stale") + "\nnot json {either\n"
    out = json.loads(cc.merge("SessionStart", [("a", noisy), ("b", ""), ("c", contract("page y is stale", warnings=["w"]))]))
    assert out["hookSpecificOutput"]["additionalContext"] == "[a] page x is stale\n[c] page y is stale\n[c] w"
    assert [(e["repo"], e["name"]) for e in out["stale"]] == [("a", "x"), ("c", "y")] and out["warnings"] == ["[c] w"]
    assert json.loads(cc.merge("SessionStart", [("a", ""), ("b", '{"stale": [], "warnings": []}')])) == {"stale": [], "warnings": []}
    out = json.loads(cc.merge("Stop", [("a", contract("republish x")), ("b", contract("republish y"))]))
    assert out["decision"] == "block" and out["reason"] == "[a] republish x [b] republish y"
    assert "decision" not in json.loads(cc.merge("Stop", [("a", "")]))


def test_cache_skips_unchanged_files_and_rereads_touched_ones(env, monkeypatch):
    path = env["root"] / "work" / pages.CACHE
    env["adapter"].cache = pages.FileCache(path)
    first = pages.fingerprint(entry(env), env["adapter"], env["config"])
    env["adapter"].cache.save()
    assert json.loads(path.read_text())["version"] == pages.FileCache.VERSION
    reads = []
    real = pages._sha_files
    monkeypatch.setattr(pages, "_sha_files", lambda paths: reads.append([n for n, _ in paths]) or real(paths))
    env["adapter"].cache = pages.FileCache(path)                     # a new run, from the saved file
    assert pages.fingerprint(entry(env), env["adapter"], env["config"]) == first and reads == []
    f = env["root"] / "batches/a/staging/staged.json"
    os.utime(f, (time.time() + 999, time.time() + 999))             # touched, same bytes: read again, same hash
    env["adapter"].cache = pages.FileCache(path)
    assert pages.fingerprint(entry(env), env["adapter"], env["config"]) == first and reads == [["staged.json"]]
    st = f.stat()
    f.write_text('{"x": 7}')                                         # same size, same mtime, new bytes: the cache cannot see it
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))
    publish(env)
    env["adapter"].cache = pages.FileCache(path)
    f.write_text('{"x": 8}')                                         # a real edit: stale with the right reason
    assert status(env)["reasons"] == ["staged work changed in batches/a/staging"]


def test_cache_is_the_same_hash_as_no_cache(env):
    plain = pages.fingerprint(entry(env), env["adapter"], env["config"])
    env["adapter"].cache = pages.FileCache()
    assert pages.fingerprint(entry(env), env["adapter"], env["config"]) == plain
    (env["root"] / "batches/b/staging/review_log.jsonl").unlink()
    assert pages.fingerprint(entry(env), env["adapter"], env["config"]) != plain


def run_cli(env, argv, build_page=None, **kw):
    return pages.cli(env["adapter"], env["entries"], build_page or (lambda e, a: (env["root"] / "work" / f"{e['name']}.html", "t1")),
                     argv, config=env["config"], last_build=env["last"], work=env["root"] / "work", **kw)


def test_cli_check_build_mark_and_list(env, capsys):
    with pytest.raises(SystemExit) as e:
        run_cli(env, ["--check"])
    assert e.value.code == 1 and "one\tunmarked" in capsys.readouterr().out
    built, pulled = [], []
    run_cli(env, [], build_page=lambda e, a: built.append((e["name"], a.no_pull)) or ("out.html", "t2"),
            pull=lambda a: pulled.append(a.no_pull))
    out = capsys.readouterr().out
    assert built == [("one", False)] and pulled == [False]
    assert f"two\tgoogle\trefresh with: {pages.GOOGLE_REFRESH}" in out and "one\thttps://claude.ai/artifact/x\tout.html" in out
    with pytest.raises(SystemExit, match="marks it"):
        run_cli(env, ["--mark-published", "two"])
    run_cli(env, ["--mark-published", "one"])
    assert "one marked published" in capsys.readouterr().out
    pages.mark_current(env["entries"], "two", env["last"], env["adapter"], env["config"], "t3")
    with pytest.raises(SystemExit) as e:
        run_cli(env, ["--check"])
    assert e.value.code == 0
    run_cli(env, [], build_page=lambda e, a: pytest.fail("nothing is stale"))
    assert "every page is fresh" in capsys.readouterr().out
    run_cli(env, ["--list"], columns=(("reviewer", lambda e: e.get("reviewer", "")), ("url", lambda e: e.get("url", ""))))
    rows = capsys.readouterr().out.splitlines()
    assert rows[0] == "name\treviewer\turl\tpublished at" and rows[1].startswith("one\t\thttps://claude.ai/artifact/x\t20")


def test_cli_build_takes_the_lock_and_mark_releases_it(env, capsys, monkeypatch):
    work = env["root"] / "work"
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "s1")
    run_cli(env, ["--only", "one"])
    assert pages.read_lock(work) == {**pages.read_lock(work), "session": "s1", "pages": ["one"]}
    capsys.readouterr()
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "s2")
    with pytest.raises(SystemExit) as e:
        run_cli(env, ["--only", "one"], build_page=lambda e, a: pytest.fail("built under another session's lock"))
    assert e.value.code == 3 and "another session is publishing one since" in capsys.readouterr().err
    with pytest.raises(SystemExit) as e:
        run_cli(env, ["--check"])
    assert "lock\tsession s1 is publishing one since" in capsys.readouterr().out
    run_cli(env, ["--mark-published", "one"])                             # s2 marking does not touch s1's lock
    assert pages.read_lock(work)["session"] == "s1" and "lock released" not in capsys.readouterr().out
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "s1")
    run_cli(env, ["--only", "one"])
    run_cli(env, ["--mark-published", "one"])
    assert "publish lock released" in capsys.readouterr().out and pages.read_lock(work) is None
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "s2")
    pages.acquire_lock(work, ["one"], session="s1")
    run_cli(env, ["--only", "one", "--force-lock"])
    assert pages.read_lock(work)["session"] == "s2"
    capsys.readouterr()

    def boom(e, a):
        raise RuntimeError("build failed")
    pages.release_lock(work, session="s2")
    with pytest.raises(RuntimeError):
        run_cli(env, ["--only", "one"], build_page=boom)
    assert pages.read_lock(work) is None                                   # a failed build keeps nobody waiting


def test_cli_hook_prints_the_contract_and_saves_the_cache(env, capsys, monkeypatch):
    import io
    env["adapter"].cache = pages.FileCache(env["root"] / "work" / pages.CACHE)
    monkeypatch.setattr("sys.stdin", io.StringIO('{"session_id": "h1"}'))
    run_cli(env, ["--hook", "SessionStart"])
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1 and [e["name"] for e in json.loads(lines[0])["stale"]] == ["one", "two"]
    assert (env["root"] / "work" / pages.CACHE).is_file()
    env["entries"].write_text("not json")
    monkeypatch.setattr("sys.stdin", io.StringIO('{"session_id": "h1"}'))
    run_cli(env, ["--hook", "UserPromptSubmit"])
    out = json.loads(capsys.readouterr().out)
    assert out["stale"] == [] and "page check failed" in out["warnings"][0]
