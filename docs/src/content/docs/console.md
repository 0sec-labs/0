---
title: Console
description: Browser conversations and headless chat automation for the 0 engine.
---

## Browser conversations

Run `0` or `0 web` to open the account-free browser console under Node or the
standalone binary. Choose a workspace folder, connect a provider in
**Connections**, and choose the conversation model and autonomy mode.
Use **Chat**, **Findings**, **Workflows**, **Plugins** and **Learning** for
investigation, evidence review and reusable capabilities.

The interactive terminal UI and readline chat REPL are removed. `0 console` and
`0 chat` without a headless prompt print browser guidance. Hidden legacy `0 tui`
and `0 watch` commands print migration guidance and exit with status 2.
The CLI still supports scans, source reviews, binary research, automation and
MCP integrations. Retained terminal modules supply shared session/settings
helpers; they do not provide an interactive terminal entrypoint.

## What Memory remembers

The conversation history supplies context within a chat. Saved findings retain
investigation evidence. **Memory → Lessons** is a separate library of reusable,
source-backed project notes; it is not a list of sources used by a particular reply.

During source inspection, the agent can save a concise lesson with
`remember_codebase`. Each lesson records its project directory, supporting file
paths and content fingerprints. Browser conversations with codebase learning
reuse eligible lessons for the authorized directory, checking file contents before
each model request. Changed or missing supporting files exclude a lesson from recall.
A completed chat alone does not become a source lesson.

Open a lesson's **Supporting files** to inspect its evidence. **Stop using** marks
the retained lesson disabled; it keeps the record for inspection. Lessons are hints
to check against source code, not verified findings or permission to execute tools.
The chat inspector shows lessons supplied with the latest model request. This
means the model received them as context; it does not establish that the answer
relied on or cited them. Older engine versions may not provide this information.

Source notes live in the engine's private user-state store, outside the repository,
and can be mirrored into the learning database shown by Memory. Recalled notes
are sent to the selected model as request context. In browser conversations they
are added temporarily rather than copied into saved chat history. Set
`ZERO_DISABLE_HUNT_MEMORY=1` on the engine to disable source-note learning and recall.

## Headless prompts

Run one request and exit:

```bash
0 chat --prompt "Review the selected repository" --mode standard
0 console --print "Review the selected repository" --mode standard
0 -p "Review the selected repository" --mode standard
printf '%s' 'Summarize the selected findings' | 0 console --print --mode standard
```

These paths use the engine's tool registry and stream ordinary text results.
`--model`, `--role`, `--target`, `--scope`, `--finding`, `--max-tool-calls` and
`--db-path` configure the headless run. Run `0 chat --help` for current options.
A provider connection is independent of target authorization and tool isolation.

## Saved sessions

Combine a prompt with a saved session id or unique prefix:

```bash
0 console --resume SESSION_ID --print "Continue the investigation" --mode standard
0 console --continue --print "Summarize the evidence" --mode standard
```

Saved-session model and target are used when available. A bare `--resume` has
no terminal picker; use the browser history or supply a session id.

## Local history and memory backend

Browser search and the agent's conversation-history tools share the same local
conversation search service. Both search conversational text and metadata using
all query terms, rank relevant matches ahead of recency, and omit tool payloads
and private reasoning. Agent discovery stays in the current project unless
explicitly widened. Bounded searches report when the saved library was truncated.

Chat, scan, and isolated-host source-lesson retrieval use the learning service's
shared recall policy: validate supporting files, respect disabled lessons, and
limit the returned context. Faithful transcripts remain separate from retrieved
hints so resume does not depend on an extracted summary.

This uses the storage already shipped with the engine. It does not require a
Mem0 server, vector database, embedding model, or a migration of existing chats.
Raw transcripts remain in the private session store; source notes and their
learning/evidence records keep their existing formats.

## Non-interactive approval limitations

Headless prompts have no interactive tool-approval surface. Requests requiring
human approval cannot be completed through a terminal dialog. Use the browser
conversation to review those actions. The default headless autonomy mode is
YOLO; when the scope plugin is active it requires configured in-scope entries.
Explicit restrictions remain in effect. `--mode standard` is available for a
headless run with the appropriate scope and tool policy.

## Execution and models

**Local** means tools execute on the engine host. Your selected model endpoint
can still be external. A VM execution profile and a model connection are separate
choices. Configure and inspect them in the browser before starting work.

See [Getting started](/getting-started/), [provider connections](/api-keys/),
[scope](/scope/) and [engine connections](/engine-connections/).

## Model picker

Use the browser conversation model picker to select a provider/model. Worker-role
model overrides remain an embedding API capability; terminal keyboard shortcuts
are retired. See [model routing](/configuration/#multi-model-role-routing).

## Keyboard shortcuts

Terminal keybindings are retired. Browser controls are available with normal
keyboard navigation.

## Acquiring public source

In YOLO, a standalone public HTTPS repository checkout can acquire source for
review without authorizing tests against the hosting service. Ask the chat to
acquire the repository, then inspect it in subsequent tool calls. Checkout
does not change engagement scope; configured exclusions and private-network
restrictions still apply. See [scope rules](/scope/#local-workflows-and-strict-scope-mode).
