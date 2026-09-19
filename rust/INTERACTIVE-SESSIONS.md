# Native actor-owned interactive pipes

`agent --request REQUEST.json` can opt into `interactive_policy` alongside its
existing pinned `execution`. Omission preserves legacy request JSON and offers
no interactive tools. Example policy:

```json
{"max_sessions":2,"max_writes":32,"max_input_bytes":65536,"max_read_bytes":8192,"deadline_ms":60000}
```

The execution must select an already installed Docker `sha256:...` image and a
pinned snapshot. There are no image pulls. This initial capability uses pipes,
not a terminal or PTY. Each created session receives its own disposable snapshot;
commands within that session share the process's state. It does not grant host
workspace editing, networking, provider credentials, or a new spending account.
Each stream is capped by `execution.max_output_bytes` (at most 1 MiB for this
capability); the combined retained transcript is at most twice that limit.
Initial stdin and build commands are rejected. HTTP, plugins, delegation,
operator questions/approvals, source-review tools, scans/reviews, web workflows,
and conversation continuation cannot be combined with this capability.

The model receives four tools:

- `interactive_create(argv)` starts a process and returns an actor-local handle.
- `interactive_write(session_id, data_base64)` forwards one canonical base64
  frame, at most 16 KiB. An acknowledgment proves forwarding to the launcher's
  pipe, **not guest consumption**. A lost or timed-out acknowledgment stops the
  actor with Unknown; those bytes are never retried automatically.
- `interactive_read(session_id, after, max_bytes, wait_ms)` returns a bounded
  page of combined untrusted stdout/stderr with byte cursors. Waits are at most
  one second. Previously retained pages remain readable while the actor owns the
  handle. A finished process does not establish a successful investigation.
- `interactive_close(session_id)` cancels and joins the process and records its
  actual cleanup result. It does not extend the deadline.

The Store authenticates each effect against the immutable actor and completed
model inference, including the exact call position, ID, tool and arguments,
original settled budget, current engine epoch, policy bounds, and actor deadline.
An immutable one-use effect marker commits **before** process creation or stdin
forwarding. All lifetime sessions, writes and bytes count against the original
policy. A maximum of 1,024 total effects bounds read pagination as well.

The deadline is captured before model admission and cancels the whole actor,
including model requests and guests. No subsequent turn refreshes it. Every exit
path drains all actor-owned guests before root settlement. Each session retains
its captured transcript and actual sandbox result as root-operation artifacts.
Unknown cleanup makes the root Unknown. Exact actor retries replay the durable
receipt and do not reconnect, recreate guests, forward input, or refresh time.
This version does not export continuation checkpoints for interactive actors.
Abrupt controller/runtime death still requires external reconciliation of any
reported container identity; it does not promise daemon cleanup after host death.

Validation uses local Responses HTTP and an actual launcher subprocess with a
fake Docker CLI to cover round trips, retained outputs, duplicate and forged
calls, engine ownership, cancellation/deadline and cleanup uncertainty. This is
not Docker isolation evidence. The opt-in physical Docker fixture uses an
explicitly selected installed image and no external model:

```sh
ZERO_INTERACTIVE_DOCKER_IMAGE=sha256:YOUR_INSTALLED_IMAGE \
  cargo +1.85 test --manifest-path rust/Cargo.toml --locked -p zero-engine \
  --test interactive actual_docker_interactive_roundtrip -- --ignored
```

Known final usage over the original session limit remains a successful, charged
inference receipt; the actor fails before dispatching any returned tools. The
Store independently rejects interactive creation and writes after an overage.
Already-owned guests still cancel and join through the common cleanup path.

Local qualification on 2026-09-19 used installed image
`sha256:0461844e338a379bd3379976a753e5467dce5361a471fbecff593fa477e3d7f6`
with Rust 1.85 and `--locked`. One real persistent `cat` process survived two
separate model-selected write/read rounds; cursor pages and the retained
`hello\nhello\n` transcript matched, teardown was Confirmed, and exact retry
issued no new model request. This qualifies that local Docker path, not other
images, PTYs, microVM interactive sessions, or production rollout.
