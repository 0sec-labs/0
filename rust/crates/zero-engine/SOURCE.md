# Durable source hypothesis review

`ReviewSource { session_id, command_id, request }` accepts a configured provider,
model, nonzero reservation and a typed source request (snapshot, selected files,
question, maximum hypotheses). This is discovery, not a reproduction or repair
workflow. Accepted hypotheses are always `Unverified`; an empty result is not
proof of safety. See `zero-source/README.md` and `rust/MIGRATION.md` for the
legacy behavior and remaining gates.

The parent command is durably admitted and owns the session before source
preparation or provider work. Exact retries compare request and configured
provider route/wire/rates, then return the stored receipt before reading source.
They work after the original directory is changed or deleted. Changed authority
conflicts. Unknown effects are never replayed.

Preparation runs in an owned blocking task using the executor's anchored snapshot
verification and private copy. Cancellation is observed before and after that
bounded copy; the controller awaits it instead of abandoning its staging or
session ownership. This is not an instant cancellation guarantee for a stalled
host filesystem. Shutdown waits for owned tasks to finish cleanup.

Before admitting a provider child, the parent retains immutable `source.bundle`
and `source.request` artifacts. The child admission contains the request hash,
not source text. A durable budget reservation precedes network dispatch. Final
reported usage settles once; missing final usage and interrupted remote requests
retain reservations for explicit reconciliation. A request cancelled before
dispatch is known unsent and releases its reservation.

The parent retains the normalized `source.completion` separately, while the child
settlement carries its hash and accounting metadata. Structured parsing accepts
only the exact submission tool with grounded citations. Invalid/prose output is
Failed, with the completion retained for inspection. Valid `source.review` is
retained before the parent succeeds. Its summary is capped at 512 KiB so the
ordinary operation outcome remains bounded independently of source artifacts.
`Reply::SourceReview` contains that typed summary, artifact hashes, the provider
child ID, whether dispatch was attempted and any error.

Artifact/journal failure before dispatch causes no provider request. A failure
after dispatch closes/reconciles conservatively through the parent and child
owner guards; references already committed remain discoverable by operation ID.
The artifact store is the evidence source: event records only publish attachment
names, hashes and sizes. This workflow does not emit the retained source or
provider request in operation events. Hypothesis text remains untrusted model
output and could itself quote supplied source; no secrecy/redaction guarantee is
implied by compact event framing.

Loopback fixtures cover retained bytes and all artifact links, exact retry after
source deletion and restart, conflicting provider identity, invalid citations,
prose rejection, budget denial and final/missing usage, cancellation, lost
admission delivery and injected artifact-journal failure before network dispatch.
No paid model calls or live target scans are used.
