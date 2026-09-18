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
| Native state | `crates/zero-store`: SQLite sessions, command admission, owner-bound operation settlement, ordered events, budget reservation/settlement, transactional epoch recovery and schema v1/v2/v3→v4 migration, optional activation epoch pins and immutable operation artifacts | Full prompt/message/context projection; further schema upgrades; explicit legacy import; durable multi-process campaign accounting |
| Application engine | `crates/zero-engine`: session queries, idempotent execution, cancellation, engine ownership lock, uncertain-operation recovery, finding reconciliation, durable Responses/Chat/Anthropic inference, bounded offline Docker/smolvm snapshot agent with explicit completed-turn continuation from immutable journal records | Remaining providers, full tools/permissions and agent workflows, queued/steering input, interrupted-turn checkpoints and generation lifecycle |
| Batch execution | `crates/zero-executor`: validated snapshot pin/copy, local image identity, nonroot Linux offline Docker lifecycle, bounded raw output, cancellation and explicit cleanup outcome | All other execution profiles below; real Docker qualification remains separate from injected CLI fixtures |
| MicroVM execution | `crates/zero-smolvm` and `zero-sandbox`: explicit pinned archive, qualified runtime version, nonroot offline batch lifecycle, verified snapshot staging and native engine/agent selection; real guest and engine/agent smoke passed | Broader isolation/SIGKILL qualification, live-provider matrix and interactive execution |
| Source review | `crates/zero-source` and engine `source.rs`: bounded selected source bundle, grounded structured hypotheses, retained request/bundle/completion/submission, same-session provenance and exact retry; `source-review` CLI | Source exploration, automatic investigation and specialist verification; hypotheses remain unverified, including successful model submissions |
| Frozen reproduction | `crates/zero-verification` and engine `reproduction.rs`: host-owned immutable exact-output plans, repeated attack/control matrix, journaled sandbox children and retained requests/evidence; `source-reproduce` CLI | Broader domain oracles, automated plan proposals and independent detection-quality evaluation; `ObservedForPlan` never means vulnerability reportable |
| Plan-qualified repair | `crates/zero-repair` plus engine `repair.rs`: host-authorized private single-file candidate, protected paths, baseline evidence revalidation, safe-expectation matrix and fresh reconstruction; `source-repair` CLI | Workspace installation, broader repair generation/verification, specialist safety oracles and full legacy `fix` parity; validation is limited to the frozen plan |
| Artifact inspection/export | Read-only exact-schema `zero-store` opener and CLI `artifact list/export`: session ownership, bounded hash-checked bytes, private no-clobber export while the engine remains active | Legacy evidence-pack/report integration, disclosure authority and broader storage/platform qualification |
| Provider transport | `crates/zero-provider`: bounded Responses/Chat/Anthropic SSE, explicit routes, final/provisional usage distinction, integer rate accounting and conservative uncertainty | Remaining wire features, provider OAuth/refresh, hosted inference routing, live-provider qualification |
| Plugin admission | `crates/zero-plugin`: strict manifests, hashed artifacts, exact dependency graph, host grants and bounded inert RPC framing | Bidirectional broker and persistent workers; admission alone never executes plugin code |
| Plugin runner | `crates/zero-plugin-runner`: pinned offline single-call RPC through Docker/smolvm, exact response correlation, retained leases on uncertainty; actual Node fixture passed on local Docker | Bidirectional broker, persistent workers, broader backend/platform qualification; engine direct calls now journal preparation and settlement |
| Generation graph | `crates/zero-harness`: verified complete plugin/artifact/policy graph, activation epoch pins, durable invocation leases and current-state rollback | Measured evaluator promotion and native process replacement; persisted session epochs and direct engine calls are implemented |
| Generation registry | `crates/zero-evolution`: immutable artifacts/receipts, eligibility, instance-bound preparation, activation CAS, leases and current-state rollback | Runtime graph disposal, measured evidence import/promotion, campaign qualification and native process handoff |
| Fixture evaluation | `crates/zero-evaluation`: isolated paired baseline/candidate execution, frozen exact JSON oracles, durable attempt budgets, observed outcomes and deterministic receipts; real Docker fixture passed | Portable evidence import, independent corpus governance, production eligibility/canary and autonomous candidate writing; fixture eligibility is not a detection-quality claim |
| Report rendering | `crates/zero-report`: bounded legacy JSON preservation and SARIF rendering with an actual TypeScript formatter golden fixture | Full workflow integration and report schema qualification; rendering does not verify findings |
| Hosted metadata | `crates/zero-cloud-client`: explicit authenticated health/catalog/account/usage GETs, bounded browser-session login polling, typed gateway errors and credit normalization; CLI resolves environment or private legacy `cloud.env` credentials | Live service qualification, provider OAuth/refresh, price identity/inference routing, upload/accounting and managed-worker qualification |
| Cloud wire adapter | `crates/zero-cloud-compat`: result/event framing, typed outcomes, cost provenance and atomic report writing | Scanner integration, ordered scan-total accounting, uploads and managed deployment qualification |
| Finding reduction | `crates/zero-evidence`: source IDs/provenance retained through complete reconciliation, explicit disposition accounting | Discovery, independent vulnerability oracles, storage/export and disclosure eligibility; reconciliation is not truth validation |
| CLI | `crates/zero-cli`: `schema`, `snapshot pin`, `session create/create-pinned/list/show/events/budget/reconcile-usage`, `exec`, `sandbox`, `infer`, `agent`, `plugin-call`, `evaluate run/status`, `source-review`, `source-reproduce`, `source-repair`, `artifact list/export`, line `console`, `hosted login/health/models/account/usage`, `doctor`, `app-server`, help/version; separate `.0sec/native/state.db` | All legacy commands below; UX/exit/schema compatibility; installer and platform release qualification |
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
proof of repair quality. Real smolvm repair qualification remains open.

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
(`packages/core/src/agent/tools.ts`). Whole-repository selection/ingestion, regex
search, role-specific tool policy and investigation-driven structured submission
remain open. The review still requires host-selected files; retained-source tools
do not silently broaden the selected set.

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
