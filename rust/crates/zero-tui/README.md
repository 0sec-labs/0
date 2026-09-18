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

- Tab switches sessions, conversation, queue and Findings. Enter selects a session.
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

The Findings view works without a provider profile. Enter selects a retained review
candidate, then a hypothesis. Review discovery displays metadata only: failed or
partial candidates stay visible, and selecting one runs full provenance validation.
An empty discovery scan window can still have another page; Ctrl-L continues.
Empty hypotheses never mean that the source is safe.

On hypothesis detail, `a` / `s` / `r` opens an Accept / Suppress / Reopen note.
These are operator dispositions; every hypothesis remains **Unverified**, severity
remains a model claim, and the security conclusion remains unestablished. Unicode
paste and Enter only insert note text. Ctrl-S explicitly submits; Esc discards the
form. Notes are limited to 4096 UTF-8 bytes. Session/view navigation is held while
a draft is open or a decision acknowledgment is pending; global active-turn
cancellation and quitting remain available.

Each submitted note binds the selected source identity and displayed revision.
Errors retain the draft and command ID for exact retry; editing a submitted draft
is held. A revision conflict refreshes the current record while preserving the
original note/revision. Ctrl-B explicitly rebases it onto the displayed current
revision and creates a new command ID; Ctrl-S then submits that new decision.
Exact retries display their original decision receipt separately from the latest
current record. They never silently overwrite a newer operator decision.

Findings lists and decision history show one bounded page at a time (20 records,
2 MiB maximum response retained by this UI). Ctrl-L advances, including after a
short byte-limited page; Ctrl-G returns to the first page. Each new page replaces
the prior window. Esc moves back; PageUp/PageDown scroll detail. Read responses
are scoped to session, selection, and refresh generation. Source hashes and
citations remain visible; no arbitrary local source reads or model tools are added.

This implements fullscreen conversation, queue, and native source-triage workflows,
not legacy TUI parity. There are no source editors, approval widgets, search, terminal panes,
credential management, profile editing, plugin activation or visual scan workflows.
Tool drafts are inert text and never initiate execution. Terminal sanitization
removes control bytes from displayed server content. The actual sandbox, provider,
budget, cancellation and cleanup policies remain app-server responsibilities.
