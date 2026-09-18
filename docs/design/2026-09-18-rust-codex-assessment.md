# 0sec, Rust, Codex, and Codex Security: source assessment

Date: 2026-09-18. This is a source-based architectural and competitive review,
not a measured detection comparison or an implementation approval.

## Recommendation

Extract explicit application and execution interfaces first. Keep the current
TypeScript engine behind them. Prototype Rust for the terminal frontend or one
execution backend, and expand only when measured behavior justifies it. AI makes
the port more affordable; it does not establish behavioral equivalence.

Codex Security is a serious competitor for repository security review. Its
workflow and artifact accounting appear more cohesive than 0sec's broad command
surface. 0sec has concrete specialist verification and execution capabilities
worth preserving. Neither source tree proves superior vulnerability discovery.

## Review scope and provenance

Three parallel specialist agents examined frontend architecture, execution and
containers, and engine/security workflows. Two additional review passes challenged
our differentiation and audited benchmark evidence. The coordinating review
checked selected findings against source, inspected distribution, and compared
current Codex code and official documentation.

- 0sec checkout: `9c5403d02fdf3b2ad697dddb7af72c2a2339630c`, with existing working-tree
  changes. Application sources were not changed by this review.
- Codex latest stable release returned by GitHub at review time:
  [rust-v0.155.0](https://github.com/openai/codex/releases/tag/rust-v0.155.0),
  published 2026-09-17; source commit `f0a1b8f0849d90960bc406b848f32e5a129b0457`.
- Codex main was also fetched at
  [`7498521d288b9b3b96ffba4eedf089d8d6e06a84`](https://github.com/openai/codex/tree/7498521d288b9b3b96ffba4eedf089d8d6e06a84).
  The application-client, TUI facade, and execution-server boundaries were checked
  there; this was not an exhaustive review of all changes since the release.
- Codex Security:
  [`70d5b2edae13992a73003bdc568c7b96117edb80`](https://github.com/openai/codex-security/tree/70d5b2edae13992a73003bdc568c7b96117edb80).
  Its checked-in SDK version is 0.1.28, depending on Codex/SDK 0.154.0. This does
  not assert that 0.1.28 is the latest published npm package.
- No live scans, paid inference, builds, performance measurements, or test-suite
  executions were performed. Implementation and test inspection are not passing
  runtime evidence. External repositories were cloned under `/tmp`.

## What we actually have

The CLI is not a thin parser: approximately 97,000 source lines, with roughly
66,000 in the TUI. Core is approximately 242,000 source lines. These approximate
counts exclude tests and include comments; they indicate scope, not quality or
porting time.

`packages/cli/src/tui/chat-screen.tsx` owns provider/runtime construction,
compaction, plugin and MCP hosts, session construction, approvals, and transcript
updates. Porting the renderer directly would also move application logic.

Useful extraction anchors already exist:

- `packages/cli/src/console-session.ts`: engine/session and database lifetime.
- `packages/cli/src/desktop/console-gateway.ts`: serialized session operations,
  decisions, cancellation, and events.
- `packages/shared/src/desktop-console.ts`: versioned frontend contracts.
- `packages/shared/src/presentation.ts`: presentation vocabulary.

The gateway is incomplete for full TUI parity. It retains 2,000 in-memory events;
model configuration, compaction, plugin/MCP setup, richer controls, and durable
resume require explicit coverage. Presentation events explicitly do not promise
cross-process replay or exactly-once delivery. We should consolidate these
contracts rather than create a third independent event system.

The database should remain engine-owned initially. `packages/db/src/database.ts`
documents that the WASM SQLite backend cannot use WAL. A Rust client must not
silently introduce a concurrent WAL writer.

Standalone distribution already exists through `scripts/bun-compile.sh`,
`.github/workflows/release.yml`, and `install.sh`. A Rust client plus a retained
JavaScript worker may improve frontend behavior but does not automatically reduce
total memory, remove the JavaScript runtime, or simplify installation.

## What to learn from Codex

Codex's useful design is two interfaces: frontend to application, and application
to execution environment. The Rust TUI uses Ratatui/Crossterm and a typed
application client. The application client supports embedded and remote modes;
Codex does not require a separate engine process in every configuration.
[TUI dependencies](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/tui/Cargo.toml),
[application client](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/app-server-client/src/lib.rs).

The session facade keeps request plumbing out of UI widgets. Its protocol covers
threads, turns, approvals, structured input, and resume. Shared types generate
cross-language schemas; the benefit is a stable contract, not merely using Rust.
[Session facade](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/tui/src/app_server_session.rs),
[schema export](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/app-server-protocol/src/export.rs),
[official App Server documentation](https://learn.chatgpt.com/docs/app-server).

Execution is a distinct process/filesystem interface with process IDs, streaming,
termination, and lifecycle semantics. This is relevant to our local/container/VM
backends. It is not a replacement for their workload-specific isolation policies.
[Execution server](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/exec-server/README.md).

One immediate integration gap: `packages/core/src/runtime/cli-native.ts` rejects
non-Claude native multi-turn CLI execution and cites missing stable Codex resume
semantics. That rationale is outdated relative to current App Server. This is a
specific adapter gap, not a claim that all 0sec Codex/OpenAI support is absent.

## Container implications

Our Dockerfile separates a tooling-only image from the full scanner. Node,
Python, scanners, identity tools, and other guest dependencies remain necessary
for existing workflows regardless of the host CLI language.

0sec does not have one universal sandbox today. Ordinary Bash execution, generated
plugins, npm detector subprocesses, replay, Docker, QEMU, and smolvm have different
contracts. In particular, a separate Node subprocess is not OS isolation.

`packages/core/src/improvement/sandbox.ts` and `runtime/smolvm.ts` implement image
identity, mounts, environment filtering, limits, cancellation, and teardown
behavior. smolvm additionally requires qualified nonroot Linux/KVM/setpriv and a
pinned runtime. Rust ownership can help implement these responsibilities but does
not replace OS enforcement or prove cleanup works.

Codex Security's scanner Compose setup runs a nonroot container with dropped
capabilities and no Docker socket or KVM requirement. It accommodates Codex's
inner sandbox. Its default container is a narrower source-review environment,
not a substitute for our VM verification workloads.
[Compose](https://github.com/openai/codex-security/blob/70d5b2edae13992a73003bdc568c7b96117edb80/compose.yaml),
[container documentation](https://github.com/openai/codex-security/blob/70d5b2edae13992a73003bdc568c7b96117edb80/docker/README.md).

## Competitive assessment

| Task or property | Assessment from inspected source |
|---|---|
| Repository audit workflow | Codex Security appears more focused and cohesive; detection superiority is unmeasured. |
| Parallel finding reconciliation | Codex Security checks source attribution, completeness, duplicate references, and unaccounted findings. Strong design reference. |
| Live targets, binary/kernel/VM workflows | 0sec has broader dedicated implementations; evaluate each separately rather than infer quality from breadth. |
| Behavioral repair | 0sec has a particularly concrete frozen-probe replay path, but stricter workflow prerequisites and editing restrictions. |
| Providers, PoCs, resume, deep scans, patching | Substantial overlap; these are not exclusive differentiators. |
| Overall accuracy, reliability, or cost | No matched comparison established by this review. |

Codex Security is a TypeScript SDK/CLI over Codex, with React/Ink and selective
Rust OS bindings. It is not an all-Rust security product. The native layer fills
OS API gaps while TypeScript retains orchestration and policy.
[Package](https://github.com/openai/codex-security/blob/70d5b2edae13992a73003bdc568c7b96117edb80/sdk/typescript/package.json),
[native primitives](https://github.com/openai/codex-security/blob/70d5b2edae13992a73003bdc568c7b96117edb80/plugins/codex-security/native/README.md).

Its deep-scan reducer rejects unknown, duplicate, or missing source-finding
attributions. Custom validation rejects omitted candidates. These checks preserve
accounting; they do not independently prove a model's vulnerability claim.
[Artifact validation](https://github.com/openai/codex-security/blob/70d5b2edae13992a73003bdc568c7b96117edb80/plugins/codex-security/mcp-app/src/deep-scan/artifact-validation.ts),
[custom validation](https://github.com/openai/codex-security/blob/70d5b2edae13992a73003bdc568c7b96117edb80/sdk/typescript/src/custom-validation.ts).

It supports alternative providers, including OpenRouter and Fireworks; claiming
that 0sec alone is multi-provider would be incorrect.
[Provider configuration](https://github.com/openai/codex-security/blob/70d5b2edae13992a73003bdc568c7b96117edb80/sdk/typescript/src/config.ts).

Concrete 0sec strengths:

- `packages/core/src/verify/kernel-verify.ts`: confirmation requires matching the
  expected oracle signature; a generic crash is a soft hit, not confirmation.
- `packages/core/src/secure/behavioral-repair.ts`: clean baseline tests, frozen
  executable probe, legitimate-use controls, and fresh patched-checkout replay.
  The probe is generated, so its validity still needs independent evaluation.
- `packages/core/src/agent/tools/0verse.ts`: explicit subprocess/version contract
  and preservation of confirmed-versus-hypothesis distinctions.

Do not equate specialist command count with validated capability count.
`review-harness-tier2.ts` generates harness artifacts rather than compiling or
executing them. Some profiles are domain instructions and some detectors are
heuristics. Our behavioral repair path also restricts changes to tests/config
and requires an explicit working baseline; that can trade developer flexibility
for a tighter verification path.

## Benchmark issue requiring correction before superiority claims

`docs/src/content/docs/benchmark.md:13` describes 93/95 XBOW as black-box and
single-shot, explicitly not a best-of-N union. However,
`packages/benchmark/src/scripts/consolidate-xbow.ts:203` defines per-model solves
as any historical successful result, and its call at line 268 does not pass
black-box/white-box mode. Separate global mode maps do not fix the per-model
cohort. This aggregation cannot substantiate the stronger published description.

This review did not retrieve all historical CI artifacts or establish how every
ledger number was produced. The finding is a mismatch between the documented
claim and the checked-in aggregation semantics, not proof the underlying solves
are fabricated. Existing retained and historical results also have different
dates/cohorts. They do not establish superiority over Codex Security.

The Cybench ledger's phrase "single-shot, 3 retries" also needs clarification:
`packages/benchmark/src/cybench-runner.ts` implements retries as additional
attempts. Report the actual attempt budget. Our older triage ablations in
`docs/paper/evaluation.md` also show workload-dependent tradeoffs, including a
worse npm false-positive rate for the named moat configuration than for none.
Those historical observations are not current head-to-head results.

Codex Security's inspected SastBench evaluation is explicitly supplied-alert
triage, not vulnerability discovery. Its label and abstention accounting are
useful references, but cannot be compared directly with our CTF solve rates.
[SastBench evaluation](https://github.com/openai/codex-security/blob/70d5b2edae13992a73003bdc568c7b96117edb80/plugins/codex-security/skills/triage-finding/evals/sastbench/README.md).

## Proposed next steps

1. Correct benchmark cohort/mode/attempt semantics and retain auditable per-run
   records before repeating competitive accuracy claims.
2. Run a shared repository-audit benchmark: frozen vulnerable/fixed pairs and
   clean controls; identical allowed information, comparable model settings,
   equal total budgets across all agents, repeated independent attempts, and
   blinded adjudication. Record precision, known-issue recall, reproductions,
   patch regressions, cost, duration, and infrastructure failures. Evaluate
   specialist workloads separately. This review has not launched these runs.
   A useful pilot is 20 vulnerability families with vulnerable/fixed pairs plus
   10 safe near-misses, three attempts each per product. Keep families disjoint
   between development and holdout; report per-attempt results separately from
   pass@k. This is a proposed experimental design, not a cost estimate.
3. Move session ownership out of React behind a versioned client interface.
   First make the existing TUI consume it. Keep storage, providers, and policy
   authoritative in the engine; define approval IDs, cancellation, reconnect,
   event gaps, and protocol compatibility explicitly.
4. Build one complete Rust client path: launch/connect, chat, streamed tool
   output, approval, cancel, resume, and shutdown. Alternatively prototype one
   execution backend if process reliability is the primary objective.
5. Compare complete-product startup, RSS, rendering, install size, and lifecycle
   failures. Expand the Rust scope only after an observable benefit and parity.

AI can parallelize implementation across stable interfaces and automate
comparative testing. Use the existing implementation as one behavioral reference,
plus independently specified invariants so existing bugs are not blindly copied.
Do not run duplicate side-effecting operations against real targets for comparison;
use fixtures and isolated test environments. A full Rust engine remains an option,
but the current evidence does not justify making it the first investment.
