# Pipelines reviewer: UX, UI and design audit (2026-10-22)

Audit of the pipelines review page (`gas-batch`, scope gas = Russia, Ukraine, United States) as built from this repo plus `pipelines-researcher/review_app`. Each finding has a stable id, a severity, the code it anchors to, what was observed, and a fix sketch. Tick the checkbox when a finding is closed; add a one-line note after it if the fix differed from the sketch. Findings marked `data` need a change in `pipelines-researcher/review_app/review_data.py`, not here. The standing rule applies to every fix: after any source change, rebuild and republish every stale page in the same turn (`docs/refresh.md`).

## How this audit was made

- Page built with `python3 review_app/build_static.py --no-pull --out <scratch>/gas-batch.html` in pipelines-researcher: 1,305 pipelines, 7,402 lines, 6,561 items, 37 route lines, snapshot `GGIT_gas_snapshot_20261020.csv`.
- Screenshots taken with Playwright driving installed Chrome 155 at 1440x900, 700px wide, light, dark and the nord theme. Scripts and shots are in `work/audit_2026-10-22/` in this repo (gitignored): `shoot.py`, `shoot2.py`, `shots/desk-*.png`, `shots/narrow-*.png`, `shots/x-*.png`, `shots/log.txt`. The scripts expect a built page at `gas-batch-local.html` beside them, which is the built fragment with a doctype, charset and viewport meta prefixed (see A5). Rerun them against a fresh build to reproduce any shot.
- Decisions made during the screenshot runs stayed in throwaway browser contexts. Nothing was synced to the decision store.
- No console errors or page errors in any run.

## Priority order

Work top to bottom. P1 items change what gets written to the sheet or block the reviewer outright. P2 items cost clicks on every card. P3 items are polish.

| id | severity | one line |
|---|---|---|
| A1 | P1 | `c` on a rival line logs the concern's prose sentence as the suggested Owner value |
| A2 | P1 | Concern filters open cards on an empty major/minor tab; the concern sits two clicks away |
| A3 | P1 | Download filename joins every batch dir name (about 2.4 KB; macOS caps at 255 bytes) |
| A4 | P1 | Tip popover intercepts clicks on what sits beneath it |
| A5 | P1 | Built fragment has no charset or viewport meta; local opens render mojibake |
| B1 | P2 | Routes never show current vs candidate; data sets current to None (`data`) |
| B2 | P2 | QC failure shows no reason; ratio shown as a bare number |
| B3 | P2 | Null sheet length hides the row instead of saying "none" |
| B4 | P2 | Start/end markers nameless for 34 of 37 routes (`data`) |
| B5 | P2 | Map scroll zoom gated on click with no hint; keyboard off; fixed 300px height |
| B6 | P2 | Route suggest offers a free-text value box |
| B7 | P3 | Route footer line is jargon with a section glyph and inline style |
| B8 | P3 | Basemap tile seam and label collisions |
| C1 | P2 | Header scope chips duplicate the fuel/country dropdowns and look static |
| C2 | P2 | "accept all high-conf changes" stays enabled when nothing qualifies |
| C3 | P2 | Feedback is inconsistent: toast on suggest, none on accept; keyboard advances, click does not |
| C4 | P2 | Counts disagree across progress, decision filter, tabs and the how-to dialog |
| C5 | P3 | Note box renders narrow and truncates so a long note reads as a button |
| C6 | P3 | Second filter row is mostly whitespace; batch dropdown lists raw staging dir names |
| C7 | P3 | Queue rows rely on color for tier and severity |
| C8 | P3 | Rival candidate and ref rows show raw strings; long concern blocks push buttons off screen |
| C9 | P3 | Narrow layout is cramped (header three lines, 30vh queue strip) |
| D1 | P2 | Undo is logged as a hold with undecided true rather than a retraction |
| D2 | P3 | Note edits re-save a full record every 250 ms pause |
| D3 | P3 | Accept auto-dismisses linked concerns silently; candidate press logs suggest plus rival |
| D4 | P3 | Bulk accept silently scoped to the filtered view |
| D5 | P3 | Dismissing an item with an empty note is allowed |

## A. Blocking and correctness

### A1. Candidate button pushes prose into a sheet cell (P1, partly `data`)

- [ ] closed
- Where: `trackers/pipelines/web/ext.js:1024-1033` (`lineButtons`, the `.b-candidate` button), `ext.js:9-15` (`concernsOf`, `cand`), `ext.js:357` (the "concern candidate" row), `ext.js:78-86` (the suggest+rival to confirmed call). Data side: `review_data._attach_rivals` in pipelines-researcher.
- Observed: on P1783 Owner (owners tab, rival candidate), pressing `c` wrote `{decision: "suggest", suggested_value: "Sakhalin Energy LLC (100.00%) — value confirmed correct, but final resting place of Shell's former 27.5%-minus-1-share stake is not cleanly resolved in available sources", rival: "...#VALIDITY2"}`. The UI shows the same sentence as the highlighted "concern candidate" value and the dstat reads "concern's candidate taken: Sakhalin Energy LLC (100.00%) — value confirmed correct, but ...". A later push would write that sentence as Owner. Shot: `x-candidate-taken.png`.
- Fix sketch: (data) have `_attach_rivals` only emit a rival when the contested value parses as a clean cell value, and split any trailing " — " commentary into the concern body. (UI) in `rivalsOf` or `liveRivals`, refuse a candidate whose value is longer than, say, 80 characters or contains " — " or ends in a sentence, and render it as "candidate not usable as a cell value: use suggest" instead of a button. Add a test in `tests/` for the refusal.

### A2. Concern filters open the wrong tab (P1)

- [ ] closed
- Where: `review_core/web/app.js:100` (`defaultTab` picks major/minor from line severity only), `app.js:246` and `app.js:465` (tab reset on card change), `app.js:705` (`openLoneGroup`), `trackers/pipelines/web/ext.js:1051` (`openLoneGroup: false`).
- Observed: with kind = concern (1,185) or "unanswered concerns" checked, every card opens on an empty major or minor tab showing "1 more change on this pipeline is hidden by the filter. show all", while the matching concern sits on the items tab inside a collapsed "concern (1)" group. Reaching the one thing the filter asked for takes two extra clicks per card. Shots: `desk-14-concern.png`, `desk-18-contested.png`, `desk-19-contested-items.png`, `desk-20-items-open.png`.
- Fix sketch: make `defaultTab` filter-aware: when the active filters match zero lines on the card and at least one item, open items. Keep `openLoneGroup: false` as the pipelines ruling from 2026-10-02, but when the filter itself is an item filter (kind in item kinds, unanswered concerns), open the single matching group. Add a test for both.

### A3. Download filename is unbounded (P1)

- [ ] closed
- Where: `review_core/web/static_store.js:647-661` (`download`, `name0` joins every dir in `G.dirs`).
- Observed: suggested filename for gas-batch is about 2.4 KB (`review_log_deepsweep-r1-fareast+deepsweep-r2-nw-operating+... 80 more ..._BL_20261022_0847_ET.jsonl`). macOS limits a filename to 255 bytes, so Chrome truncates or the save fails. The artifact path (`G.dl.save`) uses the same `name0` and hits the same limit.
- Fix sketch: name the file after the scope (`review_log_gas-batch_BL_20261022_0847_ET.jsonl`), falling back to the joined dirs only when there are at most three. The scope name is in `window.REVIEW_STATIC`; the dir list already travels inside the file as `dirs` in the artifact JSON form, so add it to the jsonl form as a first header record if import needs it (`review_app/import_log.py` in pipelines-researcher reads these files; check it tolerates a header line or keep the dirs out of the name only).

### A4. Tip popover blocks clicks (P1)

- [ ] closed
- Where: `review_core/web/style.css:524` (`.tip` has `pointer-events: auto`), `review_core/web/app.js:1463-1500` (tip show/hide; hides 150 ms after mouseout, never on click).
- Observed: after clicking a tab while the mouse rests, the tip stays open over the card. A Playwright click on the group summary beneath failed with "`<div class="tip-head">` intercepts pointer events". A real mouse user sees the click swallowed. Shot: `desk-19-contested-items-tipstuck.png`.
- Fix sketch: hide the tip on any `click` and on `keydown` (except inside the scrollable `.tip-note`), and set `pointer-events: none` on `.tip` unless it carries a `.tip-note` that needs scrolling. Keep the hover-to-stay behavior only for the scrollable variant.

### A5. Built fragment has no charset or viewport meta (P1)

- [ ] closed
- Where: `review_core/build_static.py:4` (docstring says "a browser opening the file from disk does the same"; it does not), the builder's head assembly.
- Observed: opening the raw built file from disk renders every non-ASCII glyph as mojibake (⧉ as "â§‰", · as "Â·", ↗ as "â†—", ✓ as "âœ“", § as "Â§") because Chrome reads it as Windows-1252. The artifact host adds `<meta charset>` and a viewport meta itself (seen in the live page head), so the published page is fine, but local QA and the loopback server page differ from it.
- Fix sketch: emit `<meta charset="utf-8">` and `<meta name="viewport" content="width=device-width, initial-scale=1">` at the top of the fragment (the Artifact wrapper tolerates a second charset meta; verify once after publishing), and correct the docstring. Then the screenshot scripts no longer need the `gas-batch-local.html` prefix copy.

## B. Route maps

### B1. No current-versus-candidate comparison (P2, `data`)

- [ ] closed
- Where: pipelines-researcher `review_app/review_data.py:1030-1033` (`"current": None`, `"current_length_km": None`), `review_core/web/geo.js:154-156` (supports `show: "both"` with a dashed gray current route), `trackers/pipelines/web/ext.js:456` (`show: "candidate", label: "proposed"`).
- Observed: all 37 route lines carry `geo.candidate` and none carry `geo.current`, so the page never draws a current route even though 4 of them replace an existing sheet route (P7861, P7862, P8309, P8327 have `sheet_length_km`). The "PROPOSED" label implies a comparison that never appears.
- Fix sketch: in `review_data.py`, when the sheet row already has a route (route columns say mapped, or a current geometry file exists in the tracker's route store), load it as `current` with `current_length_km`, and have `lineBody` pass `show: "both"` when `geo.current` exists. When there is no current route, change the label from "proposed" to "new route" so the word does not promise a comparison.

### B2. QC failure shows no reason; ratio is a bare number (P2)

- [ ] closed
- Where: `trackers/pipelines/web/ext.js:448-454` (length rows and the QC chip). Data: `review_data.py:981` passes `qc_passed` only; the route QC store in pipelines-researcher (`route_state.py`, the `qc` staging dir) holds the reasons.
- Observed: P7861 shows "QC ✗ did not pass" with nothing else and "ratio 0.493" with no hint that the trace is half the sheet length. Shot: `x-route-P7861.png`.
- Fix sketch: carry a `qc_notes` string (or list) from the QC record into the line and print it under the chip. Tint the ratio row with `tint-low` when it falls outside the QC band (whatever `route_state.py` uses, likely 0.8 to 1.25) and add "(trace is 49% of the sheet length)" in words.

### B3. Null sheet length hides the row (P2)

- [ ] closed
- Where: `trackers/pipelines/web/ext.js:448-450` (rows with empty values are dropped).
- Observed: on P8092 only "candidate length 235 km" shows. The reviewer cannot tell whether the sheet has a length to compare against or the builder failed to find one.
- Fix sketch: render "sheet length: none on the sheet" in the muted style when `sheet_length_km` is null, and skip the ratio row with "ratio: no sheet length to compare".

### B4. Start and end markers are nameless (P2, `data`)

- [ ] closed
- Where: `review_core/web/geo.js:158-161` (tooltip is "start: name" when `start_name` exists, else "start"), `review_data.py:1033` (`start_name` from the geometry record only).
- Observed: 3 of 37 routes carry names; the rest show "start" and "end". On P8092 the basemap label "Wasilla" collides with the start marker.
- Fix sketch: fall back to the sheet row's Start and End columns (`rec["Start"]`, `rec["End"]` or whatever the tracker calls them) when the geometry record has none. Offset the tooltip direction to `right` so it clears basemap labels more often.

### B5. Map interactions are undiscoverable (P2)

- [ ] closed
- Where: `review_core/web/geo.js:142` (`keyboard: false, scrollWheelZoom: false`), `geo.js:166-167` (enable on click, disable on mouseout), `review_core/web/style.css` `.rmap { height: 300px }` and `.rmap-wrap { max-width: 760px }`.
- Observed: scroll zoom only works after a click and nothing says so. Keyboard navigation is off. The map is 760 by 300 pixels on a 1440 wide window, small for a 235 km route with a spur. Shots: `desk-04-route-line.png`, `desk-05-route-satellite.png`, `desk-06-route-tooltip.png`.
- Fix sketch: add a "click the map to zoom with the wheel" hint to the `.rmap-bar` that disappears after the first click, re-enable keyboard when the map container has focus (`tabindex="0"`), and add an "expand" button in the bar that toggles the wrap to full card width and 70vh. Persist the expanded state next to `review-basemap` in localStorage.

### B6. Route suggest offers a free-text value (P2)

- [ ] closed
- Where: `trackers/pipelines/web/ext.js:1100` (`suggestPrefill`), `review_core/web/app.js:994-1021` (the inline `.sform`).
- Observed: pressing `s` on a route line shows an empty value box plus a note box. Typing "x" and Enter logs "suggested: x" on a geometry line. Shots: `desk-07-route-suggest.png`, `x-route-suggested.png`, `x-after-keyboard-accept.png` (toast "suggestion saved").
- Fix sketch: for `kind === "route"`, render the suggest form with the note box only and a label "what should change about this trace", and log `suggested_value: ""` with the note. If a reviewer can point at a different geojson, make that a URL field instead.

### B7. Route footer line is jargon (P3)

- [ ] closed
- Where: `trackers/pipelines/web/ext.js:458` (`"accepting records approval for the §8 apply; it writes no cell."`).
- Fix sketch: "Accepting approves this route for the next apply run. It does not write a cell." Move the inline-styled faint text to the `.faint` class.

### B8. Basemap tile seam and label collisions (P3)

- [ ] closed
- Where: `review_core/web/geo.js` basemap definitions (Esri World Street Map and World Imagery).
- Observed: on P7861 adjacent Esri street tiles render in two visibly different styles with a hard vertical edge through the route. Place labels collide with markers (B4).
- Fix sketch: try Esri World Topo or Carto Voyager as the street basemap and compare at zoom 9 to 11; keep Esri imagery for satellite. This is a tile-server artifact, so a basemap swap is the only lever.

## C. Ease of use and visual consistency

### C1. Header scope chips duplicate the filter dropdowns (P2)

- [ ] closed
- Where: `trackers/pipelines/web/ext.js:292-298` (`.cbox` fuel and country chips with click toggles), `review_core/web/index.html:14` (`#scope`), the fuel and country dropdowns in the `filters` slot.
- Observed: the header shows "gas / Russia / Ukraine / United States" as tinted boxes that toggle countries on click, and the filter row shows fuel and country dropdown buttons that do the same. The chips look static, so the toggle is a surprise.
- Fix sketch: keep the header chips as read-only scope text ("gas · Russia, Ukraine, United States") and leave toggling to the dropdowns, or drop the dropdowns and give the chips an obvious toggle affordance (checkbox glyph). One surface only.

### C2. "accept all high-conf changes" stays enabled when nothing qualifies (P2)

- [ ] closed
- Where: `review_core/web/app.js:731-739` (bulk-minor and bulk-all compute `on` and set `.off` with a `data-why`; bulk-high at `app.js:734` does not), `app.js:1225-1226` (the "nothing to accept in view" toast).
- Observed: on P8096 (1 medium, 1 unrated) the button is enabled and clicking toasts "nothing to accept in view (skipped: 1 not high confidence)". The three bulk buttons are also visually heavier than the per-line accept. Shots: `desk-03-route-card.png`, `desk-26-bulk.png`.
- Fix sketch: compute `on` for bulk-high the same way as the other two and render `.off` with a why. Reduce the bulk buttons to the ghost style and 14 px so the per-line buttons read as the primary action.

### C3. Inconsistent feedback and advance behavior (P2)

- [ ] closed
- Where: `review_core/web/app.js:1045` (toast "suggestion saved"), `app.js:858` and the accept path (no toast), `app.js:985-991` (`nextUndecided` runs only after a keypress).
- Observed: accept shows only the small dstat "accepted by BL 08:37"; suggest shows a toast as well. Keyboard decisions advance to the next open line; clicks stay put. New users do not learn either rule from the UI.
- Fix sketch: pick one feedback channel (the dstat is enough; drop the suggest toast or add the same toast to accept, hold and reject). Make click decisions advance too, or add a "stay on this change after deciding" switch next to "hide done" so the behavior is visible and chosen.

### C4. Counts disagree across surfaces (P2)

- [ ] closed
- Where: progress dialog (`review_core/web/app.js`, `progress-btn` handler), decision filter counts (`fitSelect` and the `#f-decision` options), tab labels (`app.js` tab rendering), how-to dialog text at `trackers/pipelines/web/ext.js:712`.
- Observed: progress says "75 of 108 changes decided"; the decision filter says "accept (7131)"; a tab says "items (6 to decide) · 1 shown"; the how-to dialog says "Nothing here is in the backend yet" while 7,228 lines carry an "in backend" chip. Each number is right for its own population (progress excludes landed lines), but nothing says so. Shots: `desk-24-howto.png`, `desk-25-progress.png`.
- Fix sketch: add one sentence to the progress dialog ("changes already written to the sheet are not counted here; N of them are in this view") and fix the how-to text to "Changes marked in backend are already on the sheet; the rest need a yes or no."

### C5. Note box renders narrow and truncates (P3)

- [ ] closed
- Where: `review_core/web/app.js:612` (`.dnote` input), `review_core/web/style.css` (`input[type=text] { max-width: 16em }`).
- Observed: on P7861 the saved note "Baird's answers in chat 2026-10-18 (one row typed both; ...)" shows as "Baird's answers in chat :" in a box that reads as a button label. Shot: `x-route-P7861.png`.
- Fix sketch: let `.dnote` grow (`flex: 1 1 20em; max-width: none`) and give it a visible "note" label or the placeholder "note: why (optional)" even when filled (title attribute with the full text).

### C6. Filter row layout and raw batch names (P3)

- [ ] closed
- Where: `review_core/web/index.html:34-48` (row2 and more-filters), the batch (`#f-dir`) option labels.
- Observed: the second visible row holds only "more filters" and "reset". The batch dropdown lists 80-plus raw staging directory names.
- Fix sketch: move "more filters" and "reset" to the end of row 1 (they already fit at 1440). Label batch options with a short form (strip the `batches/<country>/staging/` prefix, which `download` already does, and group by country with `<optgroup>`).

### C7. Queue rows rely on color (P3)

- [ ] closed
- Where: `review_core/web/style.css` `.pipes .dots`, `.dot.high/.medium/.low` (9 px, border only), `.pipes .n.todo` (amber bold for major, green for minor).
- Observed: tier is a 6 to 9 px color-only dot; "1 major to decide" and "1 minor to decide" differ by hue. The default sort puts a Russia owners-tab card ahead of the US route cards when the user came for routes. Shot: `desk-01-initial.png`.
- Fix sketch: add a text tier count to the row ("2 high · 1 low") or a `title`, and keep the color. Consider sorting cards with undecided major lines first within the active filter.

### C8. Raw strings in rival and ref rows (P3)

- [ ] closed
- Where: `trackers/pipelines/web/ext.js:357` (concern candidate row), the ref row rendering (`"sakhalinenergy.ru/en/Co/overview/, Owner [ref]=https://en.wikip…"`), the `.concern-inline` block.
- Observed: the ref row prints the raw cell text; the concern block on P1783 runs the full card height so the decision buttons sit below the fold. Shots: `desk-18-contested.png`, `x-candidate-taken.png`.
- Fix sketch: split the raw ref cell on ", " and "=" into a list of links (the kept/dropped list style already exists at `style.css` `table.pair li.kept`). Clamp the inline concern to four lines with the existing `.clamp` plus a "more" button.

### C9. Narrow layout (P3)

- [ ] closed
- Where: `review_core/web/style.css` `@media (max-width: 760px)` (queue becomes `30vh 1fr`), `.top` header.
- Observed at 700 px: header wraps to three lines, the queue is a 30vh strip over the card, bulk buttons and tabs wrap to two rows. Usable but cramped. Shots: `narrow-01-initial.png`, `narrow-02-card.png`, `narrow-03-route.png`.
- Fix sketch: collapse the header right side into a single "menu" button under 760 px, and make the queue a slide-in panel with a "queue (32)" button instead of a strip.

## D. How the UI drives the log

Every click writes one full record to `review-log:<built>:<dirs>` in localStorage: `{key, dir, pid, sheet_row, ref_col, kind, decision, suggested_value, note, reviewer, ts, undecided, basis, id, batch, snapshot, origin: "artifact"}`. That provenance is good and should stay. The points below are about what the records mean.

### D1. Undo is a hold with undecided true (P2)

- [ ] closed
- Where: `review_core/web/app.js:978-984` (`undoCurrent` saves `{key, undo: true}`), `review_core/web/static_store.js:285` and `:309` (`undo = !!(r.undo || r.undecided)`), the record writer that turns it into `decision: "hold", undecided: true`.
- Observed: after accept then undo, the log holds two records: the accept, then `{decision: "hold", undecided: true}` under a new batch id. The dstat goes blank. Shots: `desk-10-route-accepted.png`, then the undo record in `log.txt`. Downstream readers must take the latest record per key, and anyone reading the raw file sees a "hold" the reviewer never chose.
- Fix sketch: write `decision: "undo"` with `retracts: <id of the undone record>` and keep `undecided: true` for readers that key on it. Update `import_log.py` and `ledger.py` in pipelines-researcher to accept both forms, with a test in `tests/test_review_ledger.py`.

### D2. Note edits re-save a full record (P3)

- [ ] closed
- Where: `review_core/web/app.js:967` (250 ms debounce, then `save(l, rec, false)`).
- Observed: a slow typist produces several records per note, each with a new id and ts and the same decision.
- Fix sketch: raise the debounce to 1 s and also save on blur, or mark note-only re-saves with `note_only: true` so the ledger can collapse them.

### D3. Silent side effects of accept and candidate (P3)

- [ ] closed
- Where: `trackers/pipelines/web/ext.js:60-86` (an accept dismisses the concerns it resolves with note "resolved by accepted ... fill"; a taken candidate confirms its concern with note "candidate accepted on ..."), `ext.js:343` (the one inline warning that exists).
- Observed: the items tab later shows calls the reviewer did not consciously make ("dismissed by BL 08:46" on a concern they never opened). Shot: `x-item-called.png`. The inline warning at `ext.js:343` covers only the agrees-on case.
- Fix sketch: show the same one-line warning on every line whose accept will dismiss or confirm a concern, naming the concern, and put the count in the dstat ("accepted by BL 08:37 · 1 concern dismissed").

### D4. Bulk accept is scoped to the filtered view (P3)

- [ ] closed
- Where: `review_core/web/app.js:734` (tooltip says "that the filters show"), `app.js:1238` (`S.stay` for every bulk line).
- Fix sketch: put the count in the button label ("accept all high-conf changes (3 in view)") so the scope is visible without hovering.

### D5. Dismiss with an empty note (P3)

- [ ] closed
- Where: `review_core/web/app.js:63-66` (`OTHER_CALLS`, `CALL_HELP`), the item call select handler.
- Observed: selecting "dismissed" with the note empty saves at once.
- Fix sketch: require a note for `dismissed` and `needs_research` (focus the note box and show "say why" in the dstat until it has text), since those are the calls a later reader cannot reconstruct.

## Things that are fine

- All six palettes (default, solarized, nord, gruvbox, dracula, sepia) set sensible bg, panel, accent and ink tokens in both modes; dark mode renders cleanly; map tiles stay light in dark mode, which is acceptable.
- Satellite basemap works (Esri imagery). Basemap choice and map view persist per route in localStorage.
- Keyboard help, progress and how-to dialogs open and close correctly; `aria-pressed`, `role="status"` and `aria-live` are in place.
- Country dropdown search, deselect all and per-country counts work.

## Verifying a fix

1. In pipelines-researcher: `python3 review_app/build_static.py --no-pull --out <scratch>/gas-batch.html`, then open it in a browser (after A5 lands, straight from disk; before that, prefix a doctype and charset meta into a copy).
2. Rerun the Playwright scripts from the scratchpad against the new build, or drive the page by hand: filter kind = concern (A2), hover a chip then click a tab and click again beneath it (A4), press `c` on P1783 Owner and read the log in localStorage (A1), click "download decisions" (A3), open P7861 and P8092 (B1 to B6).
3. Rebuild and republish: `python3 review_app/build_all.py --only gas-batch`, publish `work/review_static/gas-batch.html` to `https://claude.ai/artifact/31WzSbN54wUGHAaPirimcz` from the work profile, then `python3 review_app/build_all.py --mark-published gas-batch`. `scripts/check_consumers.py` in this repo must report `gas-batch fresh`.
