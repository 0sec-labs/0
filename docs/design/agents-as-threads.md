# Agents as threads

Status: approved direction. Phases 0 to 3 are shipped. Phases 4 to 6 below are the plan. Line references come from an audit of `903e5b9e` and must be re-verified on the branch you implement from.

## Status

| Phase | State |
| --- | --- |
| 0 | Shipped (#400). |
| 1 | Shipped (#402). `agent_turns` is written alongside every activation; `GET /sentinels/:id/turns` returns turns with older activations projected as origin `legacy`. The daily ledger reads the union and counts each row once. Behaviour is unchanged. |
| 2 | Shipped (#403) behind a flag. |
| 3 | Backend: the flag is on by default and a person's message in an Agent's thread is recorded as a turn (see "Phase 3 backend" below). Web: see "Phase 3 web" below. |
| 4 to 6 | Not started. |

### Phase 3 backend

`ZERO_AGENTS_PERSISTENT_THREAD` is now on unless it is set to `0`, `false`, `off` or `no`. It is read on every firing, so it can still be flipped without losing state. It is an environment variable and not a setting on purpose: it is the way back, it has no UI, and it is removed once the standing thread has been the default for a release. With it off every firing starts its own child thread again, as before Phase 2.

- `POST /sentinels/:id/thread` returns the Agent's standing thread, restoring it after a restart or creating it if it does not exist. It never replaces a thread that exists. The Agent page uses it to open the real conversation.
- `POST /sentinels/:id/run` (the old "Run now") is a person's message sent into that thread, queued if a turn is in progress. The reply keeps an `activation`-shaped field for older clients for one release. It starts no child thread.
- The engine watches every live Agent thread. A message that nobody queued as a trigger turn and that is not an engine prompt is a person typing: it becomes an `agent_turns` row with origin `user` when it starts, and its cost is the thread cost across the turn. These rows count toward spend and never toward the turn cap (`ledger()` counts runs from non-`user` turns only). They are never stopped by the cap or by a pause, and a turn that starts while the day's spend is already over the budget carries the note `over_budget`.
- Pause is "triggers off": a paused Agent is still answered. Over budget, the web shows a one-time warning and sends the message anyway.
- The Agent view carries `thread: { status, updatedAt, lastMessage }` for the sidebar row.
- A trigger turn that could not start is matched to its row by its queued message id. A turn that was never queued is never blamed for an error.

The flag applies to schedule and GitHub pull request triggers, including the pull request comment option. A person opening or messaging the thread keeps whatever thread exists, even if it was made under an older scope or model; the next trigger turn replaces it (see gap 1) and says so.

With the flag on, a trigger firing calls `deliverTurn` (in `packages/cli/src/web/agent-turns.ts`):

- The Agent's home thread is ensured first (reused, restored after a restart, or created). No child thread is created. If the old thread cannot be restored, or was configured with an older scope, model or skills, a fresh one is created and the next turn says so.
- The turn is reserved in one store transaction (`reserveTurn`): replayed cause (idempotency key), second queued occurrence of the same schedule (`skipped`: "Still working on the previous one"), a newer commit of a pull request that is still queued (the older one becomes `skipped`: "Superseded by a newer commit" and leaves the gateway queue), and the daily turn and spend caps.
- A thread that has a pending decision records the turn as `skipped` ("Waiting on you") and does not queue it. A pull request is not marked as handled in that case, so it is offered again at the next poll.
- The send is queue mode and automated, so a message that cannot start is dropped by the gateway and the next one runs. A full gateway queue is recorded as `skipped` ("The queue is full").
- Every turn starts with a header (`[Turn from schedule "..." at ... UTC · turn <id>]`) and then a compact envelope: the charter (up to 6,000 characters), the scope, the skills allow-list and the remaining budget, followed by the trigger prompt and fenced untrusted event data. `NOTES.md` is sent when its revision changed. The envelope is sent with every turn, so a compaction cannot drop it. A test with a real gateway and a forced compaction shows that the turn after the compaction carries an edited charter and the scope.
- Cost is the thread's cost at the end of the turn minus its cost at the start of that turn. Mid-turn enforcement on usage events stays: reaching the daily cap cancels the turn, pauses the Agent and records the turns waiting behind it.
- A turn that fails does not stall the queue. After three failed turns in a row the trigger turns itself off (`lastStatus: failing`) and the Agent shows "needs you". A person turning the trigger back on resets the count. Turns closed because the engine stopped do not count as failures, and the next turn is told that the previous one was interrupted.
- When a person cancels a turn, the gateway pauses its queue; trigger turns waiting behind it are started again.

### Known gaps in Phase 2 (status after Phase 3)

1. The gateway pins scope, model and the skills allow-list when a thread is created and cannot change them afterwards. The runner therefore records the configuration the standing thread was created with (`homeFingerprint` on the Agent record) and never uses a thread whose configuration differs from the Agent's current scope, model or skills: it creates a fresh thread, tells the Agent so, and sends its notes again. The old thread stays as an ordinary thread. A standing thread from before the fingerprint existed is replaced once. This loses conversation continuity on every scope, model or skills edit until the gateway can reconfigure a live thread; a gateway `instructions` channel and a reconfigurable allow-list would remove the replacement.
2. Closed in Phase 3: the pull request comment works from the standing thread. The engine notes which findings the thread already had when the turn started and lists only the ones the turn added, so a comment never repeats earlier reviews.
3. `messages[0]` of a thread survives compaction verbatim, so the first turn's envelope stays in context forever and can disagree with the current charter. The per-turn envelope says it overrides earlier messages; the system-prompt channel is the real fix.
4. Closed in Phase 3: a person's message is recorded as a turn.
5. Accepted, still open: the per-turn gateway cost ceiling is not set. The gateway's `costCeilingUsd` can only be given when a thread is created and is cumulative for the thread's life, so it cannot bound one turn of a thread that never ends. Only the subscriber enforces the daily cap, and a trigger turn is cancelled when a usage event shows the cap is reached. A gateway call that sets the ceiling per turn would close it.

## Rule

An Agent is one thread that never ends, plus triggers. What used to be a "run" is a turn in that thread. Triggers (schedule, GitHub pull request) are a property of the Agent, not of a separate automation. Any normal Thread can be promoted to an Agent, and demoted back.

Today an Agent is a record that starts a new child thread each time something fires. Its own "thread" page is a facade: every message typed there creates a new child thread and navigates away. The standing thread (`homeMissionId`) exists but is used only by automations set to run in it.

## Model

```
Agent  = durable Thread (homeMissionId, mandatory, created eagerly)
       + trigger table (sentinel_triggers: schedule | github-pr, each with its own prompt)
       + charter and notes (AGENTS.md, NOTES.md virtual files, revisioned)
       + budget, status, review fingerprint
Turn   = one gateway turn in that thread, recorded in agent_turns with its cause
```

- The Agent id stays its own id; the Thread is linked through `homeMissionId`. Nothing is added to the session JSON (its schema is strict and older readers must keep working).
- Old child threads stay ordinary threads with `parentSessionId` set to the home thread. They are not merged into the endless thread: merging transcripts is lossy, expensive and breaks per-run pull request comments that read findings by thread.
- Rows are never rewritten. Legacy activations stay in `sentinel_activations` and are projected into the new read model. This follows the existing "normalise on read" convention.

### Turn ledger: `agent_turns`

Additive table in the control database, created `IF NOT EXISTS`:

```
agent_turns(id TEXT PK, agent_id, session_id, seq INTEGER,   -- seq: monotonic per Agent
            origin TEXT NOT NULL,            -- schedule | github | user | promote | legacy
            origin_json TEXT NOT NULL,       -- trigger id, via, event {repo, pr, headSha, ...}, user id
            trigger_id, status,              -- queued | running | completed | failed | cancelled | skipped
            idempotency_key, cost_usd, error, note,
            queued_at, started_at, finished_at,
            legacy_activation_id)
indexes: (agent_id, started_at), (session_id), (legacy_activation_id), UNIQUE (agent_id, idempotency_key)
```

- `origin` is a closed set. A manual "Run now" collapses into `user`. `legacy` marks projected activations.
- `github` covers the github-pr trigger whether it fired from the poll or from a webhook delivery. Accelerated deliveries set `origin_json.via = "webhook"`. There is no separate `webhook` value until a generic inbound trigger exists.
- `promote` is a marker row written at the end of the thread at promotion time.
- Read APIs return `agent_turns` unioned with activations that have no `legacy_activation_id` row. The daily ledger reads the same union and must not count a row twice.
- The model also sees the cause: each trigger turn starts with a short header such as `[Turn from schedule "Daily dependency check" at 09:00]`, then the trigger prompt, then fenced untrusted event data as today. The charter and notes are not part of that message (see Compaction).
- Matching a gateway turn to its row uses the queued message id that `send` already returns, not a comparison of message text.

### One active turn, queued events coalesce

- One active turn per thread. Never two turns on one transcript.
- Trigger turns always use `queue` delivery. A person typing in the Agent's composer behaves like the composer in any thread (queue or steer prompt).
- A turn that starts consumes everything pending. Occurrences of the same trigger that are still queued coalesce: a second schedule tick while the first is queued is recorded as `skipped` ("Still working on the previous one"); for GitHub only the newest head commit per pull request stays queued.
- The queue is bounded by the gateway limit. On overflow the event is recorded as `skipped`, never dropped silently.
- If the thread has a pending decision (approval or question), trigger turns are recorded `skipped` ("Waiting on you") instead of piling up behind it.
- A failed scheduled turn must not stall later ones. Phase 0 already makes a scheduled message that cannot start get dropped so the next one runs. Scheduled turns are never retried automatically.
- Parallel work comes from delegation (workers and sub-agents inside the thread), not from the thread itself. Pull request reviews therefore serialise; measure before adding a per-trigger fresh-thread option.

### Idempotency keys

Every turn gets a key: schedule is `trigger id + scheduled-for time`; GitHub is `trigger id + pull request number + head commit` (or the delivery id when present); a person's message uses the client key when the caller gives one. The unique index turns a replayed delivery or a second engine tick into a no-op. The existing claim on the trigger (compare-and-swap with a stale-claim timeout) stays as the first guard.

### Compaction at turn boundaries, with a Memory flush

- Compaction is automatic in the gateway today. In an endless thread it will run many times, so it must only happen between turns, and before it runs the Agent gets one short turn to write durable facts to `NOTES.md` as a reviewable revision (author kind `agent`). The summary, `NOTES.md`, the charter and the last turns are the next prompt. Chat is not the system of record; files are.
- Engine Memory (global and per-folder notes) is re-read at the start of every turn already, so a standing thread picks up Memory edits with no work.
- The charter, scope and hard limits are a security control. They live in the first user message today, which a summary can paraphrase or drop. Required before the standing thread is the default (see Risks): (b) re-send a compact charter envelope with every trigger turn, then (a) a system-prompt `instructions` channel in the gateway. When scope or model changes, a "charter changed" turn is sent. `NOTES.md` is re-sent when its revision changed.
- The summarised turns stay in the store and in the timeline (collapsed "N earlier turns summarised"); only the model context shrinks.

### Budgets: block trigger turns, never human messages

- The user-visible budget is spend per day, rolling 24 hours, as today (`budget.dailyUsd`). The turn cap is for trigger turns only; the stored key stays `maxRunsPerDay` and only its label changes ("Automatic turns per day").
- A person's messages count toward spend but are never refused by a cap. Over budget, a person gets a one-time warning and the message still goes through.
- The cap check and the new turn row are one store transaction (`reserveActivation` now, `reserveTurn` later), so concurrent firings cannot both take the last slot.
- Each turn's cost is the thread cost at its own start subtracted from the thread cost at its end, never a baseline taken when it was queued.
- Mid-turn enforcement on usage events stays; the gateway's per-thread cost ceiling is set to the remaining budget for the turn so the gateway stops a runaway even if the subscriber lags (needs a small gateway change: the ceiling can only be set at create today).
- Models without pricing report unknown cost, so the dollar cap cannot bind. Say "Cost unknown for this model" and fall back to the turn cap.

### Circuit breaker

After 3 consecutive failed trigger turns, that trigger is disabled with a visible reason (`lastStatus: failing`) and the Agent is marked "needs you". A person's messages are never blocked by the breaker. The review gate (a changed scope, model or skills must be re-confirmed) blocks trigger turns, not person turns.

### Failure and restart

A failed turn does not poison the thread: its status is failed until the next turn starts. An engine restart mid-turn closes the turn as failed ("The engine stopped before this finished"); the next trigger turn reopens the thread and the Agent is told the previous turn was interrupted. If the home thread cannot be restored, a fresh one is created and a notice turn says so.

## Decided defaults

Decided by the owner; each is reversible until Phase 3.

1. **Pause = triggers off.** The Agent's thread still answers people. Over budget, a person gets a one-time warning and the message still goes through.
2. **Trigger turns go into the one thread.** A per-trigger "fresh thread" opt-out is a later option, not v1.
3. **Provenance `github` with a `via` field.** No separate webhook value until a generic inbound trigger exists.
4. **Promote seeds a deterministic charter template** that the person edits and confirms. A charter is never drafted by the model and used unseen, because it bounds what the Agent may do unattended. A "Suggest instructions" draft shown for editing is a later addition.
5. **"Run" is banned in Agent UI copy only.** Plain Automation executions (workflow runs, `automation run`) keep the word.
6. **Auto-disable a trigger after 3 consecutive failed turns** and mark the Agent "needs you".

## UX (copied from Capy, with the gaps filled)

Capy's Captain is one flagged thread: same route, same renderer, promote and demote are flag flips. We copy that and add what Capy lacks.

- **Sidebar row.** 52px high, 8px horizontal padding, 10px gap. 32px avatar with a 3px radius. Line 1: name in 14px at 75% foreground, fading at the end instead of an ellipsis, with the age on the right (12px, tabular figures, muted). Line 2: the last assistant message, 12px muted, one line. Hover is a white-at-8% background with a 100ms colour change. An idle Agent shows no status text; only working, waiting and failed show a glyph; a count replaces the age when something needs you.
- **Children on hover.** A chevron appears on hover only for an Agent that started threads (the old child threads, and later delegated ones). Expanded: the open ones, or "No open threads".
- **Transcript.** An avatar header ("View agent", "Share" later), date separators, and between replies a muted 12px centered wake-up line that is collapsed and expandable: "Woke on schedule, worked for 54s", with a failure mark when a call failed. Expanded it is a log: what arrived, what it did, how it ended. **Each wake-up line carries a cause chip** (Schedule, GitHub, You, Promoted). Capy has no cause label; we need one because the cause is the point of an Agent.
- **Right pane, Overview.** Threads (the ones it started), Memory and files (`NOTES.md` as its standing notes, the charter), triggers with next time and last result, today's spend against the budget.
- **Profile dialog** (from the thread options and a "View agent" link): name, avatar, description, Folder, Computer, Model, owner, with Delete, Demote, Archive and Save. Capy's dialog has no triggers or pause. Ours adds a Triggers list with on/off and a Pause switch.
- **Composer chips.** Model, Computer with an awake dot, a context ring (tokens used of the budget), and the thread cost.
- **Promote and demote.** "Promote to agent" in the thread options menu (there is no thread action menu in the web app today; adding one is part of Phase 5). Demote is in the Profile dialog: the thread stays an ordinary thread, triggers are removed.
- **Self-scheduling `wait` tool (later).** The Agent registers its own next wake-up (a duration or a time, capped at 7 days, as Capy does) and the composer shows "Waiting until 09:00". A weekly check-in nudge when it has not woken for a week. Not in v1.
- **Pause and resume.** Capy only archives. We add Pause (triggers off, thread still usable) and Resume; "paused" is shown as a state on the row and in Overview.
- Responsive: under about 800px the panes become tabs. Do not touch the worker and sub-agent panels inside a thread (`agents-panel`, `agent-avatar`); they are a different thing.

Copy: Thread, Agent, Computer, Memory, folder, Skill, Extension, Findings. Banned in Agent UI: run, activation, Captain, sentinel. Use "turn", "message" and "task" for work, "schedule" and "trigger" for starters, "activity" for the list. The stored names (`sentinel` tables, `/api/console/sentinels`, `sentinel.*` audit actions, the `launch-authorized-run` literal) do not change; add aliases only.

## Phase plan

Each phase ships alone, adds before it removes, and is one PR. Phases 0 and 1 stand even if the redesign is cancelled.

| Phase | What | Notes |
| --- | --- | --- |
| 0 | Defect fixes found in the audit | Own PR: the runner adapter keeps queue mode; a scheduled message that cannot start no longer blocks the next; deleting an Agent removes its activity history; the boot idle archive protects Agent threads; a queued turn is charged only its own cost; the daily cap check and the activation row are one transaction. |
| 1 | Turn ledger, behaviour unchanged | `agent_turns`, dual write from activations, `GET /sentinels/:id/turns` unioned with legacy, ledger reads the union. Invariant test: every activation has exactly one turn. |
| 2 | One persistent thread as the delivery path, behind a flag | `agentsPersistentThread`, default off. Eager home thread, queue-mode send, no child thread, per-turn charter envelope, queue coalescing and `skipped` reasons, pending-decision skip, trigger status written at turn completion, `reserveTurn`, restart reconcile. Tests with a real gateway and compaction forced. |
| 3 | Default on; UI input goes into the thread | `POST /sentinels/:id/run` becomes "send a message to the Agent's thread" with an old-shape shim for one release. The Agent page renders the real thread and stops navigating away. One-time notice (same pattern as the access upgrade notice) that scheduled work now lands in its thread. Reversal point for the decided defaults. |
| 4 | Triggers as a property of the Agent | A trigger gets its own prompt and label; the owned automation becomes optional (the prompt wins, the workflow supplies steps). The Automations tab becomes Triggers. "Runs in" goes away. |
| 5 | Promote and demote | `fromThread` on create, deterministic charter template, permissions summary and confirm (the thread's approvals, worker policy, scope and web search carry into unattended turns), thread header and menu entry, CLI `agents create --from-thread`, demote. Refuse threads on another Computer, threads that are already an Agent's or a child of one. |
| 6 | Vocabulary and cleanup | Remove the Run dialog, relabel, CLI aliases kept hidden, regenerate the command reference and help snapshot, rewrite the docs page, a copy guard in the design tests, drop controls that nothing reads (`autoLearn`, notifications, `hostId` until honoured). |

Later: a system-prompt `instructions` channel in the gateway, transcript segmentation if the session file grows too large, self-scheduling `wait`.

## Risks

1. **Charter and scope surviving compaction.** First and highest. Scope is a security control and today it lives in a user message. Gate Phase 3 on a test with compaction forced that shows the charter is still in force, and ship the per-turn envelope in Phase 2.
2. **Queue stalls.** A failed start, an unanswered approval, or a cancelled turn that pauses the queue can silently stop all trigger turns. Phase 0 covers the failed start; Phase 2 covers the others.
3. **Authority carried over by promote.** The thread's permissions become unattended permissions. Show them and require confirmation.
4. **Cost accounting.** Queued turns, unpriced models, and the cap race. Phase 0 fixes the first and last.
5. **Behaviour change.** Scheduled work now accumulates in one context instead of a fresh one each time, and pull request reviews serialise. Announce it; add a per-trigger fresh-thread option only if measurement shows it is needed.
6. **Transcript growth.** One session file rewritten on every save, with the pre-compaction messages kept. Measure save cost on a long thread before Phase 3.
7. **Embedding the live conversation in the Agent page.** `conversation.tsx` is tied to the console shell. Keep a link to the thread if embedding slips.
8. **One engine owns the thread.** A second engine on the same database does not see the first engine's live queue. Assume one owner and say so.
9. **Dead settings.** `hostId`, `notifications`, `memory.autoLearn`, `automationIds` and the activation `executionId` are stored and read by nothing. Wire or remove them; do not carry them into the new model.
