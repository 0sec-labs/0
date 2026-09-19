# Private source editing, execution and export

The native agent can now opt into a versioned source workspace. This implements
actual iterative read/edit/test behavior: each test executes the selected edited
generation, and subsequent tools observe prior edits. It does not silently edit
the operator's checkout or certify a repair.

Legacy comparison: TypeScript `apply_patch` and `str_replace` write directly to
`ToolContext.scopePath`. Local source preparation sets that to the original
checkout (`needsCleanup: false`); remote/package acquisition uses temporary
trees. This native actor instead retains an immutable baseline and edits private
logical generations. Explicit checked host application is a separate authority
boundary; exporting a candidate alone does not reproduce legacy host mutation.

Add `workspace_policy` to an `agent --request` document with a digest-pinned
Docker `execution` and its existing pinned `snapshot`. Omission offers no edit
or workspace execution tools and preserves previous request identity.

```json
{
  "paths": [
    {"path":"src/example.py","baseline_sha256":"sha256:...","executable":false},
    {"path":"new_test.py","baseline_sha256":null,"executable":false}
  ],
  "max_edits":32,
  "max_changed_bytes":1048576,
  "max_test_runs":8,
  "deadline_ms":60000
}
```

The paths are a host-authored allowlist, with exact baseline content hashes or
absence and executable-mode preconditions. Modes cannot be changed by the
model. Baseline capture rejects symlinks, hardlinks and changed snapshot bytes
through the existing source-archive implementation. It finishes and is retained
before the first model inference. Tools never accept a host root or absolute
filesystem path.

Bounds: baseline 64 MiB/4,096 files, at most 256 editable paths, 128 edit
invocations, 8 MiB cumulative resulting changed-file bytes, 1 MiB per edited text
file, 32 test runs, and one 100–600,000 ms deadline. Test stdout/stderr each have
an explicit execution cap no larger than 64 KiB. The original deadline also
cancels outstanding provider requests and joins test-process cleanup. It is
never refreshed by model turns or exact retries.

Tools:

- `workspace_list(prefix, after, max_results)` pages at most 200 paths.
- `workspace_read(path, offset, max_bytes)` returns at most 64 KiB UTF-8 bytes,
  content SHA256, generation and a byte cursor. Binary files are unavailable as
  text; UTF-8 character boundaries are checked.
- `workspace_search(query, prefix, max_results)` performs literal per-line search,
  with at most 200 hits and 64 KiB matched text/path bytes, truncation and skipped
  binary metadata. This is not regex or semantic search.
- `write_file(path, expected_generation, content)` writes an allowed private path.
- `str_replace(path, expected_generation, old_string, new_string, replace_all)`
  requires exact unique text unless `replace_all` is explicitly true.
- `apply_patch(expected_generation, patch)` accepts the legacy `*** Begin Patch`
  DSL with Add/Replace/Update/Delete File directives, at most 32 operations, a
  1 MiB envelope and bounded exact anchored hunks. This is not unified diff.
  The entire envelope commits atomically; a bad later operation cannot leave
  earlier operations partially applied. `@@` anchors locate exactly one matching
  line, and context/deletions must match. Add refuses existing paths; Delete
  requires an existing path. Models must supply the current generation obtained
  from a workspace observation. Legacy clients therefore need this additional
  precondition even though the patch text format is retained.
- `execute_workspace(expected_generation, argv)` reconstructs that exact retained
  archive into an owned private stage, then uses the existing Docker executor's
  fresh offline copy. Build/output side effects do not silently become edits.
  The next test starts from the last committed source generation. Output is an
  **unverified observation**, irrespective of process exit status.

The Store authenticates edit and test effects against the original completed
model invocation, settled inference usage, original account, actor owner and
engine epoch. Final usage overage remains charged but stops new effects.
Edits atomically retain their archive and receipt. Tests have a one-use durable
marker before staging/launch; an uncertain launch/outcome is not replayed.
A second atomic, one-use dispatch witness checks the current engine epoch,
Running actor ownership, original deadline/account, invocation and exact staged
request after staging, immediately before executor dispatch. A revoked actor
cannot launch using only its earlier claim. Independent replay checks settlement
preceded the effect and requires this dispatch witness before physical outcomes.
Read-only inspection reconstructs edit receipts from the original retained
model calls and checks content, modes, generation chain, budget history and
exact test-source identity. No new database schema or mutable workspace table
is required.

HTTP, plugins, delegation, operator approval/questions,
source-review tools, scan/review/campaign controllers and conversation
continuation cannot be combined with this capability. The actor does not export
resumable checkpoints containing mutable workspace authority. All test staging
is joined and explicitly removed even on cancellation/error; uncertain cleanup
makes the actor Unknown and retains recovery diagnostics. Host/runtime death is
not a daemon cleanup guarantee.

After a terminal actor, export without opening an Engine or loading credentials:

```sh
0sec-native --state state.db workspace-export --session SESSION \
  --operation OPERATION --output-dir /absolute/new-candidate
```

Publication is atomic and no-replace under an anchored parent directory. It
creates `source/` (the final executable tree), `blobs/<64hex>` (deduplicated raw
baseline/final archive chunks), and `bundle.json`. The bundle includes both
canonical manifests, mode-sensitive generation hashes, ordered effect receipts,
unverified test observations and per-path baseline/final content+mode or absence
preconditions. `assessment` stays `unverified`, and `host_apply` stays
`not_performed`. Provider configuration and the original checkout may be absent.
An existing destination, wrong session, active actor or broken retained evidence
is rejected. Export is not a repair verification or production promotion gate.

Qualification uses Rust 1.85 with the locked dependency graph. The CLI fixture
drives eleven local model responses through reads/search, three distinct
executed generations, write/replace/atomic patch, exact retry, and offline export
after deleting both original source and provider configuration. Its ignored
`actual_docker_private_edit_test_export` variant ran successfully against local
image `sha256:0461844e338a379bd3379976a753e5467dce5361a471fbecff593fa477e3d7f6`
without pulling. The default fixture uses a physical local Python subprocess
launcher and is not a container-isolation proof. Focused fault tests cover
cancellation during an outstanding provider request after an edit, known final
usage overage, duplicate/forged/wrong-owner effects, deadline with uncertain
guest cleanup, and missing retained changed-content evidence. Tests demonstrate
this bounded private edit lifecycle; they do not certify arbitrary model changes
or establish production readiness.

## Interactive sessions from edited generations

An actor may now explicitly combine `workspace_policy` and `interactive_policy`.
Both policies must specify the same `deadline_ms`; their captures share the
original creation time. All other incompatible capabilities remain rejected.
The existing interactive limits still apply: at most four sessions, 128 writes,
1 MiB cumulative input, 16 KiB input frames and 64 KiB read pages. Session count
is bounded independently of `max_test_runs` for one-shot workspace executions.

With this combination, `interactive_create` requires `expected_generation` as
well as `argv`. It stages that exact current archive into an owned private copy,
then commits a second one-use launch witness immediately before dispatch. The
Store checks current actor ownership, engine epoch, original deadline/account,
settled model invocation, original claim, source generation and complete
execution request at this frontier. Staging does not extend the deadline.

A session keeps its creation generation across turns. `interactive_write` is
rejected after source edits revoke that generation; `interactive_read` and
`interactive_close` remain available. Close and recreate the session to use the
new generation. Stale creation and write requests return a rejection without
launching or forwarding bytes. Guest filesystem changes are never imported into
logical edits or exports. Existing standalone snapshot interactive requests keep
their creation schema and request identity.

Reads carry the session generation. Write acknowledgment still means forwarding
to the launcher, not guest consumption. Close/final cleanup joins processes;
owned archive stages are removed after all session cleanup has joined. Exported
`tests` may include `kind: workspace_interactive` observations containing the
creation generation, exact launch request/witness, authenticated model claims
and retained result. Their assessment remains `unverified`. Independent reading
checks generation at each create/write, inference settlement before claims,
claim-before-launch and launch-before-session effects, original budget/deadline,
and retained result identity. A missing launch/result remains uncertain rather
than becoming success evidence.

Qualification includes a physical persistent-process fixture and an actual local
Docker run: two inputs across separate model turns observe the edited source and
increment the same process counter; an edit revokes subsequent writes; a new
session observes the final source; guest mutation of another file is absent from
export. Tests also cover epoch/deadline revocation while staging is paused,
one-use launch, wrong owner, altered launch provenance, missing launch witness,
and cancellation while a provider response is outstanding. These remain pipe
sessions rather than terminal-emulation/PTY support.
