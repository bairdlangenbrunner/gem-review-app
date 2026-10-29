# Questions a reviewer can read at a glance

Asked by Baird on 2026-10-27, after the Iowa page showed two long "does this plant or unit exist as GEM records it?" cards for Interstate Power and Light 2024 IRP power station 1 that said the same thing in different words and buried the answer. Two problems, two fixes: the pipeline writes one question per thing, and every question card leads with the question, what was found, and what to do, with the long note folded away.

## What is wrong today

**The same question twice.** The IRP task for a US state lands in two places: on the plant's own brief (the plant subagent answers it, and writes its question on the unit) and in `briefs/_irp.md` for the scope-wide agent (which answers it again, and writes its question on the plant). `assemble_state.py` passes both through, so a one-unit placeholder plant gets a plant-level and a unit-level card for one concern. The Iowa plant card came from `shards/_state.json`, the unit card from `shards/L100001081945.json`.

**The card hides the answer.** A question card shows the generic heading for its concern type, then the whole researcher note (up to 700 characters), then a bold "recommendation:" line, then the links. The note is written as a narrative, so the reader meets the evidence before the question, and the one sentence that matters (keep it, drop it, merge it, ask someone) is at the bottom of the longest block. The two Iowa notes also close differently ("could be cancelled" against "keep separate"), which reads as disagreement when it is one finding written twice.

## The card after the change

Every question card has the same four parts, in this order. Using the Iowa card as the example:

> **Is the 430 MW combined cycle unit from the 2024 study still planned?** · unit 1 IRP (G100001092270)
>
> **found:** The study, dated February 13, 2025, adds a 430 MW combined cycle unit in 2029. No later filing names it. Alliant's quarterly report for June 30, 2026 lists only simple-cycle projects, Morgan Valley at 720 MW and Riverhawk at about 1,200 MW. Morgan Valley's April 2026 application says the site could later be converted to combined cycle, and nothing more.
>
> **suggest:** Leave the unit as announced. Check again when Alliant files a combined cycle plan.
>
> links (with their check marks)
>
> ▸ notes — the full researcher note, both agents' text when two were merged, then the record line
>
> ▸ all fields

Rules for the four parts:

- **question**: one sentence, ends with a question mark, under about 120 characters, specific to this record ("Is the 430 MW combined cycle unit still planned?", not "does this plant or unit exist?"). The generic concern-type heading becomes the chip's tooltip.
- **found**: one to three sentences saying what the sources say. Dates and capacities in full. Each source named by what it is. No reasoning about process, no "I could not reach the docket" (that goes in the notes).
- **suggest**: one or two sentences, an instruction the reviewer can act on: leave as is, change X to Y, merge with Z, ask the PM, cancel. Never "the reviewer should decide".
- **notes**: everything else the agent wants to say, folded under a `notes` dropdown like a line's "notes & record" dropdown. Links the note names stay clickable there.

## Pipeline changes (gogpt-researcher)

1. **Schema.** `docs/reference/staged_json_schema.md`, the `qa` paragraph: a question carries `question` (one sentence), `finding` (one to three sentences), `recommendation` (one or two sentences, an instruction) and `researcher_notes` (the rest). Add the four-part shape and the Iowa example to `docs/reference/notes_style.md` under a "Questions" heading.
2. **Prompt.** `.claude/workflows/state-sweep.js`: the `qa` line in the output contract (around line 558) gains `"question": "...", "finding": "..."`, and the rule block near line 582 says what each of the four parts is, with the length limits above. The "How to write notes" block (line 492) names `question`, `finding` and `recommendation` alongside `note`.
3. **Assembler.** `scripts/assemble_state.py` `passthrough` already copies unknown keys, so `question` and `finding` arrive on the staged record. Add one merge in the `_state.json` pass (around line 1131): a `qa` item there with `gem_plant_id` and no `gem_unit_id` whose `concern_type` matches a shard `qa` record on the same plant (same unit, or the plant has one unit) is folded into the shard record instead of appended: refs and verifications are unioned, the state agent's `finding` and `recommendation` go into `researcher_notes` as a second paragraph that starts "A second check of the plan found:", and the shard record gets `merged_from` with the dropped record id. The unit-level record wins because it sits under the unit on the card. Print the merge in the assembler's summary line.
4. **Brief.** The scope-wide IRP brief text comes from `irp_sheet.py` (the `brief` key of `work/irp_us-<state>.json`, written to `briefs/_irp.md`). Add to its instructions: "A plant whose own brief carries an IRP task gets its questions from that brief. Do not write a question about it here. Put what the plan says about it in `meta.irp_summary`." The merge in step 3 stays as the safety net.
5. **Gate.** `scripts/state_gate.py` `gate_notes`: run the jargon and dash checks over `question`, `finding`, `recommendation` and `monitor_reason` as well as `researcher_notes` and `action`. New checks on `qa` records: `question` present and ends with "?"; `finding` present; `recommendation` present, at most two sentences; `recommendation` does not contain "reviewer should decide", "should be checked" or the other hedges already in `CHASE_RE`. Missing `question` or `finding` is advisory for batches assembled before this change and a failure for new ones (key off `meta.generated` in the shard, or a `--strict-questions` flag).
6. **Review data.** `review_app/review_data.py` `item()`: copy `question`, `finding` and `merged_from` onto the concern item.
7. **Workbook.** `scripts/build_review_package.py`: the `qa_review` sheet gains `question` and `finding` columns next to `recommendation`; the evidence markdown prints the four parts in order.
8. **Backfill the live Iowa batch.** The staging folder is curated, so never reassemble it. Write `scripts/add_question_fields.py --staging batches/us-ia/staging` on the `add_checklist_fields.py` pattern: for each `qa` record without `question` and `finding`, ask a cheap model (Haiku) to write the two from `researcher_notes` and `recommendation`, and to shorten `recommendation` to an instruction; print a before-and-after table for Baird to read; write in place, touching no record id, note, ref or value, and keeping the original recommendation in `recommendation_raw`. Run the step 3 merge as a function over the same folder so the Iowa duplicate becomes one record. Then rebuild and republish the Iowa page.

## Review app changes (gem-review-app)

1. **Core item body.** `review_core/web/app.js` `itemBody`: the open body shows `finding` (labeled "found") and `recommendation` (labeled "suggest"), then the links. The researcher notes leave the open body and go under `<details data-more><summary>notes</summary>` after the links, rendered with `linkText` so URLs in the note are clickable, followed by the record line the lines already show (batch, record id). When a record has no `finding` (older datasets, other trackers), the open body shows the first two sentences of the notes instead, cut at a sentence end rather than at 700 characters, and the full note still sits in the dropdown. `reason` and `lookup_result` keep their place for watch and entity items.
2. **Headline.** `trackers/gogpt/web/ext.js` `itemHead`: a concern returns `it.question` when present, else `concernHead(it)` as now. `kindTip` for a concern becomes the generic heading, so hovering the "question about existing data" chip still says which kind of question it is. `hideFields` gains `question`, `finding`, `merged_from`, `recommendation_raw`.
3. **Merged marker.** A concern with `merged_from` shows a small chip "two checks, one question" with the dropped record id in its tooltip, so a reviewer who remembers the other card knows where it went.
4. **Style.** `review_core/web/style.css`: `.item .body b` labels in the same small uppercase style as `.dtxt .k`; the notes dropdown reuses the `.line details` rules (move them to a shared selector).
5. **Pipelines.** Check `trackers/pipelines/web/ext.js` for an `itemBody` override. If it has one it keeps it; if not, pipelines concerns get the sentence cut and the notes dropdown for free. Mention it in `docs/plan.md`.
6. **Tests.** `tests/js/gogpt_cards.test.js`: a concern with `question` and `finding` renders the question as the headline, "found" and "suggest" in the open body, and the note only inside `details`; a concern without them renders the generic heading and a two-sentence cut; a `merged_from` concern shows the chip. `tests/js/parity.test.js` if it snapshots item HTML. Run `node --test tests/js` here and `pytest tests/test_review_app.py tests/test_state_gate.py` in gogpt-researcher.

## Order of work

1. Review app steps 1 to 6. This alone makes every existing card shorter (sentence cut plus the notes dropdown) and ships with no pipeline change.
2. Pipeline steps 1, 2, 5 and 6, so the next batch writes the four parts.
3. Pipeline steps 3 and 4, the duplicate.
4. Pipeline step 8, the Iowa backfill, then republish the Iowa page.
5. Pipeline step 7, the workbook, when the next batch is built.

## What shipped (2026-10-27)

Everything above, in both repos, uncommitted at the time of writing. Review app: `itemBody` in `review_core/web/app.js` (found, suggest, links, notes dropdown, two-sentence cut for records without a finding), the `body` label hook, the gogpt headline and chip changes, the shared `details .dtxt` style, and four card tests. Pipeline: the schema and prompt text, gate `questions` in `state_gate.py` (hard from batches assembled 2026-10-28 on, or any folder stamped `meta.question_fields`), `merge_plant_question` in `assemble_state.py` with its summary line, the IRP brief sentence, the review data and workbook fields, and `scripts/add_question_fields.py` for the backfill. Iowa was backfilled with Haiku drafts checked against the gate (48 records, the existence duplicate folded, 47 left) and the New York and Maryland page republished. The pipelines tracker keeps its own `itemBody`, so its cards are unchanged.

## Follow-up (2026-10-29)

The Iowa card that started this did not answer the reviewer's own database note (the placeholder is "most likely related to the Bobcat and Cedar River projects"), because that note was written after the plant brief was built on October 16 and the brief printed the Notes field blank. gogpt-researcher now has an advisory gate `note-drift` in `state_gate.py` that lists every unit whose database note changed since the brief, so the questions on that plant get checked against the new note before the page is published. The Iowa record was redrafted by hand through `add_question_fields.py --drafts`: the question now asks whether the placeholder is Bobcat or Cedar River, the finding names the filers of the plan comments (the Environmental Law and Policy Center, the Iowa Environmental Council and Sierra Club) instead of "intervenors", and the note carries a paragraph that answers the database note. The notes style guide gained both rules.

## What this does not change

The call vocabulary on a question (confirmed, dismissed, needs research), the ask-the-PM box, the checklist grouping, and the staged record ids. A concern that answers a validation error is still a line, not an item.
