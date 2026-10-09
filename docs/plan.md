# gem-review-app: one review app, many trackers

Approved by Baird on 2026-10-08 after the GOGPT and pipelines review apps kept diverging: a change asked for in one landed in only that one. This repo holds the shared app. Each researcher repo keeps only what is genuinely its own and imports the rest from here, the way they already import the pull engine from `../gem-db-ops`: a sibling checkout, no copies.

## What lives where

**Here, shared core (`review_core/`)**: the page (`web/index.html`, `web/app.js`, `web/style.css`), the three store adapters (`web/static_store.js` for the single-file page and the artifact database, `web/gas.js` for Apps Script, and the loopback adapter inside `app.js`), the generic decision log (`store.py`: append-only `review_log.jsonl`, derived `review_decisions.json`, latest wins, undo, initials, atomic write with rollback, validation), the loopback server (`server.py`) with route hooks, and the single-file builder (`build_static.py`).

**Here, per tracker (`trackers/<name>/`)**: a Python config (`config.py`: the `TrackerConfig` below) and a page extension (`web/ext.js`, `web/ext.css`) registered through the hook points below. Nothing in a tracker folder is reachable without the core, and the core never names a tracker.

**In each researcher repo (`review_app/`)**: `review_data.py` (builds the dataset from that tracker's staging files; the only place that knows the staged record shapes), the ledger and its Google store (`ledger.py`, `pull.py`, `import_log.py`, `google.json`), workbook and push consumers (`build_review_package.py --decisions`, pipelines `push.py`, `publish.py`, `gas_push.py`), `artifacts.json` and `build_all.py`, and thin shims: `store.py`, `server.py`, `build_static.py` that bind the core to the tracker config so every existing import (`from review_app import store`, `import store`) and every existing test keeps working.

**Not moved**: anything that reads a researcher repo's staging files or talks to Google. The core never imports from a researcher repo.

## Layout

```
gem-review-app/
  README.md
  docs/plan.md                 this file
  review_core/
    __init__.py
    config.py                  TrackerConfig and the hook signatures
    store.py                   generic log logic, parameterized by a TrackerConfig
    server.py                  loopback server; tracker adds routes and caps
    build_static.py            single-file page builder (blob form)
    web/index.html             the one page skeleton, with named slots
    web/app.js                 core page logic; exposes window.ReviewApp and ReviewApp.define()
    web/style.css              shared styles and themes
    web/static_store.js        single-file and artifact database adapter
    web/gas.js                 Apps Script adapter
  trackers/
    gogpt/   __init__.py  config.py  web/ext.js  web/ext.css
    pipelines/ __init__.py  config.py  web/ext.js  web/ext.css
  tests/                       core tests on a synthetic tracker config, no researcher repo needed
```

A researcher repo finds this repo at `../gem-review-app` relative to its own root (same convention as `../gem-db-ops`); `review_app/__init__.py` puts it on `sys.path`. `GEM_REVIEW_APP` in the environment overrides the location.

## The dataset contract

`review_data.build(dirs, ...)` in each researcher repo returns one dict. The core reads only these keys; a tracker's extension may read anything else it put there.

- `cards`: the list of review cards (a plant for GOGPT, a pipeline for pipelines). Each card has `pid`, `name`, `dir` (the staging dir label, as records name it), `lines` (cell edits to decide), `items` (calls that are not cell edits), and any tracker fields. Existing datasets keep their old list too (`plants`, `pipelines`) as an alias of the same list objects until every consumer reads `cards`; `TrackerConfig.cards_key` names it.
- A line: `key` (globally unique, `<dir>::<record_id>`), `record_id`, `pid`, `dir`, `kind` (one of the tracker's line kinds), `column`, `current`, `proposed`, `refs`, `tier`, `severity` (`major` or `minor`), `note`, plus tracker fields. The core overlays `decision`, `decided_by`, `decided_at`, `suggested_value`, `reference`, `review_note` from the log.
- An item: `key`, `record_id`, `pid`, `dir`, `kind` (one of the tracker's item kinds), `title`, `body`, plus tracker fields. The core overlays `call`, `called_by`, `called_at`, `call_note`.
- `scope`, `columns`, `dirs`, `built` as today. `groups`, `links`, `us` (GOGPT) and `name_card`, `country_status` (pipelines) are tracker fields.

A decision record (one line of `review_log.jsonl`, one row of the store) has `key`, `dir`, `pid`, `record_id`, `reviewer` (initials in the sidecar, address in the Google store), `ts`, and either `decision` (accept, hold, reject, suggest) with optional `suggested_value`, `reference`, `note`, or `call` with optional `note`, or a tracker extra type (GOGPT `flag` with `on`). `undecided: true` is an undo. `id`, `scope`, `batch`, `snapshot`, `origin` are stamped by the ledger. Nothing in the core depends on the extra stamps.

## TrackerConfig (Python)

```
TrackerConfig(
  name,                       "gogpt" | "pipelines"
  cards_key,                  "plants" | "pipelines"
  line_kinds, item_kinds,     tuples
  item_calls,                 {item kind: tuple of calls}
  note_required,              {(kind, call)} pairs that need a note
  machine_reviewers,          set, kept verbatim in the store
  info_kinds,                 item kinds that take no call
  record_fields(line_or_item) -> the fields copied from the card line onto a record
  overlay_extras(dataset, paths)   hook after the core overlay (pipelines covers, drift; GOGPT pm flags)
  decide_extras(records, dataset)  hook for records a decision owes (pipelines rival/covers)
  extra_record_types          {name: validator} for tracker record types (GOGPT "flag")
  routes(server) -> [(method, path, handler)]   extra loopback routes
  caps                        {decide, refresh, push, flag, ...} the page is told about
  web_dir                     the tracker's web folder (ext.js, ext.css)
)
```

The fields above are the plan's shorthand; `review_core/config.py` is the authority and adds `title`, `other_calls`, `decisions`, `references`, `markers` (flag-style records beside a decision, such as the GOGPT ask-the-PM flag: the core derives the validator, writer, loopback route and overlay from the declaration), `legacy_keys`, `line_request`, `line_record`, `index_entry`, `index_extras` (fields that need the whole packed index, such as the pipelines concern answers and the top-level `w` and `cmd`), `exports`, `dynamic_caps`, `port` and `extra`; its docstring gives each hook's signature. `review_core.store.bind(config, root)` returns the module API bound to a config, so a shim can do `globals().update(bind(CONFIG, ROOT))`, or `bind(CONFIG, ROOT, into=sys.modules[__name__])` to bind straight into the shim module, and keep exporting `LINE_KINDS`, `ITEM_CALLS`, `decide`, `record_items`, `read_log`, `overlay`, `index`, `initials`, `dir_paths`, `latest`, `atomic_write`, `write_derived`, `_write`, `_LOCK`, `Invalid`, `now`, `read_jsonl`, `append_records`, `validate` and the rest under their current names. The write helpers (`atomic_write`, `append_jsonl`, `write_derived`, `rollback`) are looked up when a write runs, so a test that replaces one on the shim or on `review_core.store` still takes effect.

## Page hook points (JavaScript)

`app.js` builds `window.ReviewApp` and exports `define(tracker)`. `ext.js` loads after `app.js` and before boot, and calls `ReviewApp.define({...})` with any of these. Every hook is optional; the core behaves as the pipelines app does today without them.

- `id`, `title`, `QK` (filter keys in the hash), `defaults()` for filter state, `facets(line, item)` for extra filter dimensions and `match(line, item, filters)` for extra predicates.
- `slots`: HTML strings for named slots in `index.html`: `header-buttons`, `filters`, `filters-more`, `queue-pane` (GOGPT checklist tabs), `card-extra`.
- `prepare(card)` per-card derived fields; `queueRow(card)` the queue row text; `cardContext(card)` the context line; `groupLines(card)` how lines group on the card (units vs segments).
- `lineBody(line)` dispatch by kind for the body; `lineChips(line)` extra chips; `lineControls(line)` extra controls (accept candidate, PM box).
- `itemHead(item)`, `itemBody(item)`, `itemCalls(kind)` vocabularies, `noteRequired(kind, call)`.
- `applyRecord(record, line, item)` extras when a saved or remote record lands (machine records, drift, flags).
- `keys`, `help`, `info` text blocks; `firstRef(line)`, `suggestPrefill(line)`.
- `onReload(data)`, `onBoot()`, `poll()` for live state.
- `store`: extra store methods and routes the adapters expose (`flag` for GOGPT; `refresh`, `push`, `showGeo` for pipelines).

The core owns: severity and tier rendering, decisions and undo, the note box and its debounce, the suggest form, bulk accept, filters with facet counts and chips, hash routing, tip popovers, themes, the keyboard map, the help, info and progress dialogs, toast and banner, save → `Store.decide` → `applySaved` → `refilter` → `nextUndecided`, `prepare()` building `LINES`, `ITEMS`, `LINE_BY_KEY`, `ITEM_BY_KEY`, and `reload(data)`.

## Store interface (JavaScript)

`caps {decide, refresh, push, flag}`, `load()`, `whoami()`, `decide(records)`, `item(records)`; optional `ready()`, `open(url)`, `showGeo(path)`, `refresh()`, `poll()`, `state`, `flag(records)`, and for the single-file adapter `mode: "static"`, `download()`, `logs()`. `app.js` picks `window.GasStore || window.StaticStore || loopback`.

## Single-file page (blob form)

The builder takes the pipelines form for every tracker: the dataset is gzip-compressed, base64-embedded, with a packed key index, and the page decompresses it at boot. The GOGPT inline-JSON form is retired. The built page holds, in order: the title, one `<style>` with `style.css` then the tracker `ext.css`, the body of `index.html` with its local script and link tags removed, the dataset blob (`<script type="application/octet-stream" id="review-blob">`, base64 of gzip `{data, index}`), a boot script `window.REVIEW_STATIC = {reviewer, built, ledger_url, tracker}` where `tracker` is `TrackerConfig.page_block()` (the plain-JSON vocabulary: kinds, calls, note rules, markers, caps), then `static_store.js`, `app.js` and the tracker `ext.js`. The data and settings come before the scripts so every script can read them as it loads. Artifact pages keep their capabilities (`db`, `user`, `downloads`) and their existing URLs; each researcher repo's `build_all.py` and `artifacts.json` drive the rebuild and republish.

## Asks from the researcher repos

- **GOGPT, a captive power option in the checklist pane** (asked 2026-10-08 from gogpt-researcher). The GOGPT checklist tab (`queue-pane` slot) needs a way to pull up the captive power items on their own: the records that serve QC/Country checklist rows 6 and 44 (captive plants at LNG terminals, from the captive LNG sheet step; records carry `captive_lng: true` and `checks: [6, 44]`) and row 39 (gas-fired data centers, US only; watch items with `checks: [39]`). A chip or filter on the checklist pane that selects those three rows together, and shows their count, is enough; the row mapping already lives in gogpt-researcher's `review_app/checklist.py` (`CAPTIVE_COLUMNS`, the `captive` and `data center` concern words) and comes across with the GOGPT port.

## Phases

1. This plan; the shared core extracted from the pipelines app; GOGPT ported onto it (config, extension, shims); the GOGPT test suite passes unchanged except for file paths.
2. Pipelines ported the same way; its suites pass. Built and tested on 2026-10-08 in a scratch copy of pipelines-researcher (shims for `store.py`, `server.py` and `build_static.py`, `bundle.py` building the Apps Script page from the shared web files, its own `web/` removed); not yet landed in pipelines-researcher itself.
3. LNG carriers, later.

Verification for each port: the researcher repo's review tests pass; the loopback server serves its page and a headless browser renders a card and saves a decision; a single-file page builds and round-trips a decision through `static_store.js`; the live artifact pages are rebuilt and republished from the work profile.

## Rules carried over

Decisions never touch the GEM database, the staged files or the live sheets. The artifact pages publish only from the work profile. Every note a person reads is plain language. Commit messages lowercase, no attribution lines, and only when Baird asks.
