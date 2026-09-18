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
