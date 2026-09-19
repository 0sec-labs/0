# Bounded model-directed Python experiments

`0sec-native evolve-python search run` lets the model choose a Python hypothesis,
measure it on public Development cases, use the measured feedback for another
experiment, select one measured source, or stop. The existing one-shot
`evolve-python run` command retains its contract.

```
0sec-native --state /private/state.sqlite --providers /private/providers.json \
  evolve-python search run --session EXISTING_SESSION --command-id UNIQUE_ID \
  --source-registry /private/production.sqlite --plan /private/search.json \
  --grants /private/grants.json --output-dir /private/new-search
0sec-native evolve-python search status --directory /private/new-search
```

The search plan contains `schema_version: 1`, `proposal` (the complete existing
`PythonEvolutionPlan`), `max_rounds` (2–16), `max_proposal_spend` (the same monetary
units as the original session), and `max_development_attempts` (1–1536). Each
candidate's public schedule uses the frozen Development cases and repeat count.
The private final paired schedule retains the original plan's separate attempt
budget, all three lanes, immutable oracles and independent scoring rules.

A new private ledger captures an absolute root, random controller identity,
original session, frozen contract, limits and oracle identities. Every paid round
gets a unique command ID under that original session; its exact prompt and
admission are retained before provider contact. A current Engine owner verifies
retained successful inference, final usage, original accounting/admission
witnesses and session authority before any Development guest can run. Managed
campaign, scan, review and strategy sessions cannot borrow this capability.

The model chooses one tool per round:

- `experiment_python_candidate` receives only `source_utf8` and `rationale`.
  The host materializes a source-only generation under the frozen Compute-only
  plugin contract and executes fresh offline Python guests on Development cases.
- `submit_python_candidate` with `action: propose` selects exact source bytes
  previously measured by a completed experiment with known joined cleanup.
  It immediately ends model interaction and enters the existing one-use private
  holdout claim and independent paired evaluator.
- `submit_python_candidate` with `action: stop` ends without private exposure.

Public feedback contains source identities, measured source bytes, repeat-level
pass/error summaries and joined attempt counts. It never includes HeldOut or
NegativeControl inputs, oracles, execution outcomes or independent qualification.
Search cannot make another model call after private selection, even when the
selected candidate fails. A Development pass is never eligibility. There is no
production activation command or mutation of the source registry.

Before each provider call the next reservation must fit the remaining cumulative
search budget; Engine reserves it against the original session. Actual settled
charges replace estimates. An overrun ends work before another experiment or
private evaluation, including an overrun in the final selection response. Unknown
usage or cleanup ends search and retains the original account hold or execution
lease. The status view also shows the current original-session budget. Provider
charges exceeding an admitted reservation cannot be retroactively prevented;
the configured rates are host accounting rather than an external invoice.

Attempt slots are persisted before Development dispatch. Cancellation and the
absolute deadline cancel and join owned execution. Existing search directories
are inspected only: no provider or guest replay, even after a crash. Changing the
plan, grants, original command, or copying/moving the controller is rejected.
Status recomputes public feedback from retained attempts, verifies source-only
identity and original inference, and rechecks final Store exposure and independent
evaluation when present. Cross-Store corpus governance remains host-owned.

Search is bounded to one plugin source, no dependency changes, Python3 `-I`, an
explicit locally installed immutable Docker image, and a 256 KiB model prompt.
No images are pulled and no package installation runs. The model chooses its
hypothesis, experiments, final selection and voluntary stopping; host limits,
authorization, cancellation and independent verification remain outside it.

Local qualification on 2026-09-19 passed 30 combined one-shot/search/Store tests
and the explicitly opted-in physical CLI search with installed image
`sha256:0461844e338a379bd3379976a753e5467dce5361a471fbecff593fa477e3d7f6`.
That actual Docker run made three loopback model calls, four Development guest
attempts, and twelve independent final paired attempts, then retried without
provider credentials. The original production registry was unchanged. Compiler
checks used Rust 1.85 with `--locked`, including workspace/all-target checks;
formatting used installed rustfmt 1.9. The tests qualify those fixture workflows,
not arbitrary generated programs, other backends or general autonomous quality.

```
cargo +1.85 test --locked -p zero-evaluation --test python_search --test code_proposal
cargo +1.85 test --locked -p zero-store --test python_holdout
cargo +1.85 test --locked -p zero-cli --test python_search --test code_evolution
ZERO_PYTHON_EVOLUTION_DOCKER_IMAGE=sha256:EXISTING_LOCAL_IMAGE \
  cargo +1.85 test --locked -p zero-cli --test python_search \
  real_docker_model_directed_python_search -- --ignored --exact
```

Inspection regressions additionally reject changes to model instructions, token
limits, tool schemas, baseline source, public examples and plugin contract even
when local request hashes are updated. Missing-operation rounds may only be the
last unfinished/failed round, and successful rounds require the original Store
admission, settlement and accounting witnesses. Inspection reconstructs the whole
request from frozen policy and verified prior Development feedback; its Store
check returns a charge, never an execution capability.
