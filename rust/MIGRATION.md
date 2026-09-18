# Native rewrite parity ledger

Status: 2026-09-18, `the-great-rust-rewrite`. This is the remaining-work checklist
for the full native CLI and engine, not a declaration that the rewrite is done.
The current executable is `0sec-native`; the production `0sec`/`0` commands and
cloud distribution remain TypeScript. No native command silently falls back to
the TypeScript CLI.

See the [architecture](../docs/design/2026-09-18-native-harness-architecture.md)
and [execution contract](EXECUTION-DESIGN.md). This ledger distinguishes present source from qualification. Record newly executed checks and environments
when advancing an item. A passing fixture test is not a live-provider, real-VM,
cloud-deployment or detection-quality result.

## Status and completion rules

- **Foundation:** working native primitive with focused tests; not command parity.
- **Absent:** no native implementation of the specified product behavior.
- **Partial:** identify the exact working subset and remaining behavior.
- **Qualified:** record native acceptance tests, supported environments and
  reference compatibility before marking any legacy workflow replaceable.

Every implementation change must record the legacy entry point and regression
tests, new owner, wire/storage compatibility, supported execution environments,
remaining limitations and the condition for removing its temporary adapter.
Importing or registering a command does not prove that its advertised research
capability is complete. Preserve explicit unsupported outcomes instead of
upgrading scaffolds or model assessments into successful verification.

## Present native foundation

| Surface | Native owner and current behavior | Remaining acceptance gate |
| --- | --- | --- |
| Wire schema | `crates/zero-protocol`: strict versioned requests, replies, execution/session values, JSON Schema | Stable compatibility policy, generated external clients, negotiated additions and schema migration tests |
| Native state | `crates/zero-store`: SQLite sessions, command admission, owner-bound operation settlement, ordered events, budget reservation/settlement, transactional epoch recovery and schema v1/v2/v3/v4/v5→v6 migration, optional activation epoch pins and immutable operation artifacts | Full UI message projection, semantic compaction and retained-history retrieval; further schema upgrades; explicit legacy import; durable multi-process campaign accounting |
| Application engine | `crates/zero-engine`: session queries, idempotent execution, cancellation, engine ownership lock, uncertain-operation recovery, finding reconciliation, durable Responses/Chat/Anthropic inference, bounded offline Docker/smolvm snapshot agent with explicit completed-turn continuation durable FIFO inputs and explicit byte-bounded context projection from immutable journal records | Remaining providers, full tools/permissions and agent workflows, mid-turn steering input, interrupted-turn checkpoints and generation lifecycle |
| Batch execution | `crates/zero-executor`: validated snapshot pin/copy, local image identity, nonroot Linux offline Docker lifecycle, bounded raw output, cancellation and explicit cleanup outcome | All other execution profiles below; real Docker qualification remains separate from injected CLI fixtures |
| MicroVM execution | `crates/zero-smolvm` and `zero-sandbox`: explicit pinned archive, qualified runtime version, nonroot offline batch lifecycle, verified snapshot staging and native engine/agent selection; real guest and engine/agent smoke passed | Broader isolation/SIGKILL qualification, live-provider matrix and interactive execution |
| Source review | `crates/zero-source` and engine `source.rs`: bounded selected source bundle, grounded structured hypotheses, retained request/bundle/completion/submission, same-session provenance and exact retry; `source-review` CLI | Source exploration, automatic investigation and specialist verification; hypotheses remain unverified, including successful model submissions |
| Frozen reproduction | `crates/zero-verification` and engine `reproduction.rs`: host-owned immutable exact-output plans, repeated attack/control matrix, journaled sandbox children and retained requests/evidence; `source-reproduce` CLI | Broader domain oracles, automated plan proposals and independent detection-quality evaluation; `ObservedForPlan` never means vulnerability reportable |
| Plan-qualified repair | `crates/zero-repair` plus engine `repair.rs`: host-authorized private single-file candidate, protected paths, baseline evidence revalidation, safe-expectation matrix and fresh reconstruction; `source-repair` CLI | Workspace installation, broader repair generation/verification, specialist safety oracles and full legacy `fix` parity; validation is limited to the frozen plan |
| Artifact inspection/export | Read-only exact-schema `zero-store` opener and CLI `artifact list/export`: session ownership, bounded hash-checked bytes, private no-clobber export while the engine remains active | Legacy evidence-pack/report integration, disclosure authority and broader storage/platform qualification |
| Provider transport | `crates/zero-provider`: bounded Responses/Chat/Anthropic SSE, explicit routes, final/provisional usage distinction, integer rate accounting, exact hosted catalog quotes and conservative uncertainty | Remaining wire features, provider OAuth/refresh, live-provider qualification |
| Plugin admission | `crates/zero-plugin`: strict manifests, hashed artifacts, exact dependency graph, host grants and bounded inert RPC framing | Bidirectional broker and persistent workers; admission alone never executes plugin code |
| Plugin runner | `crates/zero-plugin-runner`: pinned offline single-call RPC through Docker/smolvm, exact response correlation, retained leases on uncertainty; actual Node fixture passed on local Docker | Bidirectional broker, persistent workers, broader backend/platform qualification; engine direct calls now journal preparation and settlement |
| Generation graph | `crates/zero-harness`: verified complete plugin/artifact/policy graph, activation epoch pins, durable invocation leases and current-state rollback | Measured evaluator promotion and native process replacement; persisted session epochs and direct engine calls are implemented |
| Generation registry | `crates/zero-evolution`: immutable artifacts/receipts, eligibility, instance-bound preparation, activation CAS, leases and current-state rollback | Runtime graph disposal, measured evidence import/promotion, campaign qualification and native process handoff |
| Fixture evaluation | `crates/zero-evaluation`: isolated paired baseline/candidate execution, frozen exact JSON oracles, durable attempt budgets, observed outcomes and deterministic receipts; real Docker fixture passed | Portable evidence import, independent corpus governance, production eligibility/canary and autonomous candidate writing; fixture eligibility is not a detection-quality claim |
| Report rendering | `crates/zero-report`: bounded legacy JSON preservation, SARIF, Markdown and HTML rendering with actual TypeScript formatter golden fixtures | Full workflow integration and report schema qualification; rendering does not verify findings |
| Hosted metadata | `crates/zero-cloud-client`: explicit authenticated health/catalog/account/usage GETs, bounded browser-session login polling, explicit catalog inference routing, typed gateway errors and credit normalization; CLI resolves environment or private legacy `cloud.env` credentials | Live service qualification, provider OAuth/refresh, upload/accounting and managed-worker qualification |
| Cloud wire adapter | `crates/zero-cloud-compat`: result/event framing, typed outcomes, cost provenance and atomic report writing | Scanner integration, ordered scan-total accounting, uploads and managed deployment qualification |
| Finding reduction | `crates/zero-evidence`: source IDs/provenance retained through complete reconciliation, explicit disposition accounting | Discovery, independent vulnerability oracles, storage/export and disclosure eligibility; reconciliation is not truth validation |
| CLI | `crates/zero-cli`: `schema`, `snapshot pin`, `session create/create-pinned/list/show/events/budget/reconcile-usage`, `exec`, `sandbox`, `infer`, `agent`, `plugin-call`, `evaluate run/status`, `source-review`, `source-reproduce`, `source-repair`, `artifact list/export`, durable `queue enqueue/list/run/cancel`, line `console`, full-screen `tui`, `hosted login/health/models/account/usage`, `doctor`, `app-server`, help/version; separate `.0sec/native/state.db` | All legacy commands below; UX/exit/schema compatibility; installer and platform release qualification |
| Stdio lifecycle | Initialize/version gate, correlated replies, bounded NDJSON framing, concurrent execute/cancel, durable-admission notification before cancellation, EOF/SIGINT/SIGTERM cleanup | Durable event streaming/reconnect contract, authenticated remote transports if required |

Current acceptance sources include crate unit and integration tests for CLI
subprocesses, storage/epoch recovery, provider HTTP fixtures, engine accounting,
execution lifecycle, protocol/evidence values and cloud wire/report fixtures.
Real Docker isolation/cancellation and smolvm guest/cleanup smoke checks have
also passed on this Linux host using prepared local images. They do not qualify
other environments or full scanner behavior. Inference rates are explicitly
supplied integer microcurrency rates; they are not organization billing or a
provider-enforced monetary ceiling.

## Recorded workflow qualification

The following are bounded acceptance results on this nonroot Linux host, using
prepared local artifacts. No image pull, paid model call or live target was
required. Loopback model responses exercise transport and ownership; they do not
measure model judgment.

| Path | Acceptance source and observed scope | What remains unqualified |
| --- | --- | --- |
| Offline Docker lifecycle | `crates/zero-executor/tests/docker_smoke.rs`: actual nonroot guest, network disabled, read-only root filesystem, staged build, unchanged source, cancellation and confirmed cleanup | Other host/platform profiles, arbitrary workload escape resistance and controller SIGKILL recovery |
| Paired fixture evaluator | `crates/zero-evaluation/tests/evaluation.rs`: actual local Node image, baseline/candidate positive, held-out and negative cases with repeats; 12 executions and settled invocation leases | Production receipt import/promotion, independent corpus governance and detector-quality generalization |
| Source review → reproduction → export on Docker | `crates/zero-cli/tests/reproduction.rs::real_local_docker_source_review_to_observed_plan_and_artifact`: loopback source submission, four attack/control observations, retained artifact export and exact retry | Live-provider source analysis, specialist vulnerability oracle and production report/disclosure |
| Source review → reproduction on smolvm | `crates/zero-engine/tests/reproduction_real.rs`, commit `46fbe0ca`: actual smolvm 1.14.6, prepared Node archive, four observations with confirmed cleanup, re-assessed retained evidence, unchanged source, settled budget and restart duplicate without backend dispatch | Other VM/runtime versions, source repair qualification and detection quality; this smoke ran against an isolated committed baseline before the concurrent repair integration |
| Source grounding and negative outcomes | CLI `tests/source.rs`, `tests/reproduction.rs` and engine `tests/source.rs`: malformed/citation-invalid submissions fail, empty hypotheses are not a safety verdict, stable attack mismatch is `NotObserved`, failed legitimate controls are inconclusive, cancellation awaits child cleanup | Host-authored plans remain required; exact output is evidence only for the frozen plan |
| Active-engine artifact inspection | `crates/zero-store/tests/readonly.rs` and CLI `tests/artifact.rs`: no epoch/recovery claim, no schema migration, foreign/view/old-schema rejection, corrupted bytes rejected, existing destinations preserved | Legacy database import and generic evidence-pack compatibility |
| Hosted login | `crates/zero-cloud-client/tests/login.rs` and CLI `tests/hosted_login.rs`: bounded pending/ready/expiry/error polling, cancellation/deadline, redirects rejected, environment precedence, private atomic credential publication, symlink/path failures | Real account login and deployed gateway qualification; persistence currently requires Unix permissions; URL is displayed without launching a browser |

The real smolvm reproduction test is opt-in with
`ZERO_SMOLVM_SMOKE_ARCHIVE`; Docker reproduction uses
`ZERO_REPRODUCTION_DOCKER_IMAGE`. Both require existing local artifacts and are
ignored in the ordinary suite. The recorded smolvm archive digest is
`sha256:2bda0b195b4a451d7e3c516a2c08178024f4407e60e7abfed831eb5f06444c48`.
These results establish specific execution paths, not full scanner parity.

### Repair integration qualification

Committed `7f092d0c`: engine `repair.rs`, protocol `repair.rs`, and CLI
`source-repair` connect a private candidate to a retained baseline reproduction.
The engine reconstructs and re-assesses retained baseline evidence, requires the
candidate target/preimage to be cited by the original hypothesis, and requires
attack-case safe expectations frozen in the original host plan. Both the
candidate and a freshly reconstructed private copy must meet those expectations
and preserve legitimate controls. Unknown cleanup retains recovery information.

Acceptance includes 20 engine source/reproduction/repair fixtures and five CLI
reproduction/repair fixtures on Rust 1.85, workspace production Clippy, and the
342-test workspace run at this checkpoint. The opt-in CLI test
`tests/reproduction.rs::real_local_docker_candidate_and_fresh_reconstruction`
also passed on the prepared local Node image: four baseline, four candidate and
four reconstructed-copy observations. Tests cover exact retry, changed/protected
preimages, absent/wrong safe expectations, corrupt retained baseline evidence,
preparation retention failure, cancellation and uncertain cleanup.

`ValidatedCandidateForPlan` means that these exact frozen cases passed in both
private copies. It does not install the replacement, grant disclosure or mark a
vulnerability reportable; it is not complete legacy `fix` parity or independent
proof of repair quality. The equivalent 12-observation CLI fixture also passed on real smolvm 1.14.6
with the prepared local Node archive and nonroot KVM access (50.26 s); broader
smolvm repair and platform qualification remain open.

### Explicit turn-limit continuation

A complete tool round at the configured turn limit can retain a versioned
`agent.continuation` artifact. A new explicit `continuation_of` command validates
its exact provider replay, correlated settled tool outputs and unchanged authority
before admitting new work. Historical effects are never reissued. Cancelled,
unknown, generic failed and uncheckpointed operations remain ineligible. Existing
usage holds remain reserved; only new work incurs a new reservation/charge.
See [continuation boundaries](crates/zero-engine/CONTINUATION.md). This does not
implement interrupted-turn recovery, durable queues or context compaction.

### Retained source investigation

`6304d963` adds bounded file listing, exact line reads and literal search over a
verified retained source bundle. The agent integration explicitly opts in through
`source_review_operation_id`; it validates same-session completion, exact snapshot
authority and artifact provenance before new provider work. Accepted results have
immutable child artifacts and exact citations. Seven integration fixtures cover
read/list/search, accounting, denied paths/unselected files, unoffered tools,
corrupt evidence, persistence failure, retry and continuation authority. No Docker
or live provider is needed for these tests. See
[the source tool contract](crates/zero-engine/SOURCE-TOOLS.md).

This implements a subset of legacy `read_file`, `list_files` and `search_files`
(`packages/core/src/agent/tools.ts`). An explicit `source_snapshot_tools` mode now verifies and privately copies the
whole execution snapshot (4,096 files / 64 MiB), retains its catalog before provider
work, and supports bounded reads/search with explicit excluded files and
truncation. Cleanup is awaited before success or checkpoint creation. Exact
retries do not restage; new snapshot continuations require the unchanged original.
This is distinct from retained-review mode and does not broaden it implicitly.
Source listings now expose deterministic `after_path` / `next_after_path` pages,
so the per-call 32-file limit does not hide later files in a large directory.
Manifest/scope validation and serialized-byte bounds apply to every page.
Explicit regex and case-insensitive search are available (see the search
checkpoint below); role-specific tool policy remains open. Optional structured
submission now connects adaptive snapshot investigation to retained unverified
hypotheses; the dedicated one-shot review still requires host-selected files.

## Dependency gates

Use these gate names in the command inventory. All remain open unless an exact
subset is identified above.

| Gate | Legacy source of behavior | Native acceptance requirements |
| --- | --- | --- |
| **P — Providers/auth** | `packages/core/src/runtime/{types,llm-api,process,cli-native,ollama,registry,codex-home}.ts`; `packages/core/src/cloud/{client,credentials}.ts`; CLI `codex-auth.ts` and TUI credential/device-auth modules | One normalized turn per provider; streamed text/reasoning/tool arguments, usage, errors, refresh, cancellation, retries, context limits and original provider continuation metadata. Port recorded/mocked wire fixtures before optional live checks. Auth secrets stay out of events, guest snapshots and ordinary logs. |
| **A — Agent/session** | `packages/core/src/console/turn-engine.ts`, `agent/{native-loop,tools,worker-tree}.ts`, `console/{session-objective,session-checkpoint}.ts`; `packages/cli/src/console-session.ts` | Durable prompt admission and exact retry; explicit steer/queue semantics; same-session serialization and cross-session concurrency; subagent ownership/messaging; bounded provider/tool work; persisted usage; cancel/interrupt/restart without duplicated effects; context projection separate from immutable history. |
| **T — Tools/scope** | `packages/core/src/agent/tools/`, `scope/`, `agent/{apply-patch,sanitized-env}.ts` | Typed dispatch, authorization and denied decisions independent of model output; source/network boundaries, role-specific tools, operator questions, approvals, file/link checks, patch preview/commit and rollback. Port scope/tool tests before exposing each tool. |
| **X — Execution** | `improvement/sandbox.ts`, `runtime/{interactive,smolvm}.ts`, `verify/replay-runner.ts`, `triage/kernel-vm-runner.ts`, `stages/npm-detectors/` | Separate profiles for offline snapshots, ordinary host shell, scoped network workers, PTYs, bidirectional plugins, Docker replay and VM/kernel work. Verify mounts/environment/process groups, byte/output limits, cancellation, artifact export and uncertain teardown. No host fallback from failed isolation. |
| **D — Data/evidence** | `packages/db/src/`; core `verification-spec/`, `verify/`, `events/`, CLI finding focus/handoff and conversation/session stores | Immutable artifacts and provenance; hypothesis versus reproduced versus reportable distinctions; original source-finding accounting; finite cursor pagination and replay gaps; old DB backup/import/migration; retain privacy/authority fields and exact receipts. |
| **U — Frontends** | `packages/cli/src/tui/`, `presentation/`, `desktop/`; `packages/shared/src/{presentation,desktop-console,live-harness}.ts`; dashboard/desktop packages | TUI is an application client, not an engine owner. Test streaming/reasoning/tool cards, input/paste, resize/Unicode, keyboard/mouse/focus, approval/questions, findings/history/replay, multi-audit navigation, recovery and shutdown. Port headless scenarios and add real PTY checks. |
| **C — Cloud/managed workers** | `packages/cli/src/commands/run.ts`; core `cloud-sink.ts`, `events/bus.ts`, `runtime/llm-api.ts`, `cloud/`; shared cloud/report types | Preserve managed-worker input/output, scope/auth, sink normalization, organization correlation, hosted routing, error codes, token-rate identity and billing separation. Qualify worker image and orchestrator together; details below. |
| **E — Evolution/extensions** | core `improvement/`, `plugins/`, CLI `dev-engine-updates.ts`, shared `live-harness.ts` | Keep immutable generation/version pins, broker authority, measured versus structural evidence, evaluation lanes/receipts, canary/promotion/rollback and lifecycle migration. Add durable campaign budget/recovery rather than copying process-local limitations. |
| **R — Reports/integrations** | `packages/cli/src/formatters/`, core report/disclosure/integration modules, CLI `finding-handoff.ts` | JSON/SARIF/Markdown/HTML/PDF/terminal outputs, retained evidence links, sink/report schemas, publication authorization, escaping/redaction and operational event boundaries. Golden fixtures plus consumers' validation. |

Provider distinctions matter: direct ChatGPT Codex inference in `llm-api.ts` and
the external Codex CLI adapter are different paths. The current `cli-native.ts`
multi-turn restriction is not proof that direct Codex-provider support is absent.
Select explicitly supported native adapters and test each; do not preserve stale
external-CLI assumptions merely because a registry description promises parity.

## Production command inventory

Source of truth: `packages/cli/src/index.ts` registers the exports in
`packages/cli/src/commands/index.ts`; `scripts/sync-cli-docs.mjs` and
`docs/src/content/docs/commands.md` cover public options. Paths in this table are
relative to `packages/cli/src/commands/`. **Legacy command parity remains open**; native `doctor` provides a narrower
runtime/state/provider diagnostic and similarly named session primitives do not
implement legacy session workflows.
Port nested options/aliases and exit behavior from the defining file, not just
the displayed command name. Tests live primarily under `commands/__tests__/`
and the owning Core module.

| Legacy commands and aliases | Defining modules | Dependencies; concrete parity check |
| --- | --- | --- |
| `scan` | `scan.ts`, `run.ts` | P/A/T/X/D/C/R; fixture web scan through discovery/triage/independent verify/report, target scope, partial failure, timeout/cost exits and cloud result line |
| `review` | `review.ts`, `review-harness-tier2.ts`, `review-harness-tier3.ts`, `run.ts` | P/A/T/X/D/R; local/git/package source, diff/subsystem/profile/seed/resume paths; preserve harness tier outcomes, don't label emitted uncompiled scaffold executed |
| `secure` | `secure.ts`; Core `secure/` | P/A/T/X/D/R; baseline regression, frozen behavioral probe, candidate/fresh-checkout replay, exact patch hash, durable workflow resume, optional PR publication |
| `fix` | `fix.ts`; Core `fix/source-fix.ts` | P/T/X/D; reproduced finding/spec precondition, source-file restriction, test failure, isolated candidate, optional apply/retest and dirty-tree handling |
| `audit` | `audit.ts`, `run.ts` | P/A/T/X/D/C/R; npm/PyPI/Cargo/OCI acquisition, identity/version pin, scanner and source findings, artifact/schema compatibility |
| `deep-review` | `deep-review.ts` | P/A/T/X/D/E/R; parallel lenses, complete source-finding reduction, independent verification, snapshot pinning, optional evolved finder protocol |
| `hunt`, `recency-hunt` | `hunt.ts`, `recency-hunt.ts` | P/A/T/X/D/R; ledger/retry/seed behavior, bounded work, stale knowledge and model-only rejection remain unresolved |
| `assumption-hunt`, `memsafety` | `assumption-hunt.ts`, `memsafety.ts` | P/A/T/X/D; domain-specific proposal and verification evidence; acceptance fixtures include false positives and clean controls |
| `specdrift extract/scan/plan` | `specdrift.ts`; Core `specdrift/` | P/T/D; extraction/map/plan schemas, source citations, drift candidates not silently confirmed |
| `protocol-check` | `protocol-check.ts`; Core `protocol/` | P/T/X/D; conformance generation, sender constraints, concrete oracle results and inconclusive failures |
| `file-review <target>` | `file-review.ts` | P/A/T/D/R; source selection, findings contract and scoped access failure |
| `resume` | `resume.ts`, `run.ts` | A/D/P/X; journal resume and branch-from-entry, retain selected runtime/generation and never replay unknown external effects |
| `console`; top-level `-r/--resume`, `-c/--continue`, `-p/--print` | `console.ts`, root `index.ts` | P/A/T/U/D/E; persisted conversation, model/target override precedence, print/stdin, approval/questions, slash commands, cancellation and session close |
| empty argv, `tui` / `watch` | `tui.ts`, TUI `run.tsx` | U/A/D; home/session navigation and full screen acceptance suite; renderer creation alone is not parity |
| `history`, `replay`, `timeline` | `history.ts`, `replay.ts`, `timeline.ts` | D/U/X/R; persisted scan queries, semantic event replay, evidence replay execution kept distinct from UI replay |
| `findings list/show/accept/suppress/reopen` | `findings.ts` | D/U/R; explicit lifecycle transitions, DB persistence, finding-to-chat/verification handoff and evidence retention |
| `dashboard` | `dashboard.ts`, `desktop/console-gateway.ts` | U/A/D/C; authenticated control API, findings/report resources, bounded events, decision lifecycle, desktop session parity and reconnect |
| `orchestrate` | `orchestrate.ts` | P/A/T/X/D/C; scheduling, worker failure, budgets, multi-target isolation and aggregate results |
| `db repair/reset` | `db.ts` | D; migration/version detection, repair behavior, explicit destructive reset contract; never open a legacy DB as a native schema |
| `triage`, `triage memory add/list/remove/mark-fp` | `triage.ts` | P/D; classifier outcomes, durable feedback and revision/false-positive semantics |
| `eval`, `bench run/diff/scoreboard` | `eval.ts`, `bench.ts` and imported `bench-*` modules | P/A/X/D/R; reproducible case IDs, pinned configs, negative controls, scorer integrity, cost/quality and comparable reports |
| `ingest` | `ingest.ts` | D/R; input validation/normalization, source artifact identity and duplicate handling |
| `verify` | `verify.ts`; Core `verify/` | P/T/X/D/C; same finding through correct independent oracle, proof requirements, clean controls and unavailable-runtime outcomes |
| `exploit` and imported exploit modes | `exploit.ts`, `exploit-agent.ts`, `exploit-climb.ts`, `exploit-autoclimb.ts` | P/A/T/X/D; scope and prerequisite evidence, bounded attempts, concrete outcome accounting; enumerate child modes from registration |
| `kernel syzbot-mine/weights/variant-hunt` | `kernel.ts`; Core `kernel/` | P/T/X/D; corpus/weights/variant artifacts and kernel build/VM/coverage/reproduction evidence, explicit unavailable prerequisites |
| `xnu-fuzz enumerate/gen/harness-plan` | `xnu-fuzz.ts` | P/T/X/D; framework enumeration, generated program validation and plan versus executed qualification distinction |
| `research pipeline/mobile/linux-matrix/linux` | `research.ts` and imported research/mobile modules | P/A/T/X/D; preserve research stage artifacts, platform prerequisites, matrix outcomes and actionable failure status |
| `binary` | `binary.ts` | P/T/X/D; supported format/architecture, disassembly and source provenance, retained evidence, unsupported input |
| `agent-assure` | `agent-assure.ts` | P/T/X/D/R; agent assurance scenario ingestion, attack/control outcomes and report contract |
| `cve find/adapt <id>` | `cve.ts` | P/T/X/D; retrieved provenance, target applicability, adaptation outcome separate from reproduction |
| `recon`, `js-recon` | `recon.ts`, `js-recon.ts` | P/T/X/D/C; authorized enumeration, asset normalization, limits/cancellation and cloud asset sink |
| `npm-discovery list/run` | `npm-discovery.ts`; Core `stages/npm-detectors/` | T/X/D; actual package-detector execution, realm versus OS isolation distinction, lead verification/handoff |
| `identity`, `adgraph`, `entragraph` | `identity.ts`, `adgraph.ts`, `entragraph.ts`; Core identity/graph modules | P/T/X/D; scoped credential/graph acquisition, offline fixtures, path analysis and sensitive result handling |
| `cloud s3-probe/validate-creds` | `cloud.ts` | T/X/D; target cloud assessments with explicit scope; this command is not the hosted inference client |
| `intel dossier/target-history/search/cve/similar` | `intel.ts`; Core `intel/` | P/D/R; retrieval/cache/source citations, filtering and saved intelligence compatibility |
| `disclose`, `evidence-pack`, `track`, `review` | `disclose.ts` | D/R/C; disclosure prerequisites, evidence pack integrity, redaction, review state and publication boundaries |
| `h1 auth/programs list/show/scope/dump` | `h1.ts`; Core `h1/` | P/T/D/R; token handling, program/scope normalization, pagination and fixture HTTP failures |
| `auth login/logout/status`, `connect` | `auth.ts`, `connect.ts`, `codex-auth.ts` | P/U; credential precedence, device-auth cancel/expiry, private persistence, connection switching without mutating active runtime |
| top-level `login`, `models`, `balance` | `hosted.ts`; Core `cloud/client.ts` | P/C; hosted account/catalog/error handling, disabled inference and credit exhaustion, no secret output |
| `mcp-server` | `mcp-server.ts` | A/T/D/E; declared profiles/tool schemas, client initialization, scope/budget enforcement, cancellation and typed error responses |
| `plugin list/search/browse/install/enable/disable/info/run` | `plugin.ts`; Core `plugins/` | E/T/X/P; manifest admission, content/version identity, enabled/trusted distinctions, executable broker, cancellation, uninstall cleanup |
| `hackstore init/validate`, aliases `hack`/`store` | `hackstore.ts` | E/D; scaffold and manifest validation, marketplace schema and path safety, alias compatibility |
| `evolve run/status/promote/rollback/exec/feedback` and feedback children | `evolve.ts`; Core `improvement/` | E/X/P/D; sealed lanes, exact oracle, receipts, canary, pinned reader, approval/promotion and restart accounting |
| `lens-synth` | `lens-synth.ts` | E/P/D; positive/held-out/control corpus, generated lens admission, overlay version pin and promoted-versus-measured distinction |
| `theme list/install/apply/export/remove` | `theme.ts` | U/E; palette persistence, schema compatibility, active UI behavior and malformed theme |
| `config show/export/import` | `config.ts`, TUI `settings-store.ts` | P/U/E; precedence, settings roundtrip, explicit false retention, host-only trust/source-update flags not granted by project config |
| `doctor` | `doctor.ts` | P/X/U; runtime/tool/image/prerequisite diagnostics without accidentally starting scans or provisioning hosts |
| `upgrade` / `update` | `upgrade.ts`, `utils/update-check.ts` | release/install; update opt-in, platform artifact selection, failed-update recovery and executable restart behavior |

Top-level target shorthand (`URL`, local path, `source:`, `npm:`, `pypi:`,
`cargo:`, `oci:`), ambiguous bare-token rejection, known-command routing and
aliases are separate acceptance cases in `routing.ts`/`routing.test.ts` and
root `index.ts`. Audit imported helpers such as `mobile.ts`, `cross-validated-leads.ts`
and `bench-*` for reachable child commands; a file's existence alone does not
make it an independently registered top-level command.

## Cloud and compatibility gates

- [ ] Port `run.ts` result emission: `0SEC_EMIT_RESULT_LINE`, `0SEC_CLOUD_SINK`
  and `0SEC_RESULT=<json>`. Preserve exit codes, partial results and cost fields.
  App-server NDJSON is a different protocol; do not replace worker framing by
  renaming the binary.
- [ ] Port the core event sink in `events/bus.ts` and startup subscription in
  CLI `index.ts`: `0SEC_CLOUD_EVENTS` and `0SEC_EVENT_<TYPE>` lifecycle records.
  Verify downstream parsing against retained golden streams and controller tests.
- [ ] Preserve `cloud-sink.ts` normalization and findings/report/asset upload,
  `0SEC_CLOUD_SCAN_ID`, token/org correlation and feature gating. Test gateway
  failures, retry/idempotency behavior, missing credentials and final flushing.
- [ ] Preserve `http_audit` target/environment translation (`0SEC_TARGET_*`) in
  `run.ts` only for that explicit mode; do not give ordinary source/evolution
  workers the same network/auth profile.
- [ ] Finish hosted inference parity: metadata routes and browser-session login
  are fixture-tested natively; preserve `/api/inference/v1/models`,
  `/api/inference/account`, `/api/inference/usage`, health routing and inference
  transport from `cloud/client.ts` and `runtime/llm-api.ts`. Port nested gateway
  error codes, especially inference disabled and exhausted credit.
- [ ] Qualify parent/subagent/plugin/evolution provider routing and usage. Current
  architecture docs explicitly call hosted evolution candidate-stage; fresh
  subagent runtimes and trusted external clients are not automatically covered
  by the parent's broker/accounting. Native implementation must make ownership
  and model selection explicit.
- [ ] Retain immutable catalog price identity and provider usage provenance;
  distinguish inference credit, compute, review and engagement accounting.
  Integer storage budget primitives are not organization billing.
- [ ] Qualify Windows evidence-worker receipts and 0verse handoff separately
  (`cloud/windows-evidence-worker.ts`); a generic successful process exit does
  not establish crash reproduction or privilege escalation.
- [ ] Run a staged managed-worker integration with the real orchestration
  contract and deployment image. No cloud release cutover from fixture success.

## Self-evolution and frontend replacement gates

- [ ] Preserve existing Cordis 4.0.2 lifecycle semantics (`plugins/live-harness.ts`):
  complete graph, provider dependencies, invocation leases, pending/active state,
  prepare/migrate before switch, reverse disposal, current-state rollback and
  rejection of stale generation-bound UI actions.
- [ ] Port language-neutral `plugins/protocol.ts` broker and immutable executable
  registry before replacing generated tools. TypeScript/Python guests may remain
  guest dependencies; retaining them is not retaining a TypeScript host engine.
- [ ] Port structural-versus-measured evidence, exact source/config/image/receipt
  identities, hidden-lane separation, pinning and authorized artifact installation.
- [ ] Replace dev ESM importing (`dev-engine-updates.ts`) with an explicit native
  build/prepare/checkpoint/process-handoff path. Preserve history, denied/granted
  scope, objective, executor state, accounting and extension state. A failed
  candidate leaves the current engine usable; rollback never reissues effects.
- [ ] Add versioned persistent component state migrations and durable campaign
  reservations/settlements/exposure. Current watch-loop accounting resets on
  process restart; do not call that durable recovery.
- [ ] Keep portable `HarnessView` data/commands/settings. Existing trusted
  React/ESM factories require an explicit adapter or replacement decision.
  Always retain host-owned recovery controls.
- [ ] Port `presentation.ts` and desktop-console contracts through adapters,
  not another independent session engine. Existing producer-local presentation
  sequence numbers and the desktop gateway's bounded memory history are not a
  durable replay protocol.
- [ ] Qualify repeated upgrade/failure/rollback/cancel cycles locally, then
  desktop and hosted operation. The improvement-plane document explicitly
  leaves these broader qualifications open.

## Delivery order and final cutover

1. Finish native foundation semantics and platform-qualified execution; preserve
   explicit uncertainty on crash/cleanup. Qualify snapshot pin/admission tooling and
   stable test fixtures without expanding unsupported capabilities implicitly.
2. Implement P/A/T/D together for one complete scripted local agent session:
   provider turn, tool approval, execution, durable outcome, cancellation,
   history restore, replay and measured cost. Use mocked providers initially.
3. Implement U against that same application API; demonstrate terminal/session
   parity independently from renderer screenshots. Port auth and settings.
4. Implement E against the same supervisor/store/broker. Add crash-safe budgets,
   migration and long-session qualification before autonomous campaigns.
5. Port security workflow families above, prioritizing one complete source
   review/reproduce/fix/report path and one scoped web path; retain specialist
   oracle distinctions. Compare quality and cost separately from language parity.
6. Complete C/R, DB import, desktop adapters, packaging and the remaining
   specialists; qualify actual managed workers and provider/platform matrices.

- [ ] Review every registered command/options/alias against generated CLI docs;
  intentional changes have explicit migration notes, not accidental omission.
- [ ] Port report/schema golden fixtures, scope/verification regression suites,
  provider wire fixtures, TUI driver scenarios and real execution smoke checks.
- [ ] Test old saved data/checkpoints/settings with versioned import and backup;
  keep `.0sec/native/state.db` separate until an explicit migration is supported.
- [ ] Record cold help/session startup, idle/streaming memory, large transcript
  rendering, cancellation/cleanup latency and artifact size against TypeScript.
- [ ] Qualify Linux/macOS/Windows packaging as applicable; state backend-specific
  limitations. Revisit `install.sh`, `scripts/{bundle-cli,install-e2e,smoke-cli}.*`,
  `.github/workflows/{release,install-e2e}.yml` and Docker toolbox/runtime targets.
- [ ] Switch installer/binary names and managed images only after reviewed
  acceptance gates; retain a rollback artifact and documented data compatibility.

The branch is complete when these product and deployment gates are satisfied or
explicitly retired with a migration decision—not when the Rust workspace builds.

## Latest incremental acceptance: listing and Markdown

Source listing commits `87bb98d8` and `804221e5` expose every authorized file
through bounded deterministic pages; the engine fixture traverses 67 files with
no duplicates or backend work. Scope, malformed cursor and byte-limited page
regressions preserve the same source authority on every page.

`3594beb8` adds `report --format markdown`, matching an actual TypeScript golden
fixture for ordinary supplied report data. Hostile markup and code fences are
escaped, missing metadata is explicit, and an empty report does not become a
clean-target verdict. Seven renderer tests and five executable report tests pass
on current Rust and Rust 1.85. This is renderer parity for the tested format,
not scanner, managed-worker, HTML/PDF or complete report-workflow parity.

The combined workspace run passed 389 tests and production Clippy before the
last added Markdown output-expansion regression; that additional test passed
separately on both compilers. Adaptive investigation now has an explicit structured submission mode, described
below. Generic agent prose remains distinct from a source-review result.

## Adaptive discovery and HTML reports

An agent request may opt into `source_submission_max_hypotheses: 1..32` together
with whole-snapshot source tools. Only a sole terminal submission with validated
selected-file/hash/line citations can complete this mode. The engine retains the
actual final provider request and completion, selected source bundle and review;
reproduction, repair preconditions and retained-source tools revalidate that
provenance before accepting the operation. Empty selections use explicit
manifest-only bundle version 2 and can establish no nonempty cited hypotheses.
All hypotheses remain unverified; an empty result is not a clean verdict.

Acceptance covers investigation → structured review → frozen reproduction,
restart exact retry after source deletion, mixed-tool/prose/citation rejection,
artifact persistence failure, corrupted provider evidence, cleanup uncertainty,
and request-size rejection before provider expense. Private cleanup still
precedes parent success. Turn-limit checkpoints may continue with the same mode;
terminal structured submissions close their conversation. Full legacy review
flags/lenses, automatic independent oracle construction, target scope/network
tools, and finding/reportability policy remain unfinished.

`8a0b6a30` adds `report --format html`, preserving representative legacy report
fields and severity ordering against an actual TypeScript golden fixture. It
uses self-contained styling, escaped content, explicit proof/remediation and
truncation, and no inferred clean-target verdict. Nineteen report tests and six
CLI report tests pass on current Rust and Rust 1.85. Whole-document byte identity
is deliberately not claimed; PDF and complete scanner/managed-worker report
integration remain open.

Combined acceptance for adaptive discovery and HTML: all 410 workspace tests
passed on Rust 1.85 with the locked dependency graph; production library/binary
Clippy passed with warnings denied. These local checks do not establish the
remaining deployment, scanner-quality or full command-parity gates.

## Native source evidence export

`source-report --session ... --operation ... --format json|markdown|html`
exports succeeded dedicated/adaptive review evidence through a read-only journal
view. Both paths validate retained request/completion, provider child correlation,
submission semantics and citations. Provider/harness configuration, engine
ownership and the original source tree are unnecessary. Corrupt or uncertain
reviews cannot be exported as successful reports.

This is a separate schema for unverified source hypotheses with provenance hashes,
not a legacy scan report. Empty reports establish no target-safety conclusion.
The export omits private source bytes, snapshot paths and provider transcripts;
supplied claim text is rendered faithfully with format-appropriate escaping.
Explicit reproduction/repair linkage is added in the subsequent checkpoint
below. Reportability policy, SARIF semantic mapping and managed-worker
publication remain unfinished.

The acceptance run exposed an engine ownership race; `fbead76f` makes worker
reference release precede terminal replies, and makes shutdown await release even
when the caller does not await those replies. A separate completion token records
release after the worker's last engine reference is dropped. Regression checks
include 64 immediate reopen cycles, shutdown with no active registration but a
remaining worker reference, and notification after last-reference release.
Caller-held engine handles must still be dropped before reopening the journal.

Combined source-export and ownership-release acceptance: 426 workspace tests
passed on Rust 1.85 with locked dependencies; formatting and production Clippy
with warnings denied passed. The earlier failed full run is superseded by this
run after the ownership fix. Live-provider and real-container qualification were
not rerun for this checkpoint; existing opt-in tests remain separate gates.

## Linked source workflow reports

`source-report` now accepts repeated `--reproduction` and `--repair` operation
IDs, bounded to 32 distinct links combined. A repair's baseline must also be
explicitly selected. Version 1 review-only exports preserve their serialized
shape; linked exports use version 2. The `zero-engine` read-only workflow
provenance owner reconstructs exact ordered matrices from hash-checked artifacts,
correlates child requests and terminal outcomes, and recomputes assessments.
Candidate receipts and derived plans are checked against the original host
request without reading mutable source or staging a new candidate. Repair
admission reuses the same strengthened baseline validation.

The legacy report/evidence workflow dependency R now has native source-review,
reproduction and private candidate validation in one export. It is not a legacy
`ScanReport`, an independent security oracle, workspace patch application or a
publication/disclosure capability. All source hypotheses remain unverified;
`ObservedForPlan` and `ValidatedCandidateForPlan` retain their limited meaning.
Cancelled, not-observed, inconclusive and unknown assessments remain visible when
retained evidence supports them. Unavailable/corrupt evidence fails export instead
of yielding an invented assessment. Private paths, source/replacement bytes and
raw process output are omitted from the projection.

Acceptance includes all three formats after source deletion/restart, exact child
and repair provenance mutation rejection, explicit link/selection bounds,
cancellation before and during execution, unknown cleanup and unsuccessful
candidate/control outcomes. Existing source artifacts and journals are reused;
there is no database migration, provider call, backend dispatch or implicit
selection of a newest result during export. Managed worker schemas, legacy
finding conversion, SARIF policy and end-to-end scanner quality remain open.

The full acceptance run also reproduced a lock inherited across fork before
exec. `9d0dc5fb` explicitly unlocks on final engine-owner destruction after state
and worker teardown. Its deterministic pre-exec regression failed on the prior
code and passes with the fix; a live worker still excludes a second engine.
Successful source/reproduction exports now reject contradictory retained errors.
Final Rust 1.85 workspace acceptance passed 437 tests; production Clippy passed
with warnings denied. Real backend qualification is recorded below when complete.

The final source state also passed the real CLI review → baseline reproduction →
private candidate → fresh reconstruction → linked JSON/Markdown/HTML export
fixture on both prepared backends: Docker (4.08 s) and smolvm 1.14.6 (55.99 s).
Each performed 12 observations, then exported after original-source deletion
without further provider/backend calls. These are local fixture qualifications,
not independent detection-quality or managed-cloud deployment claims.

### Hosted catalog-to-inference routing

The native CLI can configure the explicit `hosted` inference profile from existing
login credentials and `--hosted-model`, with optional host, token-environment and
timeout overrides. Catalog routing preserves host path prefixes, chooses the
advertised Responses/Chat wire API, and sends only the selected public model ID.
Prices convert exactly from decimal USD-per-million to integer micro-USD rates;
no floating-point rounding or implicit free-price fallback is accepted.

Durable inference, agent and source-review identities retain the selected model's
normalized catalog quote and digest alongside route and rates. The provider binds
model/output policy before dispatch, and recorded provenance rechecks the quote.
A changed quote cannot resume or retry the old command as a new paid effect.
This pin establishes internal consistency, not catalog authenticity, current
pricing or an attested bill. Metadata discovery may occur again on retry.

Direct inference supports requested output limits within the catalog bound.
Agent and source-review retain their current 8192-token request and require that
capacity. Dynamic output sizing, hosted OAuth, production scanner parity and
managed worker deployment remain separate migration work. Qualification uses
loopback gateways and persisted native state; it does not establish live hosted
service compatibility or authorize paid calls.

Qualification passed the complete Rust 1.85 workspace: 461 tests, with real
backend tests remaining opt-in. Production workspace Clippy passed with warnings
denied, and formatting passed. New fixtures cover both hosted wire formats,
cached usage, no repeated inference on retry or catalog drift, unknown reservation
holds, exact decimal metadata output, source/continuation pin correlation, and
IPv6 loopback routing. The first workspace run exposed a global JSON-number
feature regression in existing agent/console decoding; the final implementation
uses local raw decimal parsing and canonical strings in retained quotes. Existing
agent and console executable tests pass in the final workspace run.


### Durable queued agent inputs

Native `QueueAgent`, `AgentQueue`, `RunQueuedAgent` and `CancelQueuedAgent` commands
replace the in-memory follow-up queue boundary with journaled intent. The CLI
exposes `queue enqueue/list/run/cancel`; console lines receive durable input IDs
while a turn is active. FIFO follow-ups name exact successful predecessors and
retain the existing provider/history/authority checks. Exact dispatch retry uses
a fixed operation identity; Unknown work never replays and budget holds remain.

The legacy reference is the 50-item composer queue in
`packages/cli/src/tui/composer-queue.ts` and chat-screen idle draining; core
`ConsoleSession.send` itself rejects simultaneous turns. The native store owns
acceptance/cancellation and schema 5 migration, the engine owns dispatch and
operation recovery, and the console/app-server are clients. Read-only exports
require the current schema without migrating it. Existing native artifacts and
operation identities survive the v4→v5 upgrade.

See [queue semantics](crates/zero-engine/QUEUE.md) for restart, partial stdin,
continuation and cancellation boundaries. Pending inputs are explicit resumable
intent, not already-spent operations. Queue admission does not reserve funds or
attest a current provider quote. Full TUI, editing queued prompts, mid-turn
steering, subagent coordination, interrupted-turn checkpoints and context
projection/compaction remain open parts of gate A/U.

Qualification passed 484 tests across the complete workspace on Rust 1.85,
plus strict production Clippy and formatting. Focused acceptance includes six
engine queue tests, twelve store queue/migration/provenance fixtures and five CLI
queue scenarios. Those exercise concurrent cancel/dispatch, restart and generic
recovery receipts, Unknown usage holds, altered persisted authority, partial stdin
across turn completion, app-server enqueue during work, EOF drain and signal
shutdown with acknowledged pending inputs. Backends and providers use the existing
qualified paths; these new queue fixtures use loopback inference, not paid calls.

### Explicit context projection over retained history

`zero-context` owns pure bounded projection over explicit completed-round spans.
The optional `AgentRequest.context_policy` preserves absent-field serialization
for historical requests and is pinned across continuation. The engine captures
an immutable request template, retains full input state and deterministic receipt
before the inference child or budget reservation, and records their digests in
the child. Actual provider requests remain journal truth. Continuation and
turn-limit checkpoints restore full retained input before adding the next prompt;
adaptive source evidence also checks the context binding during read-only export.

This advances the context-projection requirement in gates A/U without copying the
legacy lossy summarizer in `agent/native-loop.ts` or its context-error retry loop.
Every user prompt, instruction and tool schema survives; only older complete
assistant/tool-result rounds can be omitted, while recent rounds and opaque
provider replay metadata remain intact. A required span that exceeds the explicit
byte policy stops dispatch. Context reduction adds no hidden inference charge or
retry, and does not rewrite older operations, checkpoints or evidence.

This checkpoint is deterministic omission, not semantic compaction. Summaries
with bounded complete coverage and their own usage receipts, retrieval of retained
history, real provider token-window accounting and full long-session quality
qualification remain open. The full retained state has an 8 MiB/10,000-item bound;
retaining per-turn snapshots also consumes the existing 32 MiB parent artifact
quota. Policy bytes measure serialized input only, not a tokenizer or complete
provider body size. Production release routing and database schema are unchanged.

Restoration also checks exact ancestor prompts, operation/turn chronology, original
completion replay and ordered tool outputs against the next request or terminal
checkpoint. Receipt hashes alone are not proof that omitted data matches its
original journals. This validation uses bounded nonrecursive journal lookups,
cycle checks and a cumulative 64 MiB read budget; exceeding it fails explicitly.

Qualification passed all 505 workspace tests on Rust 1.85, strict production
Clippy and formatting. Ten pure projection fixtures, seven engine scenarios and
three executable CLI scenarios cover Responses, Chat and Anthropic replay, queued
continuation, restart, exact retry, quota failures before dispatch, and corruption
of omitted history even after hashes are recomputed. An additional regression
requires the exact latest-round suffix when repeated replay could otherwise
witness an earlier tool result. Provider fixtures use loopback HTTP without paid
calls. Independent final review found no remaining concrete blocker.

### Bounded source search and historical tool schemas

`search_source_text` now accepts optional `mode` (`literal` or `regex`) and
`case_sensitive` arguments. Omitting them preserves native literal,
case-sensitive behavior. Explicit case-insensitive literal search supplies the
legacy scoped-search capability; regex replaces a subset of searches previously
performed through scoped `rg`. This does not add arbitrary shell execution or
change source authority. Retained bundles and entire pinned snapshots use the
same matcher and return exact original lines with their pinned hash citations.

Regex patterns are restricted to 256 UTF-8 bytes, nesting depth 32, an approximate
256 KiB compiled program and 256 KiB DFA cache. Matching is per logical line
(with CRLF/LF terminators removed for matching only), using the Rust regex engine;
look-around and backreferences are rejected. Existing file, aggregate source,
200-result and 64 KiB output limits still apply. Invalid patterns return a tool
error; they never broaden scope or fall back to a shell. Unicode case-insensitive
matching uses regex simple case folding, not locale-dependent matching or a
promise of identical JavaScript lowercasing for every Unicode string.

Context-policy continuation chains retain their original validated request
and tool template across implementation upgrades. New conversations capture the
new tool definitions; historical conversations keep their recorded definitions
on every subsequent provider turn. Source dispatch rejects arguments absent from
that offered schema. Historical journal/receipt comparisons remain strict, and
exact retries do not reinterpret old source calls or reread deleted source.

Qualification passed all 515 workspace tests on Rust 1.85, strict production
Clippy and formatting. New coverage includes six pure source-search fixtures,
three engine fixtures covering both source authorities and historical schemas,
and an executable CLI fixture checking exact CRLF/LF citations and restart retry
after source deletion without additional HTTP. Completed and turn-limit context
chains each survive two restarted continuations with their historical templates.
Independent review found no remaining concrete blocker in this checkpoint.

### Source-hypothesis operator triage

Native `findings list/show/accept/suppress/reopen` now connects the existing
validated dedicated and adaptive source-review records to durable operator
triage. Commands name an exact session, source operation and hypothesis ID;
source-review artifact identity is validated and bound to each decision.
`new`, `accepted` and `suppressed` are operator states only. The original
hypothesis remains unverified, and reproductions, repairs and reportability
retain their existing evidence requirements.

Schema 6 adds an append-only decision ledger. Expected revisions prevent lost
updates; exact command retries return the original decision without undoing
later triage. A successful fresh decision, including a repeated status with a
new note, advances the revision. Notes are bounded to 4 KiB. Read paths expose
pages of one immutable review (up to 32 hypotheses) and cursor-paged history
(up to 100 decisions), each bounded to 1 MiB, without a lifetime decision cap. The decision and its session event are
committed atomically. Triage command IDs have a separate session namespace from
execution operations.

The CLI read paths use read-only current-schema inspection while an engine can
remain active. No provider or execution backend is consulted. This advances
D/U/R workflow requirements, but does not claim legacy `findings` parity:
legacy database import, all-scan queries/filters, fingerprint-family updates,
verification handoff and complete TUI presentation remain open. Unlike the legacy
workflow-status coupling, reopening operator triage does not rewrite evidence
or independently managed work state.

Qualification passed all 532 workspace tests on Rust 1.85, strict production
Clippy and formatting. Ten store fixtures cover concurrent revision checks,
transaction rollback, source bindings, schema migration, byte-bounded pages and
oversized replies rejected before commit. Six engine fixtures cover dedicated
and adaptive review provenance, cross-operation identity isolation, corruption,
unchanged reports and budgets, and empty reviews without a safety verdict.
Executable CLI coverage exercises restart decisions after source deletion,
stale/changed retries, historical receipts with current state, and byte-identical
read-only inspection while an engine owns the journal. Independent final review
found no remaining concrete blocker in this checkpoint.

### Live model progress separated from effect control

The provider transport can now expose bounded, typed progress across Responses,
Chat Completions and Anthropic Messages without changing their authoritative
completion parsers. It observes only frames accepted by those parsers. Explicit
text, refusal, exposed reasoning and tool fragments are allowed; encrypted replay,
signatures, redacted thinking and raw error bodies remain absent. No terminal
snapshot fallback is emitted, preventing duplicate delta reconstruction.

Each fragment carries at most 16 KiB of UTF-8 string data; each inference emits
at most 4096 progress items and 4 MiB of such data. These are display limits,
independent of the existing provider response bounds. Tool fragments can be
incomplete and are never executable. Final completion content, usage and original
replay remain authoritative, including when progress was dropped or suppressed.
This is not generic redaction: model text and argument fragments may contain
source or user data.

The engine adds session, paid-operation and optional parent identity and a
sequence advancing even when its nonblocking delivery drops an item. The new
`handle_with_progress` API requires a distinct channel from operational events;
the existing `handle` API preserves its prior no-progress behavior. The app-server
prioritizes replies/operational events over a separate bounded progress queue.
This prevents advisory updates from consuming capacity whose loss can cancel an
admission or sandbox operation. Clients ignore late progress after the terminal
receipt; progress sequence is neither a persisted event cursor nor a complete
replay stream. Exact retries do not emit it again.

This advances P/A/U streaming requirements and supplies a prerequisite for a
native interactive frontend. Full-screen rendering, conversation-history
projection, approval/questions, multi-audit navigation and real PTY frontend
qualification remain open; line-console output behavior is unchanged.

Qualification passed all 547 workspace tests on Rust 1.85, strict production
Clippy and formatting. Provider fixtures hold terminal frames until callbacks
arrive and compare complete results with/without observers across all three
wires. They cover fragment/aggregate caps, UTF-8 boundaries, interleaved tool
arguments, opaque-field exclusion and cancellation. Engine fixtures cover all
four paid dispatch paths, host-assigned correlation, exact retries, dropped
sequence gaps and progress flooding followed by sandbox execution. Four real
CLI app-server fixtures prove delivery before terminal completion, unchanged
accounting and unknown usage holds after cancellation. Independent final review
found no remaining concrete blocker in this checkpoint.

## Native terminal client checkpoint

`zero-tui` is a separate protocol client with session, conversation and durable
queue views. The CLI launches an owned app-server with explicit configuration;
only that subprocess owns the database and execution lifecycle. Bounded session
listing and newest-first conversation history are read-only engine APIs. Display
text truncation never changes retained journal values or model context.

The frontend supports Unicode composition, bracketed multiline paste, resize,
provisional streamed text/reasoning/tool fragments and explicit queue resumption.
Opening saved pending work does not dispatch it. New followups use durable
acknowledgments and engine-validated continuation; uncertain or failed work stops
automatic draining. Terminal exit restores raw-mode/alternate-screen state and
closes the app-server input before waiting for engine cancellation and cleanup.

This advances U; it does not close the full legacy terminal gate. Approval and
question dialogs, full findings presentation, multi-audit navigation, mouse/focus
parity and cross-platform terminal qualification remain open. Production command
routing and release gates are unchanged.

Qualification: 575 workspace tests passed on actual Rust 1.85 (11 explicit
environment-dependent ignores). Final state safeguards then passed all 14 TUI
state/transport tests and all eight real PTY cases again. Strict production
workspace Clippy and formatting passed. PTY fixtures prove raw/alternate/paste
restoration, Unicode multiline paste and resize without submission, live text
before completion, final accounting, Unknown holds after cancellation/quit,
SIGTERM and child-EOF cleanup, and repeated pending-queue restart without HTTP.
One earlier existing evaluation recovery test reported an ownership-lock failure;
it passed isolated, in its full crate suite and in the successful workspace
rerun. No cause was established and no speculative evaluation change was made.
