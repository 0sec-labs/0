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

The native CLI provides `review <local-path> --profile <name>`, backed by a
dedicated owned controller and the existing adaptive source actor:

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
`ReviewSnapshot` support (introduced in schema 18; current schema 19). Admission
creates the session,
controller, actual root, captured intent artifact and journal binding in one
transaction. It binds the original path, manifest, named profile, provider rates,
budget and absolute deadline. Exact retries return the original graph before
consulting changed profile/source values; changed original path/profile names
conflict. Cancellation persists a stop witness without claiming that running work
has finished. Epoch recovery marks the owned controller/root Unknown.

Review effects now require an exact captured actor and original completed model
call. Inference retains its model/tool template, provider rates and per-turn
reservation; bounded joined actors inherit only their selected role tools. Source
and sandbox operations must match the original call, manifest and execution
limits. Separate one-use journal permissions gate source preparation, source
reads and physical sandbox dispatch while the original owner, open controller
and deadline remain valid. The review source path admits before reading and
settles rejected/cancelled reads after draining the blocking worker. Generic
roots, external queue/steering/reconciliation, questions, approvals and HTTP
access remain closed. Budget denials retain the requested/charged/held amounts;
only a denied root inference is linked as the root's terminal budget cause.
Generic cancellation, shutdown and abnormal worker cleanup persist the review
stop before draining its work. Existing standalone source actors preserve their
historical failed-tool behavior.

Status reads validate projection/journal bindings, immutable intent and lifecycle
witnesses, admission closure and the funding ledger. Deleting the review
projection cannot reopen a generic session. Read-only opening never migrates old
state; writable opening validates the prior schema before the additive migration.
Existing portable campaign/scan evidence cannot silently omit review membership.

The CLI resolves exact retained retries before reading current configuration or
the source path. A fresh command performs bounded cancellable local capture
before opening the engine, with a preparation deadline of the smaller of the
profile deadline and 60 seconds. It verifies and copies the captured tree into a private preflight directory,
then reanchors the same manifest to that copy. This prevents a state database
inside the requested directory from invalidating the investigation when the
engine opens. The original caller path remains the retry identity; the captured
canonical root identifies the private copy. No files are silently excluded.
It drains the blocking capture worker on a signal or timeout. Admission then starts the separate durable investigation
deadline and freezes intent, manifest, provider identity and rates. Source capture
is preflight, not an admitted model operation. The actor independently verifies
and stages the captured source before its first inference. The frontend keeps
its private copy until the owned controller drains, then removes it; the copy
is never mounted into a guest. A process killed without cleanup may leave that
private temporary directory, as with other native staged snapshots.

The controller calls `prepare_actor` and `run_actor` directly. Worker ownership,
durable stop records and cleanup cover cancellation, deadline, shutdown and
owner loss. Controller success records that its owned actor lifecycle drained;
actor status, unresolved budget holds and security conclusions remain separate.
Exact retries never replay effects, including after owner recovery.

`review show` and `review report` accept either `--review <id>` or
`--command-id <original-command-id>`. They need only the state database, including
while the owning process is running. Reports compose from one bounded, pinned
Store snapshot, retaining source provenance after the original directory and
configuration are removed. A partial run without a terminal structured submission
has no source report; it is never presented as an empty successful review.
Hypotheses remain model claims, and the report's security conclusion remains
`not_established`. A controller recovered as Unknown does not erase an authentic
completed actor submission; its separate lifecycle uncertainty remains visible.

Fresh runs require `--review-profiles <json>` with a strict object mapping profile
names to `ReviewProfile` values, and configured providers or a hosted model. The
execution profile must select an immutable Docker image or hashed smolvm archive,
even if the agent chooses only source inspection. Provider credentials stay in
the separate provider configuration. HTTP, scan, harness and strategy runtime
configuration are rejected for this local workflow.

```sh
0sec-native --state review.db --providers providers.json \
  --review-profiles review-profiles.json \
  review ./selected-source --profile local --command-id source-review-1
0sec-native --state review.db review show --command-id source-review-1
0sec-native --state review.db review report --command-id source-review-1 --format html
```

A completed review exits 0, or 1 when submitted hypotheses claim High/Critical
severity. Exit 1 does not independently verify those claims. Incomplete, failed,
deadline-expired or uncertain results exit 2; a received interrupt/termination
exits 130/143 after owned work drains. Read-only inspection exits 0 on a valid
read regardless of the retained investigation outcome. JSON replies expose the
structured status; terminal, Markdown and HTML include lifecycle and budget
information alongside any source report.

The internal actor tests exercise an actual loopback provider: search, exact
source read, selected-file cited submission, unchanged original source, late
calls rejected after closure/deadline, and cancellation with unresolved model
holds. CLI integration fixtures extend this to the actual executable and retained
read interfaces. These deterministic fixtures do not qualify live-provider
quality, live Docker/smolvm execution, or the full production CLI replacement.
Repository acquisition, package selection, patch application and external
publication remain separate unfinished product work.

### Complete source retention for independent follow-up

New native reviews retain the entire captured file manifest and its bytes before
first inference. This includes unselected text, binary and executable files;
the smaller selected source bundle remains the report's hypothesis evidence.
The root's one-use preparation permission, original owner, manifest, open
controller and deadline govern retention. Delegates do not create separate
archives. Failure to retain source stops the new actor before model dispatch.

Schema 19 adds a separate archive projection and journal witness. A canonical
manifest names hash-checked raw chunks of at most 8 MiB; the captured source is
limited to 4,096 files and 64 MiB. Atomic archive storage is separate from the
generic 32 MiB operation attachment allowance. Archive reads validate the
projection, preparation and retention witnesses, original snapshot identity,
chunk sizes/hashes and complete file hashes. Historical reviews without an
archive return absence; deleting a recorded archive's projection is corruption,
not evidence that it never existed.

`Store::review_source_archive` explicitly reads full retained source.
`stage_source_archive` verifies and reconstructs it in a new private directory,
with executable flags preserved and no symlinks, traversal or host execution.
Capture, validation and reconstruction check cancellation during bounded I/O
and hashing. Large Store retention runs on a joined blocking worker. The caller
must explicitly remove a reconstructed stage after its use/guest cleanup.
Ordinary status and report reads neither load nor copy the raw archive blobs.

Archive retention and reconstruction do not authorize reproduction or repair.
Those follow-ups still need separate host-authorized sessions, frozen independent
attack/control expectations, execution limits, cancellation and lineage to the
original review. They must bind source identity independently of a temporary
execution path and must not reopen the completed review's authority.

Workspace selection remains unfinished. Capture currently includes every file in
the requested directory, including an existing native state database if it is
inside that directory. New commands can therefore capture prior archives and
reach the source-size limit. Keep `--state` outside the selected source tree for
repeated fresh reviews until an explicit, retained exclusion policy is wired.
Exact retries do not capture source again. The default-state fixture proves the
first run and its retained retry, not repeated fresh whole-workspace captures.
