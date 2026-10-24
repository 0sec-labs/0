# Open issue implementation status — 2026-10-23

This integration reviews every issue and PR open at the start of the session. Implementation and deterministic regression coverage do not substitute for research outcomes or live-provider qualification. Defaults remain conservative where the issue requires evidence before enablement.

| Item | Implementation disposition | Remaining acceptance |
| --- | --- | --- |
| PR #181 | Merged; cleanup additionally covers setup, canonicalization and report-write failures | Full approved SmolVM fixture/live-provider qualification requires unavailable runtime assets |
| #183 custom providers | Completed: custom HTTP/HTTPS endpoint, arbitrary model, API key and catalog fallback through the existing OpenAI connection | No paid gateway call performed |
| #163 Cline | Existing ClinePass provider verified against its official external API contract and regression suites | No live paid-account call performed |
| #53 guided scan | Completed direct terminal planning, fixed supplied scope, editable goals/depth/runs and shared limits | Cost remains an estimated stopping threshold; an in-flight request may overshoot |
| #146 worker target identity | Completed typed absolute path/full pinned revision/origin checks before fork and before worker inference | Prose alone does not supply a machine-enforced pin; callers use `expected_workspace` |
| #147 YOLO verification | Existing end-to-end bounded PoC workflow verified with deterministic execution and blocker regressions | Tests establish plumbing and policy, not universal stochastic model compliance |
| #51 repository selection | Existing exact repository acquisition guard verified, including Muse Spark versus legacy MUSE regression | None for the deterministic acquisition guard |
| #166 milestones | Confirmed operator-fixture read and blocked-read banners added; conditional writes retained, evidence links/deduplication/escalation tested | Broader RCE/shell/foothold/lateral-movement and verified mutation-cleanup contracts remain open; these are never inferred |
| #54 task models | Explicit role assignments, single-model override, resolved-model traces and shared accounting tested with protocol fixtures | Representative model-quality and real multi-task provider qualification remain open |
| #37 retention | Versioned critical capability panel and promotion gate implemented and tested | Preregistered stochastic retention/false-positive qualification and measured overhead remain open |
| #38 provenance | Actual bounded source-byte identity and distinct evaluated worker provenance/accounting implemented | Provider-reported names are not immutable model versions; pinned runtime qualification remains open |
| #39 archive experiment | Bounded development-only current/uniform/diversity study policies implemented; production defaults unchanged | Repeated paired equal-budget study and independent final outcomes remain open |
| #40 holdout exposure | Same-store content-identity exposure and bounded accounting tested | A new/copied store can reset exposure; statistical null studies and measured overhead remain open |
| #41 durable campaigns | Existing persistence hardened with bounded ledger validation, worker-model reservation/settlement and fail-closed unknown usage | Actual provider kill/restart/concurrency and overhead qualification remain open |
| #120 qualification | Offline preflight, complete spend/unknown-charge records, controls and independent-final reserve implemented | Actual curated model-backed preregistered pilot remains open |
| #121 summaries | Bounded development-only observed-failure summaries implemented, including real setup-error classification | Equal-total-spend summary ablation is gated on the qualified sequential pilot |
| #122 diversity | Bounded same-parent proposal screening/shortlisting implemented | Equal-total-spend width comparison is gated on the qualified sequential pilot |

See [guided task routing](guided-task-routing.md), [access milestones](access-milestones.md), [retention/archive study](retention-archive-study.md), and [offline study protocol](../design/security-evolution-offline-studies.md) for contracts and limitations. No measured research benefit or paid execution is claimed.
