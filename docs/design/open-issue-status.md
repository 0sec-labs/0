# Open issue status and reconciliation

Reviewed on 2026-09-30 against main commit `2736deb2`. The checkout was 99 commits behind main and contained a bulk rename mixed with unfinished changes. Current main already includes much of that work. Reconciliation preserves the original state on a local recovery branch and ports only reviewed changes onto current main.

This document records all 17 open issues and their remaining acceptance work. Source inspection establishes implementation presence, not runtime correctness or research efficacy. The Codex device-auth tests (6 tests), repository-acquisition tests (7 tests), and the complete baseline build passed during reconciliation. Further merged changes and checks are recorded below. Issues are not automatically complete merely because a related patch exists.

## Remaining priorities

1. Qualify worker target identity in the external delegation runtime. The engine guard detects inherited Git scope mismatches but does not repair another runtime's filesystem remapping.
2. Validate product identity and bounded verification in controlled real-model console sessions. Deterministic tool regressions cover the software contract; they do not prove every model follows it.
3. Reconcile #52 with the current UI direction and qualify #48, #53 and #54 through controlled CLI runs.
4. Finish #119 evidence reconciliation, then a finite #120 qualification with actual evaluated-worker model provenance and provider cost. Keep #37–41 open for their specific remaining acceptance requirements.
5. Keep #121 and #122 as conditional experiments. Expand #39 search only after equal-budget evidence.

## Reconciliation changes

The original work is preserved on local branch `recovery/local-work-20260930` and in a named stash. The recovery snapshot is not a publication branch. Most rename and UI work already exists upstream; newer upstream packaging, compatibility aliases and simplified worker display are retained.

Reviewed changes include endpoint query-credential redaction in exported assurance manifests, a real restricted-PATH Codex renderer regression, inherited Git repository identity checks before worker inference, bounded YOLO verification guidance and host-generated source/replay receipts, and opt-in Jev ranking and specialist routing. Jev thresholds are uncalibrated; unknown evaluator model IDs retain existing fallback token pricing. The broken registration of a missing benchmark command, credential-retention characterization test, and alternative UI cosmetics remain in the recovery snapshot.

GitHub's 18 open dependency alerts map to three packages: PyJWT, urllib3 and ip-address. The updated locks resolve PyJWT 2.14.0, urllib3 2.8.0 and ip-address 10.7.2 with minimum security floors. Frozen installs and relevant Python/MCP/IP checks pass. Alert dismissal depends on GitHub rescanning the merged lockfiles.

## Per-issue findings

### #146 — Delegated workers resolve absolute target to default workspace

**Status: engine defense implemented; external runtime issue remains open.** Source-review descendants inherit a parent-observed canonical scope path, Git root, origin and HEAD. Both transient and persistent worker paths validate that identity before analysis. Git probes ignore ambient `GIT_*` overrides and reject roots that do not contain the scoped directory. Regression fixtures cover repository A as default with an absolute repository B target, symlink remapping, changed commits and missing targets. Non-Git scopes retain their existing behavior. This does not repair external delegated-agent filesystem remapping or interpret an arbitrary path mentioned only in task prose as a new authorized target.

### #147 — YOLO automatically verifies findings and bounded PoCs

**Status: workflow guidance and trusted continuation receipt implemented.** YOLO instructions direct credible leads into bounded verification without routine confirmation. A successful finding save returns host-observed source and replay status, explicitly distinguishing persistence from runtime reproduction. Regression tests execute a real local parser PoC through normal tool gates and report a missing runtime as process exit 127, without invoking approval or operator-question callbacks. Explicit read-only requests, scope, credentials, sandbox controls, budgets and cancellation remain authoritative. Real-model behavior still needs controlled qualification; the implementation does not force arbitrary PoC execution.

### #49 — Missing Codex executable guidance

**Status: implementation and restricted-PATH renderer regression pass.** Codex device auth probes the console's own process PATH before launch and handles launch ENOENT as an unavailable prerequisite. Recovery explains installation or PATH repair and restart. Six unit tests and five provider-connect renderer scenarios pass, including missing Codex, no raw spawn error or generic retry guidance, and navigation to another provider without saving credentials. No real OAuth login was performed or needed to test missing-dependency recovery.

### #51 — Wrong repository for Muse Spark

**Status: exact-target guard merged; product identity guidance and specific regression added.** Console acquisition requires an exact HTTPS repository target matching the clone URL. Product identity guidance requires authoritative publisher/source links, project purpose and current/archive status before repository-specific analysis; ambiguity requests the exact repository or product URL. It distinguishes confirmed non-open-source status from inability to find verified public source and prohibits substituting older name matches or third-party wrappers. The Muse Spark regression refuses acquisition of `facebookresearch/MUSE` before external Git I/O, preserves the selected target and creates no findings. A prompt and acquisition guard do not independently prove the model's semantic discovery accuracy; controlled product-ambiguity qualification remains useful.

### #48 — Installed version/runtime diagnostics consistency
**Status: mostly implemented, qualification pending; P2.** Shared `VERSION` feeds `tui/runtime.ts:getRuntimeMetadata`, doctor, doctor screen and feedback metadata. Doctor keeps Node >=24 (`commands/doctor.ts:19–20`); runtime records Bun/Node/platform/arch. `tui/runtime.ts:24` calls any environment without `ZERO_DEV_SOURCE_ROOT` beta: assess direct source launches/local bundles so local build is not misrepresented as a published artifact. Missing: compare source, installed Node bundle and Bun executable versions/help/doctor/UI/feedback; validate metadata excludes workspace/transcript/secrets and machine-readable modes remain clean. Existing doctor tests are source evidence only.

### #52 — Plain-language coordinator overview
**Status: earlier implementation deliberately superseded on current main; acceptance needs reconciliation; P2.** `4f630909` added coordinator summary and tests. **Current main `2736deb2` removed `coordinator-summary.ts` and its tests**, saying “Remove generated coordinator prose and its obsolete formatter/tests.” Current `chat/AgentChatSwitcher.tsx` and layout helpers show original task/progress text, measured viewport navigation and per-worker context. Do not restore obsolete summary code automatically. Missing relative to open issue: stable completed/planned main-task count and overview with done/working/next/operator action, blocker and scope-growth proof. Determine whether current product direction replaces those requirements or needs a compact deterministic state summary without generated prose.

### #53 — Guided scan plans with shared caps
**Status: substantial implementation merged; real CLI acceptance pending; P2.** `tui/home-screen.tsx:79–180` collects target/goal/depth/runs/mode/time/cost, shows recommendations and requires second-enter confirmation. `tui/scan-plan.ts` provides three goals, defaults and editable options. `core/src/scan-plan.ts:109–199` dispatches runs with shared ledger, deadline/abort, bounded parallel concurrency and explicit partial failed/cancelled outcomes. Tests exist in CLI/core scan-plan files. Missing: actual guided CLI flow and sequential/parallel cap proof, user-visible accounting limitations, recommendation rationale explaining scope/goal, coverage/unfinished work when limits fire. Presets in code are choices, not proof caps are enforceable across every provider route.

### #54 — Task-specific multi-model orchestration
**Status: partial worker routing mechanics; product/evaluation requirements incomplete; P2.** `agent/tools.ts:2520,6671,6750` supports per-worker model selection; one-shot/persistent workers receive shared budget context and route identity. Current live agent events preserve route/model identity. Guided home plan shows runtime but no per-task recon/analysis/validation/report routing preview/override table. Missing: small explicit evaluated task-to-model policy, task-specific rationale, approved-route eligibility/fallback, planned override/single-model flow, cross-provider evidence/constraint preservation and actual multi-task CLI trace with aggregate usage. Do not call static routing or model availability “research-backed best model” evidence.

### #41 — Durable evolution campaign accounting/resume
**Status: merged reservation/settlement implementation; larger acceptance partial; P2 before unattended billing.** Issue's “PR #111 partial and unmerged” statement is stale: `f06d6504` integrates `safety.ts` campaign ledger into `rewrite.ts:146–168` proposal dispatch and `evaluation.ts:121–138` execution dispatch. Ledger stores reservations/unknown cost, owner PID, exposure and immutable comparison identity; `evolve reconcile` is exposed at `commands/evolve.ts:318`. `safety.test.ts` covers unknown-cost reload, pending reservation blocks and owner recovery. Remaining: actual worker-model spend is absent from duration-only evaluation metering; supervised finite pilot can precede full scheduler. `--watch` still repeats until stable; durable park/wake on approved revision and exhaustive kill/restart/competing-owner production proof are not established by this audit. Do not claim exactly-once external calls.

### #40 — Bound adaptive holdout reuse
**Status: finite controller mechanism merged; empirical/statistical qualification incomplete; P2 before expanded search.** `safety.ts:35–40` hashes lane/input/expected content independent of case IDs; `holdoutExposureIdentity` keys actual corpus/evaluator/semantics. `evaluation.ts:123–124` reserves exposure before each held-out baseline/candidate execution; `safety.ts:253–264` blocks exhaustion and changed limits. Tests cover relabel/reorder and persisted exhaustion. Remaining: declared policy for every canary/retention/disclosed decision, untouched final-set separation and family grouping, independently fresh operator rotation, overhead and seeded null-campaign analysis. Finite query bounds limit risk; they are not an adaptive statistical validity theorem.

### #38 — Provenance and incompatible comparisons
**Status: merged compatibility framework; important runtime provenance still incomplete; P2.** `safety.ts:13–28,43–73` records corpus/evaluator/provider/model/harness/tool/source identities and distinguishes compatible/incompatible/unknown. Generator post-dispatch identity/charges observed in `rewrite.ts`; registry promotion compares receipt identities. **Evaluation fallback `evaluation.ts:89–94` explicitly reuses generator observation**, so it does not establish actual evaluated-worker model identity. `safety.ts:51–53` fallback `sourceRevision=evaluatorDigest` and tool hash of canonical JSON function do not prove target source/tool-byte revision. Missing: actual evaluated-worker/provider/decoding identities, source/image/tool byte identities, revision-aware knowledge invalidation and end-to-end curated observation lineage; measure bounded receipt/hash overhead. Unknown provenance must remain unknown.

### #37 — Longitudinal capability retention
**Status: current paired baseline correctness gates; explicit longitudinal policy missing; P2 before model-backed qualification.** `improvement/evaluation.ts` evaluates configured corpus with stability, negative control and baseline preservation through `bench/improvement-promotion.ts`. No reviewed `retentionCohort`/versioned capability-profile policy in improvement types/config/evaluation. Missing: bounded critical workflow panel with provenance, per-capability retention/adaptation reporting, multi-generation aggregate-gain/critical-loss regression, insufficient sample/inconclusive handling, stochastic paired contract plus A/A and injected regression controls. Do not transplant exact-JSON repeat invariants into stochastic efficacy claims.

### #39 — Development-only archive search
**Status: bounded alternative parent implementation already present; experiment incomplete; P3.** `loop.ts:143–182` ranks eligible compatible prior candidates by development match fraction, verifies snapshots/receipts/config lineage, and is disabled when `maxAlternativeParents<=0`; actual proposal parent selected at `:254–255`, ancestry stored at `:283`. `rewrite.ts:119–130,204–211` exposes at most eight archive references and only current editable paths; held-out answers not offered. `alternative-parent.test.ts` exists. Missing: behavior-diversity descriptor and development-diverse stepping stones policy, fixed-budget paired comparison with current/uniform policy, retention/FP/uncertainty/cost qualification. No default expansion solely because branching exists.

### #119 — Reproducible research evidence/paper tables
**Status: unresolved offline evidence work; P2 before publication claims.** `packages/benchmark/results/benchmark-ledger.json:14–34` still simultaneously records aggregate retained black-box 81 and model-specific 93 with narrative cohort explanation; no audited immutable manifest/table generator found in reviewed paper paths. `docs/paper/evaluation.md` preserves historical tables; README warns not to overwrite them. Missing: receipt inventory with hashes/provenance/denominators, regenerated cohort-specific tables, reconcile subset/union inconsistency or suppress unsupported headline, weak-supervision and grouped-leakage classifier audit with trivial baseline, and claim-to-artifact implemented/proposed/measured distinction. The issue is explicit that a systems paper can proceed while efficacy claims remain preliminary/omitted.

### #120 — Model-backed evolution qualification with full cost/latency
**Status: not demonstrated; prerequisite finite experiment; P2.** `evaluation.ts:116,135–139` still computes cost from worker duration × compute rate; no worker model usage/charge in `EvolutionExecution` observed. Evaluator compares exact JSON expected outputs. Generator charges are handled separately. No reviewed reproducible baseline-vs-width-one security pilot artifact establishes measured generalization or optimization benefit. Missing: independently labelled vulnerable/fixed/clean one-workflow adapter, actual worker model metering/provenance, preregistered paired stochastic contract, A/A/regressing controls, total search/final-validation reserve, cost/latency/inconclusive reporting and opportunity-cost comparison. Keep explicit offline and disabled by default; do not start paid qualification without concrete cap/accounting readiness.

### #121 — Offline compact failure-summary experiment
**Status: intentionally conditional/unimplemented experiment; P3 after #120.** Existing development feedback and `miss-harvest.ts`/lens miss-capture are useful inputs, not an evaluated compact failure-summary arm. Missing: deterministic observed-outcome grouping with unknown causes, bounded receipt references/storage/token budget and reprocessing identity, no private held-out data, equal-budget width-one comparison including summarization cost. Negative/inconclusive documented result satisfies issue; no default model/tool/prompt additions.

### #122 — Proposal-diversity experiment
**Status: intentionally deferred; P3 after #120.** Current sequential attempts/history/alternative-parent selection already provide bounded search. No requirement to default width three. Missing: equal total spend comparison width one versus explicitly small width while holding parent/feedback/surface fixed, all rejected/inconclusive cost and complete independent validation reserve, quality/FP/retention/latency report. No automatic patch combination or default subagent fanout. Negative/inconclusive result retains simpler approach and can complete experiment.

## Qualification limits

- #52 current main intentionally moves away from the old summary implementation.
- #37–41 stale issue text understates merged safety code, but helper/dispatch tests do not supply empirical efficacy.
- Generator model provenance is not evaluated-worker model provenance; compute-duration estimates are not provider charges.
- Several requested issues require actual controlled CLI evidence or a finite research experiment, not only source changes.

## Validation evidence

The initial full core run passed 8,275 tests and exposed 11 pre-existing macOS temporary-path failures. Canonical temporary roots and memory-root expectations repair those fixtures; all 141 tests in the affected suites then passed, including malicious descendant-symlink rejection. Production path checks are unchanged.

Focused validation also passed the 210 console tests, repository-acquisition tests, Codex unit and real-renderer scenarios, shared Jev evaluator and ranking/specialist suites, complete assurance tests, frozen dependency installs, and relevant Python MCP/PoC and CLI MCP checks. These checks do not establish live-provider calibration, external runtime repair or research efficacy.

The reconciled public test command passed: 8,286 core tests, 3,369 CLI tests and 31 test-target tests, plus runtime-lock, skill bundle, public export, development-engine, MCP and documentation-pointer checks. The final workspace build/typecheck, 46 shared tests, 22 assurance-package tests and eight real-renderer scenarios also passed. Source and bundled version output both report 0.22.1; bundled doctor runs successfully with isolated credentials. Skipped tests remain skipped; no live paid model experiment or external filesystem-runtime qualification was performed.
