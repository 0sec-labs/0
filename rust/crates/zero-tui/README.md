# Native terminal client

`zero-tui` is an experimental fullscreen client of the native NDJSON app-server.
It imports no engine or storage implementation. The CLI launches and owns the
server process; this crate owns terminal restoration and closes its stdin on
exit. Saved replies, operation IDs, queue rows and budgets come from the server.
Live text, reasoning and tool fragments are provisional display data.

The public entry point is `run(reader, writer, Options { session, profile,
budget_limit })`. A profile is an explicit `AgentRequest`; its initial prompt
is never submitted automatically. Without a profile the UI supports browsing
and explicit session creation, but cannot enqueue a new prompt.

- Tab switches sessions, conversation and queue. Enter selects a session.
- `n` in session selection, or Ctrl-N, creates a session with the launch budget
  (default zero). No provider, price, model, image or plugin generation is inferred.
- Enter durably queues the composer; Shift-Enter inserts a newline. Unicode
  paste only inserts text. Drafts remain until acknowledgment; editing is held
  during the acknowledgment to avoid silently losing a rejected draft.
- Ctrl-R explicitly runs the selected pending input. Opening a saved session
  never dispatches pending work. Newly acknowledged local follow-ups drain FIFO
  only after a completed conversational turn and behind existing pending work.
- Ctrl-X cancels active work or a selected pending input. Ctrl-C cancels active
  work, otherwise exits. A cancellation racing admission is retried on admission.
- Ctrl-L loads another session/queue page or older conversation history.
  Ctrl-G reloads newest history. PageUp/PageDown scroll the conversation.
- Ctrl-U clears the composer; arrows/Home/End edit it. F1 shows help. Ctrl-Q exits.

Read snapshots carry session and refresh identities: old responses cannot replace
a newly selected session or a just-completed turn. Continuation uses the latest
server-projected eligible operation, not an older queued receipt. Unknown,
failed, and terminal structured-review outcomes require explicit recovery or a
new session; accepting live text does not establish completion. Safe turn-limit
checkpoints can be continued by explicit Enter and remain engine-validated.

Protocol output has a separate 32 MiB frame bound, a one-message authoritative
queue and a lossy 128-event advisory queue. A larger terminal reply reports an
explicit display error; the persisted outcome is unchanged. History reads enforce
their own retained-row and display limits. Composer text is limited to 16 KiB. Live text, reasoning and tool drafts
are each capped at 64 KiB. History keeps a visible 200-turn window; Ctrl-G returns
to newest. Session selection keeps the last 500 loaded entries. Queue memory is
limited to 200 rows / 8 MiB, evicting old terminal rows first; oversized unfinished
queues fail explicitly and can be managed through the queue CLI. Queue reads
continue until an empty page, including byte-capped pages shorter than requested.

This implements a fullscreen conversation/queue foundation, not legacy TUI parity:
there are no source/findings editors, approval widgets, search, terminal panes,
credential management, profile editing, plugin activation or visual scan workflows.
Tool drafts are inert text and never initiate execution. Terminal sanitization
removes control bytes from displayed server content. The actual sandbox, provider,
budget, cancellation and cleanup policies remain app-server responsibilities.
