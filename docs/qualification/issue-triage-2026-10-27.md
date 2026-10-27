# Issue backlog review — 2026-10-27

Reviewed all ten open issues against `a2cbe33ca4bb998f49f0ad5357d51307da5d8895`
and the merged implementation PRs. The useful next decisions are **#120: does
one finite evolution workflow justify its full cost?** and **#54: can the existing
CLI routing complete a real approved-provider workflow?** No additional runtime
architecture was justified by this review.

Closing a tracker below does not establish model efficacy, generalization,
mathematical adaptive validity or live-provider recovery. Unmet empirical
requirements are preserved in #120/#54 or explicitly deferred.

| Issue | Disposition | Evidence and remaining limit |
| --- | --- | --- |
| #37 retention | Engineering complete; qualification consolidated into #120 | Versioned critical panels, continuity, rotation and regression/insufficient-evidence gates are implemented in #201. Stochastic retention/adaptation and independent-final outcomes remain unqualified. |
| #38 provenance | Engineering complete; qualification consolidated into #120 | #194 binds source/tool/evaluator bytes, actual worker identity/decoding and curated lineage; stale source memory is invalidated. One genuinely pinned workflow and reconciled actual charges remain unqualified. |
| #39 archive search | Deferred/not planned; conditional hypothesis retained in #120 | #199 implements the bounded current/uniform/development-diversity controller. No equal-total-budget model-backed archive benefit was measured. Reconsider only after a useful basic pilot and a parent-selection bottleneck. |
| #40 holdout reuse | Engineering complete; qualification consolidated into #120 | #193 enforces durable shared content-keyed exposure limits across copies, renaming and restarts. Exposure counting and synthetic controls do not prove generalization or adaptive validity. |
| #41 durable campaigns | Remaining scope deferred/consolidated into #120 | #197 implements pass-owned reservation, settlement, process recovery and unknown-charge no-replay. Actual CLI/VM/provider crash-and-charge qualification is required before unattended use; scheduling and feedback wakeups remain deferred. |
| #54 task routing | Keep, narrowed to working-provider CLI qualification | #196 implements opt-in assignments, overrides, protocol restrictions and shared accounting. Mock CLI controls pass; the retained 24 genuine local requests were protocol-inconclusive. No general model ranking or web-editor expansion is justified. |
| #120 evolution pilot | Keep, narrowed to one finite product go/no-go | #195 and existing safeguards provide opt-in controller infrastructure. Independently adjudicated cases, a pinned workflow, complete costs/latency and independent final outcomes remain unqualified. A capped negative or inconclusive decision is a valid stopping outcome. |
| #121 feedback summaries | Deferred/not planned; conditional hypothesis retained in #120 | #198 implements the bounded opt-in controller and rejects inconclusive parent qualification. Deterministic controls establish no model-backed benefit or absence of benefit. |
| #122 proposal width | Deferred/not planned; conditional hypothesis retained in #120 | #200 implements same-parent bounded comparisons and accounting gates. No model-backed wider-search benefit was measured; width one remains the default. |
| #166 live milestones | Supported UI scope complete | #202 and follow-up effect-based checks cover host-verified read/write, cleanup lifecycle, replay/deduplication and sanitized evidence views. RCE/shell/foothold/lateral-movement evidence producers remain absent and deferred. |

## Verification performed

No paid model requests or customer-target assessments ran during this review.

- **179 tests across 12 suites** cover retention, provenance, byte identity,
  shared exposure, registry/evaluation policy, feedback privacy, source-memory
  invalidation and unchanged ordinary-scan work.
- **110 tests across 9 suites** cover archive selection, campaign accounting,
  actual subprocess interruption, competing owners and unknown-charge recovery.
- **23 routing/runtime/scan-plan tests** pass. The actual built CLI fixture
  executes **64 mock calls across 32 trials**, including an intentionally failing
  model control. Fixture catalog estimates are not invoices.
- **43 milestone tests** pass for host-owned proof production, cleanup,
  transport, replay and sanitization. The dashboard regression script also passes
  **8 checks**, including the milestone browser-safe import/render check.

Representative evidence and reproduction contracts:

- [Retention and archive policy](retention-archive-study.md)
- [Shared holdout authority](evolution/holdout-authority.md)
- [Campaign recovery](evolution/campaign-recovery.md)
- [Archive study](archive-search-study.md)
- [CLI routing](guided-task-routing.md) and [qualification observations](task-routing/README.md)
- [Access milestones](access-milestones.md)
- [Basic source-review controller](security-evolution-study/README.md)

## Scope of the two retained issues

#120 carries the combined empirical requirements for the existing engineering
safeguards, rather than duplicating them across five implementation trackers. The
first study stays supervised and finite. Actual external-call crash/reconciliation
qualification precedes unattended operation. Archive selection, compact feedback
and wider proposals are separate, optional comparisons; none is a mandatory next
phase if the basic workflow has no demonstrated value.

#54 tests a distinct CLI workflow and stays separate from evolution. Begin with
one approved working provider, explicit accessible models and a controlled route
and tool-handoff trace. Protocol plumbing is not evidence that a model is best.

Neither issue authorizes paid execution by itself. A concrete approved plan and
cap are still required. No experiment automatically promotes code, changes scan
prompts, expands worker fan-out or enables a default policy.
