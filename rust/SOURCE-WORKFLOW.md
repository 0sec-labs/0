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
6. Export provenance into JSON/SARIF. Host application, Git changes and publishing
   are subsequent explicit workflow capabilities.

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
