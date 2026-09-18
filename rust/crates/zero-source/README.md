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
normalized Completion and `review_result_bytes(&result)` together. Result hashes are
references, not replacement evidence. Provider endpoint/wire identity, pricing,
budget, operation IDs and idempotency belong to the engine's admission, not this
library. Successful acceptance does not settle an inference reservation: only
the provider/accounting layer can establish final usage.

## Bounds and trust boundary

Select 1–32 unique relative files, each at most 128 KiB, at most 512 KiB total.
The staged complete snapshot is limited to 4096 files/64 MiB. The question is at
most 16 KiB; requested hypotheses 1–32, with 1–16 citations each. Every portable
bundle/request/result/normalized-completion artifact is capped at 4 MiB, including
JSON escaping. Accepted review summaries are additionally limited to 512 KiB
for compact engine outcomes. Files must be UTF-8 without NUL. Oversized/unsupported input is
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

## Retained-source investigation API

`investigation::SourceInvestigation::new(&bundle)` borrows a validated
`SourceBundle`. It does not accept a root path, deserialize an authority handle,
open a file, run a shell, or follow a link. Local bundle construction first uses
anchored verification of the complete snapshot and a private copy; portable bundle
import rechecks retained byte/hash/index integrity. Imported hash identity alone
does not authorize use: the engine/host must supply an authorized retained bundle.
Original files can change or disappear after retention without changing answers.

- `list_files(path, limit)` lists only retained selected-file metadata: canonical
  relative path, full SHA-256, UTF-8 byte length and line count. Limits are 1–32.
- `read_file(path, start_line, end_line)` returns an exact inclusive 1-based slice,
  its full-file hash citation, total line count and bundle digest. It accepts at
  most 200 lines and rejects invalid/out-of-file ranges, including reads of an
  empty file. Text preserves original CRLF/LF and final-newline bytes; no status
  prose is injected into cited source text.
- `search_files(query, path, limit)` searches literal case-sensitive substrings,
  returning one complete line per match with exact hash/line citation. Query size
  is 1–256 UTF-8 bytes, without CR/LF/NUL; result limits are 1–200. No regex or
  locale-sensitive case folding occurs. A query can match multiple times in a
  line but yields one result for that line.

Optional listing/search scope is a retained file or directory prefix; `None` or
`.` means the retained root. One leading `./` and a directory scope's single
trailing slash normalize to canonical paths. Absolute paths, traversal, repeated
separators, backslashes, colon and control characters are rejected. Directory
prefix matching observes path boundaries (`src` does not include `src2`). Files
present only in the original snapshot index are inaccessible unless retained.

Every serialized result is limited to 64 KiB, including JSON escaping and
metadata. Listing/search stop at the result or byte cap and mark `truncated` only
when additional matching results are omitted. A single matching line too large
to return fails explicitly; citations never describe silently clipped text.
Reads exceeding the byte cap also fail. No matches means no matches within this
retained selection, not coverage of an entire repository. The existing 32-file,
512-KiB aggregate and 128-KiB per-file bundle bounds limit search work. This library
surface adds no model-tool, engine, CLI, finding-verification, or provider behavior.

Legacy comparison: `packages/core/src/agent/tools/scoped-source.ts` walks a live
scoped directory, excludes `.git`/`node_modules`, lists up to 500 files, and searches
up to 500 files of 256 KiB, skipping unreadable/binary files. It defaults to
case-insensitive matching and clips previews to 500 characters.
`read-file-window.ts` defaults to 500-line windows and appends pagination notes.
The native API operates on explicitly retained files only, fails invalid ranges
and output limits, preserves exact bytes and returns explicit citations. It does
not yet reproduce legacy live-tree breadth, case-folding, or window pagination.
