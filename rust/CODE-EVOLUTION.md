# Experimental Python source proposals

`0sec-native evolve-python` connects one budgeted model proposal to the existing
paired offline plugin evaluator. It is a step toward an evolving harness, not a
complete autonomous coding loop or permission to promote generated code.

```
0sec-native --state /private/state.sqlite --providers /private/providers.json \
  evolve-python run --session EXISTING_SESSION --command-id UNIQUE_COMMAND \
  --source-registry /private/production.sqlite --plan /private/plan.json \
  --grants /private/grants.json --output-dir /private/new-proposal
0sec-native evolve-python status --directory /private/new-proposal
```

The source registry is opened read-only. The output directory must be new and
its parent must exist. It retains a private source registry, the immutable
proposal intent/request, the original inference operation and exposure receipt,
and the existing evaluator's ledger, attempts and recomputed report. Status is
read-only and requires no provider credentials. An exact original-directory
retry inspects retained evidence; it never replays inference or evaluation.
Interrupted work remains inspectable, including incomplete attempts. Changed
plans, grants, sessions or command IDs are refused. A fresh output directory has
a distinct immutable controller identity and cannot reuse the original command.
Moving/copying the ledger to another directory fails its captured-root check.

The plan is the JSON serialization of `PythonEvolutionPlan` in
`crates/zero-evaluation/src/code_proposal/types.rs`. It combines the existing
`zero-evaluation` plan (baseline, evaluator/engine/policy artifact digests,
plugin/tool, launch limits, cases, repeats, attempt budget, scoring) with
`schema_version: 1`, an objective, provider/model, a positive monetary reservation,
`max_output_tokens` (1–8192), and an absolute Unix `expires_at_ms`. There is no
candidate field: the host derives its digest from the proposed bytes. Cases have
`id`, `lane` (`development`, `held_out`, `negative_control`), `input` and `expected`.
Use an existing locally available immutable Docker image with Python; this flow
neither installs a toolchain nor pulls an image. The interpreter is fixed to
`["python3", "-I"]`. Host grants and frozen manifests must agree exactly.

The initial scope is one Compute-only plugin, one UTF-8 source artifact at most
32 KiB, no dependencies, and the existing fixed tools/schema/entrypoint contract.
The model receives the baseline source, public contract, objective and Development
examples. Private holdout/control inputs and oracles are excluded. It must emit
exactly one `submit_python_candidate` call with either
`{"action":"propose","source_utf8":"...","rationale":"..."}` or
`{"action":"stop","reason":"..."}`. Extra fields, multiple submissions, missing
final usage, uncertain inference, or changed contracts cannot dispatch code.
Source is stored as bytes and is never compiled or executed by the controller.
The evaluator executes through the existing bounded offline Docker plugin runner.

The existing Engine Infer path owns provider authorization, session reservations,
final accounting and cancellation. A host-only Store claim checks the exact
retained admission, successful operation and settlement witnesses, final usable
usage/charge, and the original session budget before exposing protected cases.
Managed campaign/scan/review/strategy sessions cannot borrow this authority.
Ordinary sessions have no persistent closed-session state: an open current Engine
is required for fresh claims, and cancelled/unknown proposal operations fail.
Both the CLI and public evaluation API enforce the absolute deadline and join
owned execution cleanup. Cancellation/expiry can retain an Inconclusive report;
only a completed independently Eligible report is CLI success (a genuine model
Stop is also successful without exposure).

The protected suite identity includes private inputs, expected outputs, lanes,
repeats and scoring semantics; labels, ordering, Development examples and
candidate/baseline choices cannot refresh it. A transactional Store receipt and
content-addressed witnesses bind this identity to the original inference,
controller intent, source and candidate. A changed candidate/command cannot
reuse that suite in the same Store. Exact witness verification supports inert
status inspection, not a fresh execution capability. Cross-Store corpus reuse,
new suite approval and corpus secrecy remain the host's responsibility.

Fixture eligibility is not general quality, a safety proof, or production
activation authority. There is no promotion command in this workflow. The
production registry is unchanged even after Eligible results. A separate
independent host promotion gate is still required for any future activation.

Qualification uses loopback Responses fixtures (no paid provider), actual Python
fixture source execution, budget/usage/cancellation/retry/tampering regressions,
and an explicitly opted-in local Docker test. The default fake Docker tests
exercise controller boundaries and do not claim container isolation. Run:

```
cargo +1.85 test --locked --offline -p zero-store --test python_holdout
cargo +1.85 test --locked --offline -p zero-evaluation --test code_proposal
cargo +1.85 test --locked --offline -p zero-cli --test code_evolution
ZERO_PYTHON_EVOLUTION_DOCKER_IMAGE=sha256:EXISTING_LOCAL_IMAGE \
  cargo +1.85 test --locked --offline -p zero-evaluation --test code_proposal \
  real_local_docker_python_code_qualification -- --ignored --exact
```

The real Docker fixture compares a zero-valued baseline with a source-only
implementation returning the input value, across twelve paired attempts on
Development, HeldOut and NegativeControl cases. The default fixture suite also
rejects a Development-only cheating candidate. This qualifies the measured workflow on the
local Linux Docker host, not arbitrary generated programs or other platforms.

Local qualification on 2026-09-19 passed the 19 default Store/evaluation/CLI
regressions and both explicitly selected real Docker tests using installed image
`sha256:0461844e338a379bd3379976a753e5467dce5361a471fbecff593fa477e3d7f6`.
The Docker runs covered the public evaluation API and physical CLI with a loopback
model response, twelve paired attempts each. Rust 1.85 with `--locked` was used;
no image pull, paid model call or production registry activation occurred.

For bounded model-directed Development experiments before final selection, see
[Python search](PYTHON-SEARCH.md). The one-shot command above is unchanged.
