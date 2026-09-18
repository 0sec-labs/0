# Retained source tools

`AgentRequest.source_review_operation_id` explicitly enables three read-only tools:
`list_source_files`, `read_source_lines`, and `search_source_text`. Omission preserves
the previous request serialization and tool set. The CLI accepts this field in an
`agent --request` JSON file; no new implicit filesystem permission is introduced.

The referenced operation must be a succeeded source review in the same session.
Before new admission or provider work, the engine verifies retained bundle and
review artifact hashes, their attached names, outcome correlation and the exact
original snapshot pin (including root) against the agent's execution profile.
Only selected files retained in that bundle are readable. The tool implementation
has no filesystem or shell access, and does not read files added after review.
An empty search result says nothing about files outside that retained set.

Tool arguments are strict bounded objects. Reads preserve exact UTF-8 source and
line endings with 1-based inclusive citations; search is literal and case-sensitive.
The library bounds every serialized result to 64 KiB. Each accepted result is
retained as `source.tool_result` before the next provider turn, with its bundle
identity in the durable child operation. Rejected calls return a tool error and
cannot expand authority. Source contents remain untrusted data. Existing provider
request journals can contain the source excerpts included in model context.

Source tools use the existing bounded agent turn/call and provider accounting
rules. They do not launch a sandbox or fabricate an additional compute charge.
Explicit `execute_snapshot` and configured plugin tools retain their separate
host authorization. Plugin aliases cannot shadow source tools when those tools
are enabled. Completed retries return recorded outcomes without loading source
again; explicit continuation must preserve the same source operation and all
existing provider/execution pins.

This is a narrow implementation of legacy read/list/search behavior. It does not
yet select or ingest an entire repository, search unretained files, provide regex
search, or replace source-review discovery and verification workflows. Integration
tests use loopback provider fixtures; they do not assert model detection quality.

## Whole pinned snapshot mode

`AgentRequest.source_snapshot_tools: true` enables the same tools without a prior
source review. It is mutually exclusive with `source_review_operation_id`. The
entire execution snapshot remains explicit host authority, with at most 4,096
files and 64 MiB. Preparation verifies and privately copies that snapshot after
durable admission. The engine retains `source.snapshot_catalog` and journals the
private recovery path before any provider request. No paid review is required to
begin investigation in this mode.

The model can list the manifest and read/search its private copy; changes to the
original source after preparation cannot change observations. Reads anchor every
path component without following links and recheck the exact file hash. Oversized,
non-UTF-8 and NUL-containing files are explicit search exclusions, and truncated
results never claim a complete search. Individual reads remain limited to 128 KiB
files, 200 lines and 64 KiB serialized output. Agent listing retains the 32-result
bound; searches permit at most 200 results. Results use `snapshot_digest`, not a
mislabelled retained-bundle hash.

Blocking preparation, reads and cleanup run off async runtime threads, and their
owners are awaited through cancellation. Before parent settlement or checkpoint
creation, the private copy is explicitly cleaned up. Cleanup failure overrides
success/turn-limit with `Unknown`, a `source_recovery_path`, and no continuation
checkpoint. Ordinary errors also pass through this cleanup path. Panic/SIGKILL
still rely on best-effort destructors and recorded recovery paths; creation before
the prepared event has the existing temporary-directory crash window. Filesystem
stalls do not have a guaranteed hard interruption deadline.

Exact command retries do not restage or reread source. A *new* snapshot-mode
continuation restages the original pin and fails if it changed or disappeared.
Retained-review continuation remains independent of those live files. Default
false is omitted from serialization, preserving old command retry identities.

## Listing every authorized file

`list_source_files` accepts optional `after_path`. A truncated listing returns
`next_after_path`, the last emitted canonical path. Pass that value with the same
prefix to obtain the next lexicographically ordered page; repeat until the cursor
is absent and `truncated` is false. The engine still caps each page at 32 entries.
The cursor must name a file inside the current authorized manifest and prefix;
missing files, traversal and cursors outside that prefix are rejected. Cursor
bytes count toward the existing serialized output limit. Identity comes from the
fixed source authority and response digest, not from the path token alone.

## Adaptive structured source review

Set `source_submission_max_hypotheses` to 1..32 together with
`source_snapshot_tools: true` to require a structured terminal review. The agent
can inspect source and use its already authorized tools, then call
`submit_source_hypotheses` as its sole final tool call. Arguments contain
`selected_files` (0..32 paths) and `hypotheses`; every nonempty hypothesis must
cite an exact selected file hash and valid inclusive line range. Final prose
alone fails. A submission mixed with execution or any other tool fails before
those mixed calls execute.

Selection reads only the verified private copy. The engine retains the selected
bundle, actual final model request including prior tool history, normalized
completion and validated review as `source.bundle`, `source.request`,
`source.completion` and `source.review`. The optional `AgentResult.source_review`
contains the same review/outcome shape as one-shot discovery, including the final
inference operation. It remains unverified. Provider work is charged through the
normal per-turn budget; there is no additional hidden submission request.

Nonempty bundles retain the existing version-1 encoding. An explicitly empty
selection uses version 2 with the full snapshot manifest but no selected text;
only empty hypotheses can validate against it. This means no hypotheses proposed,
not proof of safety or exhaustive review. Bundle readers validate both versions;
one-shot selected-source requests retain their existing nonempty requirement.

Reproduction, repair preconditions and retained-source investigation accept a
succeeded adaptive review operation. They reload/hash its artifacts and revalidate
the original submission against its correlated final inference, source authority
and host limits. Cleanup still precedes success; uncertainty makes the parent
ineligible even if artifacts were written. Exact retries return its recorded
outcome without more provider work. A terminal structured submission closes that
conversation and cannot be continued as a normal answer; turn-limit checkpoints
before submission can continue with unchanged submission authority.

This connects exploration to retained hypotheses and existing frozen reproduction.
It does not implement legacy review lenses, automatic independent oracle creation,
all review flags, reportability or a model-quality guarantee.
