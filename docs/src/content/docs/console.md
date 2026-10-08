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

The interactive terminal UI and readline chat REPL are retired. `0 console`,
`0 chat`, `0 tui` and `0 watch` without a headless prompt print browser guidance.
The CLI still supports scans, source reviews, binary research, automation and
MCP integrations. Retained terminal modules supply shared session/settings
helpers; they do not provide an interactive terminal entrypoint.

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
