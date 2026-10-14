# Keeping the review pages current

Written 2026-10-09 after a rebuilt pipelines batch (P0162, `deepsweep-tx-operating`) sat on disk all morning while the live review page still showed the dataset built 2026-10-02, and nothing anywhere said so. This plan adds a published-state registry, a staleness check, and hooks that run the check at the moments it matters. It is meant to be implemented from this document alone, by a Sonnet session, one repo at a time. Design decisions are settled below; the two left open for Baird are at the end.

**Update 2026-10-09:** the claude.ai artifact is the main surface and the Google web app is parked. The pipelines registry has only the `gas-batch` artifact entry, and the Google refresh steps below (the `google` kind, the Google row in the surfaces table, section 5) are not in use. The `google` kind stays supported in `pages.py` and `build_all.py` in case it is revived.

## The problem

A review page is a snapshot. Its dataset is built from the staging dirs, the decision logs and the snapshot CSV at build time, and nothing records what a live page was built from. So "is the page current?" has no answer short of rebuilding and comparing, and a batch rebuilt after a page went out is invisible until someone happens to notice.

Three surfaces, three refresh paths:

| Surface | Used by | Refresh | From a shell? |
|---|---|---|---|
| claude.ai artifact pages (pipelines: the gas batch page; gogpt: one page per reviewer in `review_app/artifacts.json`) | the reviewers | rebuild the html, then publish it to the same url with the Artifact tool, from the work profile (`~/.claude-gem`) | no: the Artifact tool exists only inside a Claude Code session |
| Google web app (pipelines only; `review_app/publish.py`) | reviewers without `gws` | `publish.py --upload --yes` writes the Drive data folder; the app switches within a minute | yes, under `gws-gem-write`; policy today is ask Baird before every run |
| loopback server (`review_app/server.py`) | Baird | `/api/refresh` (pipelines) or a restart | yes |

The artifact publish cannot be automated by cron, launchd or a git hook. What can be automated is knowing, deterministically, that a page is stale and why, and putting that in front of the one actor who can publish: the Claude Code session. Everything below follows from that.

## Design

### 1. The page registry: `review_app/artifacts.json` in each researcher repo

gogpt already has this file (name, title, reviewer, url, dirs). pipelines gets one with the same shape. Every live page is an entry, and so is the pipelines Google scope. Two additions per entry:

- `kind`: `artifact` (default) or `google`.
- `scope`: for pipelines pages that follow the review-app batch, `{"batch": true, "commodity": "gas"}` instead of a fixed `dirs` list, so the dirs are resolved at check time from `batches/review-app/manifest.json` and a new staging dir for an included country makes the page stale on its own. gogpt keeps explicit `dirs`.
- `published`: what the live page was built from, written only by `build_all.py --mark-published`:

```json
"published": {
  "built": "2026-10-09T14:02:11-04:00",
  "at": "2026-10-09T14:05:40-04:00",
  "profile": "gem",
  "fingerprint": "3f9c…",
  "parts": {
    "interface": "ab12…",
    "builder": "9e0d…",
    "manifest": "77c1…",
    "snapshot": "GGIT_gas_snapshot_20261005.csv",
    "dirs": {"batches/united-states-gas/staging/deepsweep-tx-operating": "c0ff…", "…": "…"},
    "decisions": {"batches/united-states-gas/staging/deepsweep-tx-operating": "d00d…", "…": "…"}
  }
}
```

`fingerprint` is the hash of `parts`; `parts` exists so the check can say which input changed. Initial pipelines entries: the gas batch page `https://claude.ai/artifact/31WzSbN54wUGHAaPirimcz` (kind `artifact`, batch scope, gas) and the Google scope `review-app-gas` (kind `google`, batch scope, gas). Their `published` blocks start empty, which the check reports as "never marked"; the first real build and publish fills them.

### 2. Shared logic: `review_core/pages.py`

Both repos need identical semantics, so the logic lives in the core and each repo supplies a small adapter. The core never imports from a researcher repo (plan.md rule), so the adapter is passed in.

```python
PageAdapter(
  resolve_dirs(entry) -> list[Path]        # explicit dirs, or the review-app batch for pipelines
  staged_files                              # filenames the dataset builder reads, per dir
  decision_files                            # ("review_log.jsonl",)
  extra_inputs(entry) -> dict               # snapshot name (pipelines), export csv sha (gogpt), manifest sha
  builder_files                             # repo files whose change means rebuild: review_data.py, build_static.py shim, publish.py
  build(entry, stamp) -> (html_path, built) # calls the repo's existing build; google kind calls publish.publish(write=False)
)
```

Core functions:

- `fingerprint(entry, adapter, config)` returns `(fingerprint, parts)`. `interface` is the sha256 over `review_core/web/*`, `trackers/<name>/web/*`, `review_core/build_static.py`, `review_core/config.py`, `trackers/<name>/config.py`, sorted by relative path. `builder` is the same over the adapter's `builder_files`. Each dir in `dirs` is the sha over its `staged_files` that exist; each in `decisions` over its `decision_files`. Content hashes, never mtimes (Dropbox and clones make mtimes meaningless).
- `check(entries, adapter, config)` returns one report per entry: `fresh`, `stale` with the list of reasons, or `unmarked`. Reasons are plain words at part granularity: `interface changed`, `builder changed`, `manifest changed`, `snapshot changed (20261002 to 20261005)`, `staged work changed in <dir>`, `new staging dir <dir>`, `staging dir gone <dir>`, `decisions changed in <dir>`. Staged-work and new-dir reasons are listed before decision reasons, because the first kind is what reviewers are waiting for and the second is routine.
- `mark_published(entries_path, name, last_build)` copies the `built` and `parts` of the last build of that page from `work/review_pages_last_build.json` into the entry and stamps `at` and `profile` (`gem` when `CLAUDE_CONFIG_DIR` ends in `.claude-gem`, else `personal`). It refuses when the current fingerprint differs from the last build's (something changed between build and publish: build again).
- `hook(event, stdin_json, reports)` formats the hook output described in section 4. Lives in `review_core/hooks.py`.

### 3. The commands: `review_app/build_all.py` in each researcher repo

gogpt's exists and keeps its interface; pipelines gets one. Both become thin callers of `review_core.pages` with their adapter.

```
python review_app/build_all.py --check            # every entry: fresh / stale (why) / unmarked; exit 1 if any stale or unmarked
python review_app/build_all.py [--only NAME]      # build the stale entries (or all with --all): html into work/, google kind into work/review_publish
python review_app/build_all.py --mark-published NAME   # after the Artifact publish (or publish.py --upload --yes) succeeded
```

A build writes `work/review_pages_last_build.json`: `{name: {built, parts, fingerprint, file}}`. The build output table (name, reviewer, url, file) is what the session publishes from, one Artifact publish per artifact entry, to the entry's `url`, from the work profile. The session then runs `--mark-published` for each. That step is the only one that stays manual by nature: only the session knows the publish succeeded. For a `google` entry the build is `publish.publish(write=False)` and the refresh is `publish.py --upload --yes`, which marks itself published on success (publish.py calls `pages.mark_published` after the scopes.json switch).

`--check` is fast (hashing a few hundred MB at most) and makes no network call. It never pulls the decision store; a stale `review_log.jsonl` is caught when `pull.py` runs as part of the build, not by the check.

### 4. Hooks: run the check without anyone remembering

Committed `.claude/settings.json` in `pipelines-researcher`, `gogpt-researcher` and `gem-review-app` (none of the three has one today; `settings.local.json` is personal and stays untouched). Every hook runs `python review_app/build_all.py --hook <event>` (in gem-review-app, a small `scripts/check_consumers.py` that runs the two sibling repos' checks, skipping a checkout that is missing). The hook reads the event JSON on stdin and prints what Claude Code expects; the implementer verifies the exact output contract against the current hooks reference before relying on it.

- `SessionStart`: print the report as context (`hookSpecificOutput.additionalContext`), one line per stale page with its reasons and the publish instruction, including which profile the session is on (publishing from the personal profile is a known defect: the artifact's shared log cannot then be read from the work account). Also write the current fingerprints to `work/.review_pages_session_<session_id>.json` for the Stop guard.
- `UserPromptSubmit`: same report, only when it differs from the last one printed in this session (keep the last report beside the session file), so it does not repeat on every prompt.
- `Stop`: compare the current fingerprints with the session file. If this session changed a page's inputs and the page has not been marked published since, block the stop once with the reason "review page NAME is stale from this session's changes (reasons); rebuild with build_all.py, publish to URL from the work profile, then --mark-published", so the turn ends by republishing instead of leaving the page behind. The input's `stop_hook_active` flag is honored: when it is set the hook never blocks again, so there is no loop, and a page Baird chooses to leave stale costs one extra message at most. A page stale from changes made outside this session is reported at SessionStart and never blocks.
- Exit 0 with an empty output when every page is fresh. The hooks never build, never publish and never write anything but the two files under `work/`.

The pipelines delivery checklist (`docs/workflows.md`, "Review-app batch, ask at every delivery") gains one line beside the `scopes.py check`: run `build_all.py --check`, and rebuild and republish what it lists before the delivery note goes out. gogpt's `docs/workflows.md` review step gets the same line.

### 5. The Google scope, and the only truly unattended piece

`publish.py --upload --yes` is a shell command under `gws-gem-write`, so for the pipelines Google scope a launchd job could run `build_all.py --check` and republish with no session at all. That needs a standing authorization for writes to that one Drive data folder (`review_app/google.json: data_folder_id`), of the same shape as the `log` tab authorization in the pipelines CLAUDE.md. Until Baird grants it, the Google entry is checked and reported like the others and refreshed by the session, asking per run as today. The launchd job is a later step and is not part of this plan's build.

### 6. Out of scope

The loopback server. Pipelines has `/api/refresh`; gogpt's server rebuilds on restart. A `--watch` flag that rebuilds when inputs change is cheap to add to `review_core/server.py` later and would use the same `fingerprint` function; not now. Nothing here changes what a page shows, how decisions are recorded, or any write to the GEM sheet, the routes repo, the staging files or the decision store.

## Tests

In `gem-review-app/tests/` on the synthetic tracker (`conftest.py`), with a fake adapter over temp dirs:

- `fingerprint` is stable across runs and across a copy of the tree with different mtimes; changes when one byte of a staged file, a web file, the manifest or a decision log changes; a new dir and a removed dir change `parts.dirs`.
- `check` reports `unmarked`, `fresh`, and each reason string exactly once for each kind of change, staged-work reasons before decision reasons.
- `mark_published` writes `built`, `at`, `profile`, `fingerprint`, `parts`; refuses when the tree changed since the last build; leaves other entries byte-identical.
- `hook`: SessionStart output shape and the session file; UserPromptSubmit prints only on a changed report; Stop blocks exactly once for a session-made change, never with `stop_hook_active`, never for a pre-existing stale page, never when fresh.

In each researcher repo's review tests: the adapter resolves the right dirs (pipelines: the review-app batch for an included country, the tracker-wide owner-style dir, explicit `dirs`; gogpt: explicit dirs plus `staging-discovery`), `build_all.py --check` runs end to end on the committed staging tree and exits 1 while the entries are unmarked.

## Order of work

1. gem-review-app: `review_core/pages.py`, `review_core/hooks.py`, tests. Commit.
2. gogpt-researcher: adapter, `build_all.py` extended (`--check`, `--mark-published`, `--hook`), `artifacts.json` entries gain `kind` and empty `published`, `.claude/settings.json`, workflow doc line, README section "Keeping every page identical in interface" extended with the check. Commit.
3. pipelines-researcher: `review_app/artifacts.json` (two entries), `build_all.py`, adapter (dirs from `scopes.included` plus `staged_store.discover_staging_dirs` and `trackerwide_dirs`, the same discovery `review_data.main` uses with no `--country`), `publish.py` marks itself published, `.claude/settings.json`, workflow doc line, README: the "Artifact version" section points at `build_all.py`, and the stale line at the top saying the Google version "is NOT deployed yet" is corrected (it went live 2026-10-01; see the "Live drift check" paragraph in the same file). Commit.
4. gem-review-app: `scripts/check_consumers.py` and its `.claude/settings.json`; this document's status line updated; `docs/plan.md` "What lives where" gains `pages.py`, `hooks.py` and the registry. Commit.
5. From a work-profile session: build both repos' pages, publish each to its url, `--mark-published` each, commit the registries. From then on the hooks carry it.

Each commit only when Baird asks, lowercase, no attribution lines. All three repos are Baird's own.

**Standing rule (2026-10-09):** whenever a session changes the review app source, it rebuilds and republishes every stale artifact page in the same turn, marks each one published, and does not ask first. The artifact pages are the registered ones only. The Google scope still needs an ask.

## Open for Baird

- **Stop hook: block once, or report only?** The plan says block once, only for changes this session made, because a Stop hook has no non-blocking way to speak to the model (its plain output goes to the transcript, not to Claude). If Baird prefers report only, drop the Stop entry and rely on SessionStart and UserPromptSubmit.
- **Standing authorization for `publish.py --upload --yes` against the review-app Drive data folder.** Yes makes the Google scope fully unattended through a launchd job (a later step). No keeps the per-run ask.

## Status

Planned 2026-10-09. Step 1 done 2026-10-09 (`review_core/pages.py`, `review_core/hooks.py`, `tests/test_core_pages.py`, not committed). Step 2 done 2026-10-09 (gogpt-researcher, not committed; the entries have no `published` key until first marked, which the check reads as unmarked). Step 3 done 2026-10-09 (pipelines-researcher, not committed; the Google entry is marked by `publish.py --upload --yes` itself, and `build_all.py` only reports it). Step 4 done 2026-10-09 (`scripts/check_consumers.py`, `.claude/settings.json`, `docs/plan.md`, not committed). Step 5 (publish and mark each page from a work-profile session) is the only step left; the pipelines `gas-batch` page already carries a `published` block from a work-profile session.
