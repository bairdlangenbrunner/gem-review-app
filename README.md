# gem-review-app

The shared review app behind the GEM researcher repos. A reviewer opens a page of staged edits (a plant or a pipeline per card), accepts, holds, rejects or suggests each one, calls the items that are not cell edits, and the decisions land in that repo's decision log. The page, the store adapters, the decision log and the loopback server live here once; each tracker adds its own config and page extension under `trackers/<name>/`; each researcher repo keeps only its dataset builder, its Google ledger and its workbook consumers, and imports the rest from this sibling checkout (`../gem-review-app`, or `$GEM_REVIEW_APP`).

Start with `docs/plan.md`: what lives where, the dataset contract, the tracker config, the page hook points, the store interface and the single-file page format. `docs/refresh.md` is the plan for keeping every published page current (page registry, staleness check, hooks); built and in use, the hooks carry it.

Consumers today: `gogpt-researcher/review_app` (phase one) and `pipelines-researcher/review_app` (phase two, landed 2026-10-09). LNG carriers follows later.

Tests: `python -m pytest tests -q` here runs the core on a synthetic tracker; each researcher repo's own review tests exercise its port.
