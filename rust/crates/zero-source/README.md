# Retained-source hypothesis discovery

This library prepares a bounded local source review and validates one structured
provider submission. Every accepted claim is `Unverified`. It does not reproduce
vulnerabilities, decide reportability, generate/apply fixes, contact a provider,
execute source code, install dependencies or make a clean-code assertion.

The TypeScript reference is `packages/cli/src/commands/review.ts`: quick/default
route through the unified pipeline; deep uses finder lenses. This crate is only
a new native discovery foundation, not parity with either workflow. In
`packages/core/src/unified-pipeline.ts`, the source blind-verifier branch accepts
another agent's finding output; that alone is not a behavioral reproduction.
Future reproduction and repair should use separately approved frozen oracles
and retain the distinctions in `rust/MIGRATION.md`, with
`packages/core/src/verify/reproduction-bundle.ts` and
`packages/core/src/secure/behavioral-repair.ts` as additional behavior references.

## API and ownership

- `prepare(&ReviewRequest) -> Result<PreparedReview>` verifies the supplied
  snapshot through `zero_executor::stage_snapshot`, which anchors source reads
  with directory handles and rejects links/nonregular files. It creates its own
  private copy, reads selected text from that newly owned namespace, checks exact
  bytes/hashes/sizes again, retains those bytes and removes staging. No guest or
  caller-provided copy destination is involved. This blocking operation belongs
  off the async runtime thread. It inherits the executor's Linux support.
- `PreparedReview::bundle()` exposes retained files and portable bundle bytes.
  The bundle contains the complete pinned file index/digest, selected exact text,
  question and maximum hypotheses. It excludes the host source-root path. Source
  and question are untrusted input; this is not secret scanning/redaction.
- `SourceBundle::from_bytes` validates bounded imported JSON, every retained
  content hash/size, snapshot index hash and option bounds. A self-consistent
  imported bundle proves content identity, not who collected it or host authority.
- `PreparedReview::from_bundle(bundle).request(model)` constructs a
  `PreparedSubmission`, whose immutable `request()` is a ResponsesRequest with
  exactly one offered function: `submit_source_hypotheses`. Schemas and prompts
  require hash-bound 1-based inclusive citations. Ordinary text is not a finding.
- `PreparedSubmission::accept(&Completion)` requires terminal Completed, no
  transport error/refusal, exactly one named submission, and no other tool calls.
  It rejects unknown claim/submission fields, invalid severity, missing/duplicate
  citations, unselected files, wrong hashes and nonexistent line ranges. Text
  accompanying a valid submission is ignored; text alone never succeeds.
- `ReviewResult` records model, provider response ID, submission call ID,
  bundle/snapshot/request/normalized-completion identities and deterministic
  hypothesis IDs. Claimed severity and explanation remain model assertions.
  Zero submitted hypotheses means no hypotheses proposed, not a negative oracle.

Hashes use `sha256:<lowercase hex>` over deterministic serde JSON encodings;
source file hashes use exact UTF-8 bytes. Neither newline style nor text is
normalized. Empty files have zero lines; LF terminates a line and a final LF does
not create an extra empty line. CRLF bytes remain intact.

The controller must retain `bundle.to_bytes()`, `request_bytes()`, the complete
normalized Completion and `ReviewResult::to_bytes()` together. Result hashes are
references, not replacement evidence. Provider endpoint/wire identity, pricing,
budget, operation IDs and idempotency belong to the engine's admission, not this
library. Successful acceptance does not settle an inference reservation: only
the provider/accounting layer can establish final usage.

## Bounds and trust boundary

Select 1–32 unique relative files, each at most 128 KiB, at most 512 KiB total.
The staged complete snapshot is limited to 4096 files/64 MiB. The question is at
most 16 KiB; requested hypotheses 1–32, with 1–16 citations each. Every portable
bundle/request/result/normalized-completion artifact is capped at 4 MiB, including
JSON escaping. Files must be UTF-8 without NUL. Oversized/unsupported input is
rejected explicitly, never silently truncated.

The private staging tree is owned by this controller and never given to a guest.
As with other native local storage, this does not claim isolation from a hostile
process already running as the same host user. Exact retained bytes are verified
against the pinned manifest before any provider request is constructed.

Offline tests cover source mutation and portable retention, path escapes and
symlink rejection, content tampering, UTF-8/NUL/size bounds, citation line/hash
validation, unknown schema fields, duplicate/missing submissions, hallucinated
citations, refusal/incomplete responses and prose-only verdicts. No paid model
or live security target is contacted.
