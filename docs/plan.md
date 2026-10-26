# gem-review-app: one review app, many trackers

Approved by Baird on 2026-10-08 after the GOGPT and pipelines review apps kept diverging: a change asked for in one landed in only that one. This repo holds the shared app. Each researcher repo keeps only what is genuinely its own and imports the rest from here, the way they already import the pull engine from `../gem-db-ops`: a sibling checkout, no copies.

## What lives where

**Here, shared core (`review_core/`)**: the page (`web/index.html`, `web/app.js`, `web/style.css`), the store adapters (`web/static_store.js` for the single-file page and the artifact database, and the loopback adapter inside `app.js`), the generic decision log (`store.py`: append-only `review_log.jsonl`, derived `review_decisions.json`, latest wins, undo, initials, atomic write with rollback, validation), the loopback server (`server.py`) with route hooks, and the single-file builder (`build_static.py`). Also the page registry logic (`pages.py`: content-hash fingerprints of what a live page was built from, the staleness check with plain-word reasons, `mark_published`) and the Claude Code hook output built on it (`hooks.py`); see `docs/refresh.md`. Tests for the core live in `tests/` (a synthetic tracker config, no researcher repo needed).

**Here, per tracker (`trackers/<name>/`)**: a Python config (`config.py`: the `TrackerConfig` below) and a page extension (`web/ext.js`, `web/ext.css`) registered through the hook points below. Pipelines also keeps the Apps Script adapter there (`web/gas.js`, `window.GasStore`, which `app.js` picks first); it names pipeline fields, and the Google web app path it serves has been parked since 2026-10-09. Nothing in a tracker folder is reachable without the core, and the core never names a tracker.

**In each researcher repo (`review_app/`)**: `review_data.py` (builds the dataset from that tracker's staging files; the only place that knows the staged record shapes), the ledger and its Google store (`ledger.py`, `pull.py`, `import_log.py`, `google.json`), workbook and push consumers (`build_review_package.py --decisions`, pipelines `push.py`, `publish.py`, `gas_push.py`), `artifacts.json` (the registry of live pages, with a `published` block per page) and `build_all.py` (`--check`, build, `--mark-published`, `--hook`, over `review_core.pages` with that repo's adapter), `.claude/settings.json` (the hooks), and thin shims: `store.py`, `server.py`, `build_static.py` that bind the core to the tracker config so every existing import (`from review_app import store`, `import store`) and every existing test keeps working.

**Here, scripts (`scripts/check_consumers.py`)**: runs the two sibling repos' page checks and hooks, so a session opened here hears about stale live pages after a change to the shared interface.

**Not moved**: anything that reads a researcher repo's staging files, and each tracker's half of the Google store code. The shared halves of `pull.py`, `ledger.py` and `import_log.py` and the `server.py` and `build_all.py` command lines now live in the core, and each repo's file keeps its settings and rules: `pull.py` its `google.json`; `ledger.py` its `COLS`, `ORIGINS`, `row_of`, `scope_of` and CLI; `import_log.py` what a record must match and how it picks the dataset; `build_all.py` its registry, adapter and build step. The core never imports from a researcher repo; the bound functions reach the repo's own `gws`, `store` and `pull` through the module that bound them.

## Layout

```
gem-review-app/
  README.md
  docs/plan.md                 this file
  review_core/
    __init__.py
    config.py                  TrackerConfig and the hook signatures
    store.py                   generic log logic, parameterized by a TrackerConfig
    server.py                  loopback server; tracker adds routes and caps; the shared server command line
    pages.py                   page registry: fingerprints, staleness check, mark_published, the build_all.py command line, the file cache
    hooks.py                   Claude Code hook output, a JSON contract (see docs/refresh.md)
    pull.py                    mirror the Google decision store into the staging dirs
    ledger.py                  the decision ledger: verified, chunked appends to the store's log tab
    import_log.py              bring artifact-page decisions into the ledger
    build_static.py            single-file page builder (blob form)
    basemap.py                 the gray basemap picture each route map shows on the artifact page (see Geo below)
    web/index.html             the one page skeleton, with named slots
    web/app.js                 core page logic; exposes window.ReviewApp and ReviewApp.define()
    web/style.css              shared styles and themes
    web/static_store.js        single-file and artifact database adapter
    web/geo.js                 route maps, basemaps, tile math, provenance images (see Geo below)
  scripts/check_consumers.py   runs the sibling repos' page checks and hooks
  trackers/
    gogpt/   __init__.py  config.py  web/ext.js  web/ext.css
    pipelines/ __init__.py  config.py  web/ext.js  web/ext.css  web/gas.js (Apps Script adapter, parked)
  tests/                       core tests on a synthetic tracker config, no researcher repo needed
```

A researcher repo finds this repo at `../gem-review-app` relative to its own root (same convention as `../gem-db-ops`); `review_app/__init__.py` puts it on `sys.path`. `GEM_REVIEW_APP` in the environment overrides the location.

## The dataset contract

`review_data.build(dirs, ...)` in each researcher repo returns one dict. The core reads only these keys; a tracker's extension may read anything else it put there.

- `cards`: the list of review cards (a plant for GOGPT, a pipeline for pipelines). Each card has `pid`, `name`, `dir` (the staging dir label, as records name it), `lines` (cell edits to decide), `items` (calls that are not cell edits), and any tracker fields. Existing datasets keep their old list too (`plants`, `pipelines`) as an alias of the same list objects until every consumer reads `cards`; `TrackerConfig.cards_key` names it. A tracker may give one subject more than one card (GOGPT: `card_kind` plant, addition or watch, with `plant_pid` the GEM id they share and `pid` suffixed `#add` or `#watch`); the core keys decisions by the line or item `key`, so card ids never reach the log.
- A line: `key` (globally unique, `<dir>::<record_id>`), `record_id`, `pid`, `dir`, `kind` (one of the tracker's line kinds), `column`, `current`, `proposed`, `refs`, `tier`, `severity` (`major`, `minor`, or a tracker value such as GOGPT's `check` for a line that only records that a plant was looked at), `note`, plus tracker fields. The core overlays `decision`, `decided_by`, `decided_at`, `suggested_value`, `reference`, `review_note` from the log.
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

`app.js` builds `window.ReviewApp` and exports `define(tracker)`. `ext.js` loads after `app.js` and before boot, and calls `ReviewApp.define({...})` with any of these (`define` also takes a function that gets the helper API `A` and returns the object). Every hook is optional; the core behaves as the pipelines app does today without them. A vocabulary key (`line_kinds`, `item_kinds`, `item_calls`, `other_calls`, `note_required`, `info_kinds`, `references`, `cards_key`, `name`) that `ext.js` leaves out comes from the built page's tracker block (`TrackerConfig.page_block()`). The core defaults for item calls are empty: every tracker supplies its own.

- Identity and vocabulary: `id`, `name`, `cards_key`, `words` (the card and line nouns), `line_kinds`, `item_kinds`, `item_calls`, `other_calls`, `note_required`, `info_kinds`, `kind_label`, `kind_tip`, `call_label`, `call_help`, `call_hint`, `sev_label`, `sev_tip`, `tier_tip`, `body` (kind to line renderer), `hideFields` (item fields left out of the details table).
- Filters and routes: `QK` (filter keys in the hash, in hash order), `defaults()` for filter state, `selectFilters` (extra select filters), `initFilters()`, `fillFilters()`, `syncControls()`, `renderChips()` and `activeChips(chip, "before" | "after")` for the chip row, `facetVal(o, facet)` the value a facet reads, `itemFacets` (facets whose counts include items), `itemsInView(filters, item, card)` (show items beside the lines), `match(o, card, filters, skip)` extra predicate, `counted(o)` (false for a line the page shows but does not count), `routeKey(data)` (browser storage key for the saved route; the core default is the tracker id plus the scope id), `routeEmpty` (how an empty multi-select is written in the hash), `routeArray(field, values)` (turns hash values back into filter state), `searchPlaceholder`.
- `slots`: HTML strings for named slots in `index.html`: `header-buttons`, `filters`, `filters-more`, `queue-pane`, `card-extra`.
- Queue and card head: `renderQueue()` (draws the whole queue pane; return true), `queueSection(card, prev, shown)` a section header before the first card of a new section (GOGPT's plant edits / proposed additions / watch list; empty string for none), `queueRow(card, i, parts)` the queue row, `queueShows(card)` false leaves a card out of the queue pane even when it is open (GOGPT's suggestions / to check / new tabs), `beforeSelect(card)` runs before a card opens and returns true when it moved the queue to another tab, `hideItemsSwitch: false` drops the "hide with items" switch, `hideDoneInFilters: true` moves the "hide done" switch into the filter row, `prepare(card, index)` per-card derived fields, `tally(card)` extra per-card counts, `showPid(card)`, `pidText(card)` the id the head shows, `pidTip`, `cardContext(card)` the context chips, `cardSub(card)` a line under the head, `cardPanel(panel)` a panel drawn in place of a card, `flatCard(card)` (true draws every line then the items with no tabs), `bulkButtons(card)` replaces the three bulk buttons (null keeps the core's; GOGPT returns none), `collapseTabs: true` folds the minor, items and everything tabs behind a + next to the major tab (a card open on one of them shows them all), `tabFoldNotice` a message shown in a dialog every time they open, `groupLines(card, lines)` how lines group on the card.
- Lines: `lineBody(line, card)` body by kind (return null to fall back), `lineDetails(line)`, `lineTitle(line)`, `lineWhere(line)`, `lineChips(line, chips)`, `lineClass(line)`, `dimmed(line)`, `lineActions(line)` the calls a line takes (`{buttons: [[decision, label, tip], ...], suggest}`; the default is accept, hold and reject with the suggest button, and the core refuses a decision a line does not offer), `lineButtons(line)` and `lineControls(line)` extra buttons and controls, `sevChip(line)`, `vmark(url, line)` the check mark on a link, `decisionText(line)`, `suggestPressed(line)`, `suggestPrefill(line)`, `suggestRef` (false hides the source link box), `noteBox(line)`, `noteRecord(line, record)` reshapes a re-saved note, `firstRef(line)`, `openRef(url, line)` opens a link the tracker's way.
- Items: `itemHead(item)`, `itemBody(item)`, `itemWhere(item)`, `itemClass(item)`, `itemChips(item)`, `itemFacts(item)`, `itemControls(item)`, `itemNoteHint(item)`, `itemCalls(kind, item)` per-item calls, `noteRequired(kind, call, item)`, `itemGroup` (`{of, order, label...}` grouping and order), `groupCount(items, nOpen)`, `openLoneGroup` (false keeps a lone group closed), `kindLabel(o, labels)`, `kindTip(o, tips)`, `kindClass(item)`, `hideField(name, item)`, `fieldLabel(name)`.
- Bulk accept: `bulkTargets(mode, line)` refuses a line (false, or a string naming a skip reason in `bulkSkip`), `bulkSkip` text per reason. The core modes are `bulk-minor`, `bulk-high` and `bulk-all`.
- Records and reloads: `applyRecord(record, line, item, remote, machine)` takes a saved or remote record first (return true; `machine` is given, a record or null, when the store chose `record` by its speaker rules, and is the line's latest machine record), `afterSave(saved)`, `afterReload(data)`, `onReload(data)`.
- Dialogs: `keys` (keyboard map additions), `help` (rows, or a function that edits them), `info` (HTML, or a function of the saved-where text), `progressItems` (false hides the item count), `progressNote()`, `progressHtml()`, `references` (false hides reference inputs).
- Lifecycle and events: `onInit()`, `onBoot()`, `poll()`, `onCardClick(e)`, `onCardChange(e)`, `onQueueClick(e)` (the first two return true when they handled the event).
- `store`: extra store methods and routes the adapters expose (`flag` for GOGPT; `refresh`, `push`, `showGeo` for pipelines).

The core owns: severity and tier rendering, decisions and undo, the note box and its debounce, the suggest form, bulk accept, filters with facet counts and chips, hash routing, tip popovers, themes, the keyboard map, the help, info and progress dialogs, toast and banner, save → `Store.decide` → `applySaved` → `refilter` → `nextUndecided`, `prepare()` building `LINES`, `ITEMS`, `LINE_BY_KEY`, `ITEM_BY_KEY`, and `reload(data)`.

## Store interface (JavaScript)

`caps {decide, refresh, push, flag}`, `load()`, `whoami()`, `decide(records)`, `item(records)`; optional `ready()`, `open(url)`, `showGeo(path)`, `refresh()`, `poll()`, `state`, `flag(records)`, and for the single-file adapter `mode: "static"`, `download()`, `logs()`, and `speak(key)`, `keysFor(key)`, `apply(o, group, record)`, which `applyRemote` uses to show a record that arrives after load by the store's speaker rules (a store without `speak` has its records laid on one at a time). `app.js` picks `window.GasStore || window.StaticStore || loopback` (`GasStore` comes from the pipelines-only `gas.js`, parked).

## Single-file page (blob form)

The builder takes the pipelines form for every tracker: the dataset is gzip-compressed, base64-embedded, with a packed key index, and the page decompresses it at boot. The GOGPT inline-JSON form is retired. The built page holds, in order: the title, one `<style>` with `style.css` then the tracker `ext.css`, the body of `index.html` with its local script and link tags removed, the dataset blob (`<script type="application/octet-stream" id="review-blob">`, base64 of gzip `{data, index, legacy}`), a boot script `window.REVIEW_STATIC = {reviewer, built, ledger_url, tracker}` where `tracker` is `TrackerConfig.page_block()` (the plain-JSON vocabulary: kinds, calls, note rules, markers, caps, and `rules`), then `static_store.js`, `app.js` and the tracker `ext.js`. The data and settings come before the scripts so every script can read them as it loads. `legacy` is `build_static.legacy_map()`: each line, item and marker key with the older keys the tracker's `legacy_keys` gives for it, so a call a browser logged under an older key still speaks for the line, by the same rule as `store.speaker`. `rules` is `store.page_rules()`: the request limits, the initials, email and web address patterns, and the line-kind and undo-reference rules, so `static_store.js` checks a record exactly as the store does without keeping its own copy of them. Artifact pages keep their capabilities (`db`, `user`, `downloads`) and their existing URLs; each researcher repo's `build_all.py` and `artifacts.json` drive the rebuild and republish.

## Geo: maps, routes already added, how a route was made (contract, 2026-10-21)

The pipelines plan is `pipelines-researcher/docs/plans/2026-10-21_review-app-route-maps.md`; this section is the part both trackers build against. The core still names no tracker: it ships the map and image tools and two field rules, and each tracker decides which of its lines carry them.

**Shared line fields** (the core and both extensions read them the same way):

- `line.applied`: `{by, at, ...}`. Any `by` means the change has already landed outside the page, and the line renders as done: no decision buttons, a chip saying when, never counted as undecided. `by` values in use: `push` (push.py wrote the cells), `routes_repo` (pipelines: the candidate geometry is already in the routes repo and the sheet row is mapped; adds `commit`, `sheet`), `apply_route_candidates` (the marker the §8 apply writes into the staged record from 2026-10-21; adds `commit`, `plan_token`, `backup`). A tracker may add fields; the core reads only `by` and `at`.
- `line.provenance`: `{text, facts, images, control_points}`, how the proposed value or geometry was obtained. `text` is one short plain paragraph. `facts` is a list of `[label, value]` or `[label, value, url]`. `images` is a list of `{role, caption, asset, url, path, width, height, source_url}` with `role` one of `map` (the snapshot the value was read or traced from), `overlay` (the trace drawn on that snapshot) or `render`; `path` is the repo-relative source file, `asset` the copy's name in `work/review_assets/`, `url` is filled only from the assets manifest (below), and on the artifact page an image with no `url` is listed by caption and not drawn. `control_points` is a list of `{name, px: [x, y], lon, lat, ref, residual_km}`. Every key is optional.

**Tracker-shaped fields** (one tracker each; the core never reads them):

- `line.geo` (pipelines, route lines): `{candidate, current, bbox, length_km, current_length_km, file, start_name, end_name}`. `candidate` and `current` are GeoJSON FeatureCollections (`current` is the routes-repo geometry for the ProjectID, or null), `bbox` is `[west, south, east, north]` over both, `file` is the candidate's path relative to its staging dir (the loopback server's `/geo/<dir>/<file>`). Rides in the dataset blob with everything else.
- `line.location` (GOGPT, point lines): `{method, current, proposed, moved_m, image, control_points, fit_m}` as `review_data.py` builds it today; `current` and `proposed` are `{lat, lon, accuracy, satellite, pin}`.

**`web/geo.js`** (core, inlined into the page before `app.js`, served at `/core/geo.js` by the loopback server) sets `window.ReviewGeo`:

- `BASEMAPS`: `map` (Esri World Street Map; CARTO Voyager was the first choice, but its tiles came back "API key required" on 2026-10-21), `satellite` (Esri World Imagery, the tiles GOGPT already uses), `hybrid` (the imagery with Esri's boundaries-and-places and transportation reference layers over it) and `gray` (Esri Light Gray Canvas with its reference layer, native tiles to zoom 16, so the route stands out), each `{url, attribution, maxZoom, subdomains, maxNativeZoom?, overlays?}`. A basemap with `overlays` is drawn as one Leaflet layer group, so switching basemaps swaps base and labels together. OpenStreetMap's own tile servers are not used (their usage policy excludes this kind of app). Live tiles work only on the loopback server: the artifact page's content security policy lets it load images from itself alone, so no Esri tile ever reaches it (found 2026-10-22). There the map shows one gray picture per route instead, with no basemap buttons. `review_core/basemap.py` stitches the Light Gray Canvas base and reference tiles around the route's bbox into a JPEG (long edge at most 2048 px, padded so a fitted map is covered) in `<repo>/work/review_assets/`, named by the sha256 of its tile range, and the builder's `basemap.attach(data, root)` sets `geo.basemap = {asset, bounds, zoom, width, height}`. The picture goes up with the other assets below, and `geo.js` draws it as a Leaflet image overlay with the map's max zoom capped at the picture's zoom plus 3. A route whose picture is not uploaded yet shows its lines on a blank ground. Caveat: Esri's terms limit storing tiles for offline use, which this does on a small scale.
- `tileXY(lat, lon, z)`: Web Mercator tile coordinates, the same math as `scripts/geo.py::tile_xy`. The GOGPT location block reads it and the satellite url from here (step 5); it keeps no copy of its own.
- `basemap()` and `setBasemap(name)`: the page-wide choice, kept in localStorage (wrapped in try/catch; `map` when storage is unavailable). Changing it redraws every live map.
- `loadLeaflet()`: one promise for the whole page; injects the Leaflet 1.9.4 script from cdnjs (pinned, with its SRI hash) the first time it is called, rejects after 15 seconds or on a load error. The Leaflet stylesheet is not fetched: it ships inlined as `web/leaflet.css` (image rules taken out), because the artifact page loads stylesheets only from Google Fonts. Vector layers go on only after the map has a view; Leaflet throws otherwise.
- `mapSlot(id, geo, opts)`: the HTML for one map, a `div.rmap` carrying `id` (the line key, plus a pane suffix when one line has two maps). The geometry is kept in a registry under `id` (a later call with the same `id` replaces it). An observer draws the map the first time the slot scrolls into view, so cards render as strings as they always have and Leaflet loads only when a map is actually seen. A redraw of the same `id` keeps the last view. `opts`: `{show: "candidate" | "current" | "both", label}`.
- Map behavior: basemap toggle buttons on the map, the candidate in the page accent color and the current route in gray, start and end markers named from `geo.start_name` and `geo.end_name`, fit to `bbox`, scroll-wheel zoom only after a click on the map, Leaflet keyboard handling off (the page owns the keys). If Leaflet does not load, the slot shows `map did not load` and nothing else breaks.
- `syncMaps(idA, idB)`: moving one map moves the other (the side-by-side panes for a route replacement, step 3).
- `pairSlot(id, geo, opts)`: a route and its replacement, for a line whose `geo.current` is set. Two panes side by side (`<id>#now` drawing `current`, `<id>#new` drawing `candidate`, joined by `syncMaps`; one column under 720 px) and an `overlay` button that swaps them for one map with both routes (`<id>#both`). The choice of view lasts across re-renders for the page's life. `opts`: `{currentLabel, candidateLabel, bothLabel}`. `review_data.py` fills `current` only when the routes-repo file differs from the candidate, so an added route carries no second copy.
- `imageBlock(images)` and `controlPointTable(points)`: the provenance pictures (map and overlay side by side, click for full size) and the control-point table (step 4).

**Builder rule.** `build_static.py` inlines `geo.js` between `static_store.js` and `app.js` (a core folder without it builds as before), reports the bytes of every `line.geo` in the dataset, and refuses a page whose geo payload is over 3 MB; the fallback at that point is to publish the geometry as artifact files fetched on demand.

**Assets** (step 4). Map snapshots never go in the page. `review_core/assets.py` makes the downscaled copy in `<repo>/work/review_assets/` (JPEG, long edge 1600 px, quality 80; a PNG at most 1600 px and 1 MB is copied as it is, a bigger one stays PNG when its downscale is under 1 MB) and names it `<sha256 of the source file>.<jpg|png>`; that name is the image's `asset` field in the dataset. An uploaded asset belongs to one artifact, so the per-repo manifest (`review_app/assets.json`, committed) is keyed by both: `{sha256: {artifact url: {url, uploaded, bytes}}}`. `build_static.py --artifact URL` fills `images[].url` from the manifest for that page (`assets.fill_urls`) and prints the asset names still missing; `PageAdapter.assets` lists a page's asset names, `pages.check` reports `assets missing: N` as a staleness reason, and `build_all.py --assets NAME` prints the files to upload. The files go up with the Artifact tool (`asset: true`, up to 25 per call), the results are recorded with `assets.record`, and the page declares the `assets` capability (restating its other capabilities, since a non-empty declaration replaces the set). The upload only works once the live version already declares `assets`, so the first time it is publish with the capability, then upload, record, rebuild, republish and mark published. A page that declares `assets` is organization-internal: it can no longer be shared outside the organization. The loopback server serves the same folder at `/asset/<name>` (names matching `^[0-9a-f]{64}\.(jpg|png)$` only), and the page uses that path when `window.REVIEW_STATIC` is absent; on the artifact page an image with no `url` shows its caption only.

## Asks from the researcher repos

- **GOGPT, a captive power option in the checklist pane** (asked 2026-10-08 from gogpt-researcher). The GOGPT checklist tab (`queue-pane` slot) needs a way to pull up the captive power items on their own: the records that serve QC/Country checklist rows 6 and 44 (captive plants at LNG terminals, from the captive LNG sheet step; records carry `captive_lng: true` and `checks: [6, 44]`) and row 39 (gas-fired data centers, US only; watch items with `checks: [39]`). A chip or filter on the checklist pane that selects those three rows together, and shows their count, is enough; the row mapping already lives in gogpt-researcher's `review_app/checklist.py` (`CAPTIVE_COLUMNS`, the `captive` and `data center` concern words) and comes across with the GOGPT port.

## Phases

1. This plan; the shared core extracted from the pipelines app; GOGPT ported onto it (config, extension, shims); the GOGPT test suite passes unchanged except for file paths.
2. Pipelines ported the same way; its suites pass. Built and tested on 2026-10-08 in a scratch copy of pipelines-researcher and landed in that repo on 2026-10-09: shims for `store.py`, `server.py` and `build_static.py`, `bundle.py` building the Apps Script page from the shared web files, its own `web/` removed. The gas batch artifact page was rebuilt and republished from the shared interface the same day.
3. LNG carriers, later.

Verification for each port: the researcher repo's review tests pass; the loopback server serves its page and a headless browser renders a card and saves a decision; a single-file page builds and round-trips a decision through `static_store.js`; the live artifact pages are rebuilt and republished from the work profile.

## Rules carried over

Decisions never touch the GEM database, the staged files or the live sheets. The artifact pages publish only from the work profile. Every note a person reads is plain language. Commit messages lowercase, no attribution lines, and only when Baird asks.
