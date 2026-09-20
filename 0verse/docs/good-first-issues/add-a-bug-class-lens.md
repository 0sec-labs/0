# Good first issue: add a bug-class lens

**Labels:** `good first issue`, `bug-class`, `M4`
**Difficulty:** ⭐⭐ (medium) · **Area:** `src/zeroverse/bugclasses.py`

## What

Add a new static **detection lens** — a high-recall hypothesis source over the
decompiled C. Candidate gaps include **path traversal**, **uninitialized-memory
use**, and **TOCTOU**. Inspect the existing lens first: signed/unsigned size
confusion is already covered by `intoverflow_lens`, off-by-one shapes by
`logic_lens`, and loop-index writes by `loop_oob_lens`. Extend those where
appropriate instead of registering a duplicate detector.

## Why

Lenses are how 0verse casts a wide net before the funnel + oracle filter it down.
Each new lens widens the bug surface 0verse can reason about, at near-zero cost to
the rest of the pipeline.

## How

1. Write `def <name>_lens(decompiled_c: dict[str, str]) -> list[Finding]` that scans
   the decompiled function bodies and yields `Finding`s tagged
   `origin="bugclass:<id>"`. Mirror an existing lens (`fmtstring_lens`,
   `intoverflow_lens`).
2. Register it in the `_LENSES` tuple.
3. Decide confirmation:
   - if a generic oracle exists, route it via `bugclasses.confirm` and add the origin
     to `CONFIRMABLE_ORIGINS`;
   - otherwise leave it **hypothesis-only** and document the gap in
     `NEGATIVE-RESULTS.md`.
4. Add `benchmarks/<class>.c` with a known bug + a test in `tests/test_bugclasses.py`
   asserting the lens surfaces it.

## Definition of done

- [ ] Lens registered; `prime_bugclasses` emits its hypotheses.
- [ ] Test proves recall on a benchmark; if confirmable, a reproducing PoV.
- [ ] **PoV-is-truth respected** — no `confirmed` without a PoV.
- [ ] `ruff` + `mypy --strict` + `pytest` green.

See [CONTRIBUTING.md](../../CONTRIBUTING.md#add-a-bug-class-lens-srczeroversebugclassespy).
