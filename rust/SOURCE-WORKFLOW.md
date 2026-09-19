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
   Markdown, HTML or SARIF 2.1.0 (`--format sarif`). SARIF results use kind
   `review` and level `note`, retain claimed severity as a property, and preserve
   the typed report and evidence links in run properties. Empty results do not
   establish safety. Explicit reproduction/repair links revalidate retained
   matrices and candidate provenance without executing again. Hypotheses stay
   unverified; rendering never promotes them to verified findings.
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
`ReviewSnapshot` support (introduced in schema 18; current schema 20). Admission
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
profile deadline and 60 seconds. It selects and copies the source into a private
preflight directory, then pins the complete private tree. This prevents a state database
inside the requested directory from invalidating the investigation when the
engine opens. The original caller path remains the retry identity; the captured
canonical root identifies the private copy. A retained workspace selection receipt
records the original canonical directory and the exact exclusion rules.
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

### Explicit workspace selection

Fresh CLI reviews default to the profile mode `"workspace_selection":
"exclude_native_state"`. If the configured state file is inside the source tree,
capture excludes only that exact regular file and its `-wal`, `-shm`, `-journal`
and `.engine-lock` siblings. The receipt records all five rules even when the
files do not exist. Directories, symlinks, multiply linked files and special files
at excluded paths are rejected. No `.0sec` subtree is excluded: adjacent notes,
backups, dirty and untracked source, and Git metadata remain in scope and count
against the source limits. In-source state aliases and parent traversal are
rejected instead of guessing which file to omit.

External state uses full-tree selection. A profile can explicitly request
`"workspace_selection": "full_tree"`; this includes in-source state and prior
archives, which can reach the source-size limit. The default mode is omitted
from profile serialization so historical profile identities stay unchanged.

The receipt binds the original canonical root, policy, exact rules, selected
snapshot digest, file count and byte count to admission and retained status.
The host prompt and CLI status/report display this scope. Full-tree snapshot
verification and archive reconstruction remain exact; they have no exclusion
exceptions. Two fresh reviews with default in-source state therefore capture the
same source identity when only the native state files change.

Exact retries return the original receipt without recapturing source or reading
current profiles. Historical admissions without a receipt remain readable and
retain their original serialization; their original workspace scope is reported
as unrecorded, rather than inferred from a private snapshot path.

### Archive-backed reproduction preparation

`ReviewReproductionPlan` is the strict host authorization envelope for the
native follow-up. It binds the original review/root, retained archive manifest,
logical `verification::Plan`, a total deadline of at most one hour, and an explicit
execution cap of at most 256. The full attack/control matrix must fit the cap;
`FrozenPlan` still validates the complete oracle, backend, expectations and
resource contract. The runnable `review reproduce` command is described below.

`zero_engine::review_reproduction::prepare` checks a drained review controller,
succeeded structured source submission, exact source bundle/hypothesis/snapshot
and complete archive before reconstructing a private tree. It needs no original
source directory or provider configuration. The caller runs this synchronous
preparation on a joined blocking worker and supplies cancellation/deadline
checks; individual SQLite reads must drain before cancellation returns. The
returned stage requires explicit removal after its consumers have drained.
Preparation does not grant permission to launch a sandbox or reopen the review.

The logical frozen plan retains the original source location. A distinct
execution frozen plan changes only that location to the verified reconstruction;
its digest is distinct. Source IDs, manifests, commands, expected outputs,
backend, repeats and resource limits remain exact. The oracle and matrix still
compare the complete request, including location. A retained binding connects
both plan hashes, the entire authorization hash (including total deadline and
execution cap), the review/source session/root and archive manifest hash.

`validate_binding` checks this relation after both original and reconstructed
directories are gone. `Store::review_source_archive_manifest` validates the
archive's historical metadata and witnesses without loading its raw chunks.
That metadata read does not establish that the raw bytes remain available or
intact: actual preparation always uses the full validated archive read.

Schema 20 adds dedicated atomic native reproduction admission in the Store:
a separate zero-model-budget session, immutable host intent, an absolute deadline,
and a global command identity. Exact retries return the original operation;
changed authorization conflicts. Generic command, model budget, queue and tool
admission cannot borrow this session's authority. The original review remains
unchanged. Migration validates the exact prior schema before adding native state.

Preparation permission is one-use. The reconstructed execution plan and source
binding must be retained before ordered matrix children can be admitted. Each
physical dispatch requires its exact retained request and a separate one-use
permission under the current owner, open cancellation gate and deadline. A
permission receipt establishes authorization, not an observed sandbox result.

`Engine::reproduce_review` owns the native worker. Archive reconstruction runs
on a joined blocking worker with an independent read connection, keeping the
owner's cancellation journal writable. Its total deadline closes durable
admission before draining the sandbox supervisor. Case admission handles a
concurrent close without discarding already observed cases; final settlement
rechecks close and deadline inside the same write transaction as the outcome.
Uncertain cleanup remains Unknown. The original review's model account is never
reopened or replenished.

`review reproduce --plan FILE` runs this host-authorized matrix. Exact command
retries compare the full authorization and independently reassess retained
evidence before returning it, without current providers, source or backend.
Read-only inspection uses a bounded, query-only snapshot of both session
journals and ordinary evidence from one SQLite read transaction. Archive chunks
are excluded; retained archive metadata authenticates the logical-to-execution
binding, while complete case inventories, paired physical-start receipts and
exact request/evidence checks authenticate each observation. A prepared binding
alone proves neither authorized dispatch nor success, and ObservedForPlan never
establishes vulnerability reportability.

Native review-to-repair linkage remains a subsequent integration step. Existing
same-session reproduction and repair commands retain their current contracts.

### Archive-backed repair preparation

`ReviewRepairPlan` separately binds a retained native reproduction, exact logical
baseline and materialization policy, replacement bytes, total deadline and an
execution cap covering two complete fresh matrices. Preparation independently
reassesses the baseline's observations and requires ObservedForPlan, original
hypothesis citations for the target/preimage, and safe attack expectations already
frozen before reproduction. The repair request cannot replace those expectations.

`review_repair::prepare` restores the original archive without its checkout or
provider configuration. Reanchoring changes only the materialization baseline's
physical root; all snapshot metadata, path policy, preimage and replacement stay
exact. Its retained binding hashes both authorizations, logical and execution
baseline plans, derived materialization request and expected candidate receipt.
The relation remains independently checkable after private trees are removed.
`candidate_plan` derives the frozen safe attack expectations and preserves the
legitimate controls and execution limits for an exact private candidate.

`zero_repair::materialize_checked` supplies cooperative cancellation through
staging, replacement and final bounded pinning. Failed preparation explicitly
cleans its private candidate and reports uncertain cleanup. It never writes the
original source tree. Preparation alone does not authorize matrix execution or
establish ValidatedCandidateForPlan; the owned workflow below supplies the
separate admission, phase gates and independent final assessment.


### Owned native repair and patch export

```sh
0sec-native --state /absolute/state.db review repair \
  --plan /absolute/host-repair.json --command-id repair-1
0sec-native --state /absolute/state.db review repair-report --command-id repair-1
0sec-native --state /absolute/state.db review repair-export --command-id repair-1 > candidate.patch
```

The strict plan is at most 1 MiB and uses the `ReviewRepairPlan` fields above.
Schema21 adds isolated zero-model-budget repair sessions. Admission binds the
complete independently assessed source/reproduction evidence fingerprint inside
one write transaction. Preparation and source binding recheck that fingerprint;
new source observations cannot silently replace the authorized baseline. Exact
command retries inspect retained authorization before source, backend or current
configuration access and never dispatch more cases.

The owned worker restores the archive, materializes a private candidate, and
checks its complete frozen safe attack/control matrix. Only independently
reassessed successful observations permit a second, newly materialized candidate
and complete reconstructed matrix. Limits cover both matrices together. One-use
journal gates precede preparation, materialization and every physical dispatch;
paired effect artifacts and events bind each case to its exact request. The
original review and reproduction accounts remain unchanged.

Cancellation closes admission, drains blocking preparation and sandbox work,
and then settles the known result. Unknown effects or cleanup remain Unknown;
accepted cancellation cannot be overwritten by a stale success. Failed cleanup
retains the outer private staging path when available. No worker may reopen a
closed repair or repeat an uncertain effect after restart.

Read-only reporting captures the original review, native reproduction and repair
journals under one bounded SQLite snapshot. It independently checks source and
candidate identities, both observation matrices, complete artifact attribution,
and final status. Raw archive chunks are excluded from this report view, so
missing source bytes do not erase retained execution evidence. Export separately
requires the full validated archive and reconstructs the exact preimage before
emitting a unified patch. It never applies the patch to the user's checkout.

Only Succeeded/ValidatedCandidateForPlan exits zero; an unvalidated or partial
repair exits 2, and drained signals retain exit 130/143. This qualification means
the two fresh private candidates met the original host-frozen expectations. It
is not a general repair-safety claim or a verified vulnerability finding.

Deterministic physical fixtures exercise the actual CLI and Engine with a local
process backend, source/config/backend deletion, offline retry/report/export,
patch application to a fixture, corruption rejection, cancellation and setup
failure cleanup. They do not establish real Docker isolation or production
backend qualification.

### Real Docker archive/repair qualification

The opt-in `review_repair_docker` CLI test passed on 2026-09-19 using the
preinstalled immutable image
`sha256:0461844e338a379bd3379976a753e5467dce5361a471fbecff593fa477e3d7f6`
with Python, on the local Linux Docker host. It performs four baseline and eight
repair executions of a harmless marker program. The candidate changes one
expected marker and preserves a separate control output. This tests workflow
mechanics, not vulnerability detection or general repair quality.

```sh
cargo +1.85 test --manifest-path rust/Cargo.toml --locked -p zero-cli \
  --test review actual_docker_native_review_archive_reproduction_repair_and_export \
  -- --ignored --nocapture
```

The reviewed source and provider configuration are deleted before reproduction.
The retained archive supplies baseline, candidate and independently reconstructed
candidate roots. The fixture verifies the exact outputs, two distinct fresh repair
roots, unchanged original checkout, confirmed staging/container cleanup, offline
retry/report and exported patch application. A transparent wrapper records Docker
arguments before executing the real Docker binary; no container image is pulled.
The test also checks the explicit shell entrypoint for this image. Other images,
platforms, smolvm native archive repair and production rollout remain separate
qualification gates.
