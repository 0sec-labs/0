# Native local-source workflow

Status: implementation in progress, not legacy `review`/`verify`/`fix` parity.

The first workflow accepts an explicitly pinned local snapshot and selected text
files. The model sees a bounded retained bundle and returns structured hypotheses
with file/hash/line citations. Citation validation establishes source attribution;
it does not establish that a vulnerability exists. The first discovery result is
always unverified, including when the model claims certainty.

## Legacy behavior to preserve or replace deliberately

The reachable `packages/cli/src/commands/review.ts` routes ordinary review through
the unified pipeline and deep review through lenses. The standalone core review
module is not the sole behavior reference. The unified source verification path
can infer confirmation from a second agent returning findings. Native behavioral
reproduction must require an observed independent test, not inherit that label.

`packages/core/src/fix/source-fix.ts` restricts a candidate to one source file,
checks source predicates, and runs an operator regression command on the host.
Its apply path rechecks predicates but returns the isolated candidate's earlier
regression result. Native repair should retain the single-file/preimage bound,
execute the command in the selected sandbox, and validate a freshly reconstructed
candidate before producing a plan-qualified repair receipt.

`secure/behavioral-repair.ts` and `verify/reproduction-bundle.ts` supply stronger
references: frozen probes, controls, protected test/policy files, exact hashes,
and replay on both vulnerable and patched versions. A generated probe's own
`safe` or `vulnerable` JSON remains untrusted data; its execution alone does not
make its verdict authoritative. Native host oracles must evaluate observable
outputs under an explicit frozen contract. Top-level reproduction is part of
`verify`; there is no general standalone legacy `reproduce` command to copy.

## Implementation sequence

1. Retain an immutable selected-source bundle, exact provider request and reply,
   and validated unverified hypotheses. Bind the operation to their hashes.
   Reject invented citations, changed bytes, malformed/multiple submissions,
   unsupported files and resource-limit violations before claiming a result.
2. Accept an explicit host-owned reproduction plan separately from model output:
   source hash, fixed backend/image, argv/stdin, limits, attack cases, legitimate
   controls, expected observations and oracle version. Models may propose plans,
   but cannot grant their own execution authority or change the oracle.
3. Record each observed execution and distinguish reproduced, not reproduced,
   inconclusive, cancelled and unknown. Setup errors, truncated output and
   unconfirmed cleanup never become successful negatives.
4. Accept one bounded candidate replacement for an allowlisted existing source
   file and exact preimage hash. Apply only to a private copy. Protect oracle,
   test and policy files. Preserve candidate bytes as an immutable artifact.
5. Require the baseline attack and control, candidate checks and a fresh candidate
   reconstruction to satisfy the same frozen plan. Report
   `validated_candidate_for_plan` with that plan's identity; do not generalize it
   to an unrestricted fixed-security claim.
6. Export validated review provenance through `source-report` in native JSON,
   Markdown or HTML. Explicit reproduction/repair links revalidate retained
   matrices and candidate provenance without executing again. Hypotheses stay
   unverified; legacy finding/SARIF semantics remain separate work.
   Host application, Git changes and publishing are subsequent capabilities.

The initial oracle can observe command exit/stdout/stderr from existing local
images. Filesystem-effect proofs require a separate bounded artifact-export API
before sandbox cleanup; that capability is not present merely because output
contains an attacker-provided success message.

The native journal's immutable artifact attachments provide source/plan/evidence
retention independently of mutable project files. Effects must remain owned by
the engine: durable admission before provider/backend work, child reservations,
cancellation settlement, exact retry without another effect, and Unknown rather
than replay after an interrupted owner. An artifact or hypothesis is not itself
an execution permit or evidence disposition.

Acceptance includes a vulnerable fixture and legitimate control, a valid repair,
spoofed model verdicts, citation/preimage/oracle drift, protected-file edits,
setup failure, truncated output, cleanup uncertainty, cancellation, and restart
with exact retry. Live-provider qualification and scanner detection quality are
separate from these deterministic contract fixtures.

## Direct local review: authority and preparation

The next product workflow is `review <local-path> --profile <name>`. This command
is not wired yet. Its first prerequisites now exist:

- `zero_protocol::review::ReviewProfile` compiles one host-captured snapshot into
  the existing adaptive source actor. It captures provider/model, instructions,
  question, total budget/currency, per-turn reservation, turn/hypothesis limits,
  deadline, context policy and optional bounded delegation roles. Source reads,
  searches, experiments and stopping remain agent choices. Only the root can
  submit hypotheses; neither a delegate nor a submission verifies a claim.
- Its explicit offline execution profile requires an immutable Docker image
  digest or smolvm archive path/hash and resource limits. It does not include a
  source path, credentials, mounts, network authority, startup/build command or
  plugins. Compilation supplies the captured manifest. The actor replaces the
  inert argv template only when it chooses an authorized execution tool call.
  Selecting execution authority does not force execution.
- `zero_executor::pin_snapshot_checked` bounds capture to a selected positive
  file/byte limit, with supported ceilings of 4,096 files and 64 MiB, and checks
  cancellation throughout traversal, content reads/hashing and manifest
  completion. It preserves the existing anchored no-follow capture and manifest
  identity. It rejects oversize input instead of silently trimming the tree.
  Directories do not count as files; a caller must supply a preparation deadline.
  Blocking filesystem calls require a blocking worker and cannot be preempted by
  a callback. No `.git`/dependency exclusions are implied by this API.

Storage now has `ReviewAdmission`, immutable `ReviewRecord` and read-only
`ReviewSnapshot` support (native schema 18). Admission creates the session,
controller, actual root, captured intent artifact and journal binding in one
transaction. It binds the original path, manifest, named profile, provider rates,
budget and absolute deadline. Exact retries return the original graph before
consulting changed profile/source values; changed original path/profile names
conflict. Cancellation persists a stop witness without claiming that running work
has finished. Epoch recovery marks the owned controller/root Unknown.

Generic effects, new reservations, queue/steering/reconciliation, questions,
approvals and HTTP access are currently closed for these sessions. This is an
internal storage milestone, not a runnable review: the dedicated controller must
replace the closed effect gate with exact source/inference/delegation/sandbox
checks before exposing the command. Status reads validate projection/journal
bindings, immutable intent and lifecycle witnesses, admission closure and the
funding ledger. Deleting the review projection cannot reopen a generic session.
Read-only opening never migrates old state; writable opening validates the prior
schema before the additive migration. Existing portable campaign/scan evidence
cannot silently omit review membership.

The controller and command remain required work. Resolve an exact retained retry
before reading current configuration or the source path. For a new command,
perform bounded cancellable local capture before admission, with no model/backend
work. Drain its blocking worker on cancellation. Atomically admit a dedicated
review session, controller, actual root and frozen intent/provider rates; start
the durable deadline at that admission. Cap serialized intent/catalog size as
well as file contents. Do not label preflight hashing as an admitted actor.

Use `prepare_actor` and `run_actor` directly under the dedicated controller.
Review-specific Store fences must cover inference, delegated roles and sandbox
requests, including source/backend/resource identity, cancellation, deadline and
shared funding. Do not overload the HTTP scan record or recursively invoke the
public `RunAgent` command. Reuse worker ownership and cleanup handling so owner
loss produces Unknown and exact retries never repeat effects.

Compose reports from one pinned Store read snapshot, reusing retained source
provenance. A partial run without a terminal submission must not be turned into
an empty successful review. Preserve charged/reserved funding and cleanup
uncertainty independently of hypothesis counts. The command acceptance still
requires a real loopback-provider fixture exercising search/read, cited
submission, unchanged source, cancellation, owner loss, config-free retry and
reporting after source deletion.
