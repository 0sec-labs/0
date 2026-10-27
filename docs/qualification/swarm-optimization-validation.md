# Swarm and optimization validation — 2026-10-28

This review tests the existing engine against `d69b6124`, then validates the
runtime fixes below together. Deterministic runtimes and fixture processes prove
orchestration and accounting behavior; they do not prove that a model chooses
useful subtasks or that more agents/proposals improve security outcomes.
No provider model generation or customer-target assessment ran in this review.

## Supported coordination

| Capability | Observed contract |
| --- | --- |
| Concurrent workers | `spawn_agents` executes a bounded pool and returns each child's results. |
| Nested workers | Supported when the inherited role/tool set permits spawning; maximum depth is eight. |
| Scope and tools | Children retain target/workspace authority and permitted built-ins. Connected MCP/deferred tools and parent extensions are not automatically delegated. |
| Messages | Child-to-parent delivery and configured sibling discovery/handoffs exist. Peer/operator channels depend on settings and a wired messaging runtime. |
| Persistent workers | Initial work runs in the background, then parks. Enabled messaging routes/operator controls can revive it; execution state is not resurrected after an engine restart. |
| Coordinator steering | The default model catalog does not advertise a parent `send_message` tool. The operator API/UI can steer workers when enabled; descriptions now reflect that limit. |
| Lifecycle and UI | Result collection, progress, launch-turn attribution, subtree cancellation and stop-all are covered. |
| Remote engines | `0 worker deploy` registers another engine/backend. `spawn_agents` is not an automatic cross-host scheduler. |

Defaults are **1,024 tasks per batch**, **32 executing children per batch**, and
**4,096 admitted queued/live/parked workers per audit**. There is no shared global
LLM HTTP semaphore at 32. A normal model response's separate `spawn_agents` calls
serialize as stateful tools; independent or nested pools can overlap. The
three-pool fixture permits 96 simultaneous mock workers. These are capacity
controls, not evidence that a large team is useful or inexpensive.

Shared scan ledger updates retain concurrent charges and deduplicate observations
of the same response. Estimated spend is checked around requests; already
in-flight requests can overshoot a stopping threshold. Messages grant no new
scope, credentials, approvals or tool authority. Shared workspace writes still
need disjoint ownership and coordinated handoffs between agents.

## Two runtime defects corrected

### File-content I/O

The scheduler grouped local read promises, but `read_file` and `search_files`
performed synchronous content reads. Scheduling mocks alone did not demonstrate
actual I/O overlap.

The fix resolves and opens an authorized descriptor without yielding, then reads
that selected inode asynchronously. Directory metadata/traversal and `list_files`
remain synchronous. This preserves the original guarded critical section rather
than introducing an asynchronous path-resolution race. Search reads at most
256 KiB plus one sentinel byte, so growth after the size check cannot bypass its
cap. `read_file` retains its existing full-file/window contract.

Real-handler barriers verify four overlapping content reads, source-ordered
receipts and a mutation held behind all preceding reads. File and ancestor
symlink replacement, cancellation, descriptor cleanup and file-growth controls
pass. The original synchronous handlers fail the overlap control. A naive
path-based asynchronous implementation fails all four scope-swap controls.
Independent review also exposed a whole-root replacement between search reads.
Search now pins the original canonical root and device/inode identity, validating
it before opening and after awaiting each file. Root symlink replacement,
above-root replacement and same-path directory recreation fail the entire search
without returning outside content; all three regressions fail before this guard.
This closes the JavaScript-yield window, not external-process races between path
validation and opening. Descriptors pin inodes, not immutable file contents.
No representative throughput or speedup claim is made from these barriers.

### Chat worker usage

Scan workflow ledgers already shared charges, but chat usage callbacks omitted
spawned child inference. A nested fixture using **90 input / 9 output tokens**
reported only its parent's **20 / 2** before the fix.

Console sessions now observe child and grandchild requests once, prefer returned
per-model usage over streamed duplicates, preserve cache fields and price each
worker by its own identity. Unknown usage or worker identity keeps cost
unavailable rather than borrowing the parent's model price. Child context sizes
do not replace the main conversation's context-window occupancy.

The active parent token allowance admits no further worker requests once spent;
already-dispatched requests may overshoot. Persistent workers can finish after a
turn and report through the current session observer without mutating a completed
outcome. Retirement suppresses obsolete callbacks, so late provider charges after
retirement may remain unreconciled. This adds neither a shared chat USD ledger nor
a hard billing cap. Displayed costs remain token-price estimates, not invoices.

## Optimization checks

Fresh control outputs reused the previously integrity-verified 15-case source
corpus unchanged. This review introduces no new semantic corpus qualification.

| Path | Fresh executed control | Result and interpretation |
| --- | --- | --- |
| Basic pilot | 132 deterministic dispatches; unknown usage on the first dispatch | Regression detected; unknown usage stops; conclusion remains inconclusive. |
| Feedback summaries | 132 deterministic dispatches per arm; unknown-usage control | Current feedback retained; the second arm is not constructed after accounting uncertainty. Equal fixture output says nothing about model benefit. |
| Archive parents | 12 paired fixture trials in each null/regression run across current, uniform and development-diversity selection | Default retained; the regression control exposes false-positive/retention failures despite attractive aggregate synthetic gains. |
| Proposal width | Eight null fixture trials comparing width one/three; unknown-usage control | Width one retained; unknown usage stops further dispatch. The study uses concurrency one, separating width from parallel execution. |
| Campaigns | Real deterministic fixture-process interruption/recovery and competing-owner tests | No blind replay after uncertain charges. Actual external-provider/VM crash reconciliation remains unqualified. |

The optimization review passed **236 tests**: 217 core improvement/pilot tests,
14 script-controller tests and five `evolve` CLI tests. **Eleven Linux-only tests
in two files were skipped on macOS**. Fixture charges and test-clock timings are
not real invoices or deployed latency. No artifact was promoted and no default
was expanded. Keep #120 as the finite value decision; #54 separately tracks
working-provider CLI routing.

The integrated fixes passed **530 core tests**, **60 gateway tests**, three
dashboard state checks, seven additional worker-stop checks, the production
build and workspace typecheck. A subsequent focused run passed 264 tests,
including all three new root-identity regressions. Counts describe their
respective test groups and are not a claim of disjoint coverage.

## Proposed live smoke, not approved or executed

The smallest existing source-review smoke has one repeat over the 15-case public
corpus: at most **67 logical dispatches**, **$6.70 declared reservations**, a
proposed **$7 approval cap**, and a **15-minute outer deadline**. Set retries and
fallback off; interrupted/unknown charges remain indeterminate and are not
replayed. Logical dispatches are not a promise about HTTP attempts under default
retry settings. Provider listing was checked read-only; successful generation,
quota and reconciled billing were not established.

Its pinned `gpt-4.1-mini-2025-04-14` snapshot is deprecated, with an announced
January 14, 2027 shutdown in the [official OpenAI schedule](https://developers.openai.com/api/docs/deprecations).
The [model page](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
currently lists $0.40 input, $0.10 cached input and $1.60 output per million tokens.
Recheck account access and rates before any approved run; changing the model
requires a new comparison contract.

Even a funded run of this smoke cannot qualify the wider studies: the narrow
pilot always reports inconclusive, has only three final family groups (two
package families and one structural clean group), and uses literal-sink agreement
rather than independent vulnerability proof.
Summary and wider-proposal gates were not bypassed or supplied invented parent
evidence. A meaningful value comparison first needs independently adjudicated
cases, a reviewed objective/margins, comparable identities, complete costs and an
untouched final panel. A capped negative or inconclusive decision remains valid.

For a future swarm-value comparison, hold the task panel, scope and total budget
fixed between a single-agent baseline and a small independently assigned team.
Measure verified outcomes, evidence coverage, duplicate work, handoff failures,
wall time and all usage. Orchestration tests alone cannot select a winning team
size or justify unrestricted fan-out.
