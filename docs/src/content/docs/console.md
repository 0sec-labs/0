---
title: Console
description: The 0 interactive chat console — talk to the engine, run tools, manage sessions, and navigate every surface from one terminal UI.
---

With the standalone binary or Bun, run `0` with no arguments to open
the interactive chat console. `0 console` opens it with explicit options.
From the prompt, the operator can investigate targets, review source, verify findings and
work on candidate fixes with the available tools.

Two front-ends share the same engine session (`createConsoleSession` from
`@0/core`):

| Front-end | Requirement | Features |
|-----------|-------------|----------|
| **TUI** (full) | [Bun](https://bun.sh) runtime + TTY (`stdout.isTTY && stdin.isTTY`) | All slash commands, visual transcript, sidebars, approval prompts, scope extensions, subagent inspection, command palette, theme picker |
| **readline** (Node) | Node.js 24+, `--scope <file>` required | Text-only REPL; limited command subset; scope extensions denied; no interactive tool-approval surface — see [approval limitations](#non-interactive-approval-limitations) |

The runtime auto-detects Bun and uses the TUI when both Bun and a TTY are
available, falling back to the readline console otherwise.
The standalone release binary includes its runtime; Bun is needed separately
when running the full terminal UI from source.

## Launch

```bash
# Interactive chat — requires a configured LLM provider
0 console

# Start with an engagement target
0 console --target https://example.com --scope ./scope.json

# Start with a role (tool set)
0 console --role discovery --target https://example.com --scope ./scope.json

# Start in YOLO mode with an initial engagement scope
0 console --yolo --scope ./scope.json --target https://example.com

# Resume the most recent saved session
0 console --continue

# Open a session picker to resume a specific one
0 console --resume

# One-shot: run a prompt and exit (non-interactive)
0 console --mode recon --print "Summarise findings" --continue

# Resume a specific session by id (or unique prefix)
0 console --resume a1b2c3d4
```

### Key flags

| Flag | Description | Default |
|------|-------------|---------|
| `--target <url>` | Engagement target the tools operate against | (optional; set in chat) |
| `--scope <file>` | Initial authorization [scope file](/scope/); required under Node | (none) |
| `--role <role>` | Tool set: `audit`, `review`, `discovery`, `attack`, `verify`, `report` | `audit` |
| `--mode <mode>` | Autonomy mode: `standard`, `recon`, `copilot`, `yolo` | `yolo` |
| `--yolo` | Shortcut for `--mode yolo` | — |
| `--model <id>` | Override the LLM model ID | provider default |
| `--max-tool-calls <n>` | Safety cap on tool-call rounds per operator message | `100` |
| `--allow-scanners` | Expose scanner wrappers (sqlmap, nikto, …) | off |
| `--finding <id>` | Focus the chat on one persisted finding | (none) |
| `--finding-intent <intent>` | Finding workflow: `investigate`, `verify`, `draft_fix`, `impact` (requires `--finding`) | `investigate` |
| `--db-path <path>` | Persistent findings database, also used by history screens | `ZERO_DB_PATH` or `~/.0/0.db` |
| `--resume [id]` | Reopen a saved session; omitting id opens a picker | (none) |
| `--continue` | Reopen the most recent session, no picker | (none) |
| `--print [prompt]` | One-shot non-interactive; reads from argument or piped stdin | (none) |

A [`--scope` file](/scope/) is required for the Node readline fallback. Under
the Bun TUI it is optional. YOLO public-network tools accept absolute URLs
without a launch target; explicit configured restrictions and exclusions still apply.
Outside the TUI, YOLO also requires at least one `in_scope` entry, including
with `--print`. Resuming a transcript does not supply a scope file for this
check. For text-only analysis of saved context, explicitly choose `--mode recon`;
Recon is a restricted tool policy, not a guarantee of no network activity.

:::caution[Choose your autonomy policy]
The console defaults to **YOLO**. Use `--mode standard` in the Bun TUI for
interactive per-action approval, or `--mode recon` for the restricted Recon
tool policy. **Co-pilot does not add per-action approval.** Standard also
bypasses that gate when no approval callback is wired; see the
[readline and headless limitation](#non-interactive-approval-limitations).
Explicit restrictions and exclusions still apply. This does not change the
ordinary `scan` command's requirement for a scope file on live targets.
:::

### Setup and navigation

On first launch, Escape goes back one setup decision, including Density →
Theme. Within a provider login or search, Escape cancels that local operation
first. Connect and Models use Ctrl+N to skip; preferences and sharing use `s`.
Back, Confirm, and Skip also have clickable controls. At Welcome, Escape skips
setup and opens chat without marking setup complete. Ctrl+C explicitly quits.
Confirmed settings and credentials remain saved; model choices are applied to
the current audit when you finish or skip setup. Unconfirmed preference previews
are discarded when you go back. `/onboard` opens setup again.

Outside setup, Alt+Left and Alt+Right move through console route history.
Nested popups own input until closed; Escape first closes the current popup or
edit before returning to the previous screen. Shift+Tab moves backward through
the engagement launcher's fields.

### Long-running work and context

The interactive console has no cumulative turn-token cap by default, including
subscription-backed providers. Bare `0`, `0 console`, and resumed sessions
share the 100-tool-round default; `--max-tool-calls` overrides it explicitly.
Provider subscription quotas and explicitly configured engine budgets still
apply independently.

With auto-compaction enabled and a known model window, the console maintains
context between tool rounds and continues the same task. Summaries retain the
opening task, latest instruction, and complete recent tool exchanges. Context
recovery is bounded and reports when it cannot reduce the prompt; a provider
quota or authentication error is not treated as context overflow.

A “turn token budget” pause identifies a local cumulative budget, not the size
of the current context. Older builds imposed a 2m-token default. If that pause
appears unexpectedly, check `0 --version` and `/doctor` for the running
artifact, then restart after updating; an already-running process retains its
loaded code. A separate source checkout or generated bundle may be older than
the installed standalone executable.

### Review previous work

The console attaches a persistent findings database. `query_findings` can
search all sessions or a particular scan ID **within that attached database**.
Use `--db-path` to open a scan's run-local `state.db`; it works independently
of `--finding`, including with `--print`. The console's default remains the
local `~/.0/0.db` (or `ZERO_DB_PATH`), whereas fresh scan workflows use
run-local databases. Do not assume a global history listing means every run's
findings are loaded into this chat.

Saved conversations are a separate store, shared with `/resume`. The model can
use `list_conversations` to discover them and `read_conversation` to retrieve
their user/assistant text. Discovery defaults to the current working directory;
ask for all projects to widen it, or narrow the results with search text.
Transcript reads are paginated and size-limited, with explicit truncation and
continuation metadata. Known credentials are redacted; hidden reasoning, raw
provider payloads, and tool-result bodies are not returned.

Both conversation tools are read-only and work in Recon mode without approval.
Already-running consoles retain their loaded code: restart after updating to
make these tools available.

### Roles

`--role` selects the tool group exposed to the session:

| Role | Tools |
|------|-------|
| `audit` | Full tool registry (default) |
| `review` | Source-code review tools |
| `discovery` | Reconnaissance and enumeration |
| `attack` | Offensive/exploit tools |
| `verify` | Verification and patch validation |
| `report` | Reporting role's tool set |

### Autonomy modes

Cycle the mode with **Shift+Tab** in the TUI, or the `/mode` command.

| Mode | Behavior |
|------|----------|
| **Standard** | Prompts before each effectful (non-read-only) tool call when an `approveTool` callback is wired, as in the TUI. Without that callback, this gate is bypassed. Scope-extension requests are separate. |
| **Recon** | Allows tools classified read-only plus a conservative passive-network reconnaissance set. Effectful/exploit tools are refused; allowed network tools still use authorization and transport checks. Not an offline mode or OS sandbox. |
| **Co-pilot** | Skips Standard's per-action approval gate. Eligible tools proceed automatically, subject to scope and the other authorization controls. |
| **YOLO** | Public-network tools need no launch target or per-discovered-host approval. Explicit operator-configured scope, exclusions and prior refusals remain effective. |

<span id="non-interactive-approval-limitations"></span>
:::caution[Readline and headless approval limitation]
Neither Node/readline nor headless `--print` offers interactive tool-approval
prompts. Selecting Standard or Co-pilot does **not** make these paths deny
effectful calls whenever an operator cannot be asked:

- A **Standard launch** leaves `approveTool` unset, so the Standard gate falls
  through rather than denying the call. Other non-Co-pilot launch modes also
  leave the callback unset.
- A **Co-pilot launch** wires an always-rejecting callback, but Co-pilot skips
  the per-action gate, so that callback is not consulted.
- In **readline**, `/mode` changes the engine mode without replacing the launch
  callback. Switching a session launched in Co-pilot to Standard makes the
  retained callback reject effectful calls, not prompt for them. Switching to
  Standard from a launch without a callback still bypasses this gate.

Use the **Bun TUI in Standard mode** for interactive per-action approval.
Session-only scope extensions are denied separately on the readline and
`--print` paths. Scope, exclusions, Recon restrictions and workspace-trust
checks remain independent controls.
:::

In YOLO, the target is optional task context, not a second permission gate.
Search results and discovered URLs do not update the target or configured scope.
An explicitly empty configured scope remains deny-all; absent scope remains
unconfigured. Private-network access, saved credential forwarding and workspace
host-code trust remain separate controls. Public URLs do not grant access to
private addresses returned by DNS.

Browser HTTP requests use the scoped, address-pinned transport while a browser
tool action is active. Cancelled or ended actions cannot dispatch delayed HTTP
requests or deliver a held response to the page. Underlying held connections
may remain until the existing transport deadline; this is not a full browser
network sandbox or a WebSocket/WebRTC isolation claim.

### Acquiring a public repository in YOLO

Source checkout is separate from permission to test its hosting service.
In YOLO, a standalone public HTTPS `git clone` through `bash` or `run_command`
can fetch code even when the repository host is not the launch target:

```bash
cd /home/dev/coding && git clone --depth=1 https://github.com/golang/go.git golang-go-audit
```

Run inspection, builds, or other commands in subsequent tool calls. Checkout
does **not** change configured engagement scope.
Previously declined hosts and explicit exclusions still apply.

This acquisition path uses standard HTTPS on port 443, public-address DNS
validation and a pinned tunnel, isolated Git configuration, no credential
helpers, and the existing command timeout/output limits. It does not follow
redirects, fetch submodules, accept arbitrary Git configuration, or execute
appended shell commands. Private/authenticated repositories need their normal
authorized workflow; this is not a blanket network-scope bypass.

### Supported runtimes

The console constructs the direct **API runtime**, including supported
API-key, provider-subscription and hosted transports. It does not choose the
Claude Code, Codex or Gemini CLI subprocess wrappers, and has no `--runtime`
option. Installing one of those CLIs is not by itself a console connection.

Use `/connect` and `/model`, or supply the provider configuration described in
[API Keys](/api-keys/). The `--runtime auto|api|claude|codex|gemini` options on
scan/review commands are a different surface; see
[runtime configuration](/configuration/#runtime-modes).

## First interaction

On the first no-argument launch, guided setup walks through connection, model
selection, display preferences and analytics consent. The final **Done**
confirmation marks setup complete. Cancelling does not undo choices already
saved, but setup appears again on the next launch.

For Cloud sign-in, your own API key or a subscription connection, follow the
[setup guide](/getting-started/#configure-a-provider). A normal `/connect`
selection prepares the next chat; it does not automatically replace a healthy
chat's current provider. After connecting, reselect the model in `/model` to
apply it to the current conversation.

When the TUI launches:

- **Home screen** — product mark, engagement panel, composer (text input)
  centred on the screen.
- **Status bar** — active model, mode, working directory, cost/token counters
  (when enabled).
- **Header** — product name, configured scope, optional objective and clickable sidebar controls.
- **Conversation** — Messenger framing by default: your messages align right,
  answers align left. Saved alternative styles remain effective.
- **Agents sidebar** — visible by default on wide terminals, with worker
  activity, plan and findings. Hide it without replacing the conversation.

Type a message and press **Enter** to send it. The engine streams its response
token-by-token. Tool calls appear as bordered cards showing the command or edit,
output, and exit code (controlled by `richToolCards` setting). The transcript
auto-scrolls to newest content. **PageUp** / **PageDown** (or **Ctrl+Up** /
**Ctrl+Down**) scrolls through history.

The context meter displays **unavailable** when the runtime does not report a
usable context window; it is not a turn-budget percentage. Hosted sessions show
the Cloud account's reported credit state separately from estimated model cost.

Use `/copy` (aliases `/export` and `/dump`) while idle to export the complete
public conversation, not just visible transcript rows. It saves private local
JSON even when copying fails. An OSC52 notice means the content was sent to the
terminal clipboard; it does not verify clipboard contents.

Use `/impact <finding-id>` to discuss a persisted finding in the current chat.
Without an ID, select a finding from the conversation. Its prompt asks the model
to distinguish observed impact from conditional chains and missing evidence,
and not to execute tools or expand authorization. This is an analysis workflow,
not a new tool-permission boundary; the session's actual mode and gates still apply.

## Screens

| Screen | Command | Description |
|--------|---------|-------------|
| Chat | `/chat` | Main conversation transcript and composer |
| Launcher | `/launcher`, `/run`, `/home` | Engagement control pane (start new scans, browse sessions) |
| Operations | `/ops`, `/runs` | Active and recent operation status |
| Doctor | `/doctor` | Runtime and configuration diagnostics |
| History | `/history` | Scan history from the database (completed scans, not chat sessions) |
| Findings | `/findings`, `/finds` | Session finding list with filtering |
| Finding detail | `/finding`, `/finding-detail` | Full detail on one finding |
| Replay | `/replay` | Event-level turn replay for a completed scan |
| Settings | `/settings`, `/config`, `/prefs` | Console display settings (persist across sessions) |
| Theme | `/theme`, `/themes` | Colour theme live preview |
| Model | `/model`, `/models` | Select the current audit's model, worker-role overrides and single-model policy |
| Resume | `/resume`, `/sessions` | Saved chat-session list browser |
| Herd | `/herd`, `/workers` | Active subagent worker overview |
| Communications | `/comms`, `/messages` | Agent activity and messages |
| Hackstore | `/hackstore`, `/store`, `/market`, `/marketplace` | Extension marketplace |
| Connect | `/connect`, `/login`, `/auth` | Cloud sign-in, API-key and subscription connections |
| Usage | `/usage`, `/cost`, `/tokens` | Token, cost, and context-window usage for this chat session |
| Provider | `/providers` | Opens the same connection pane as `/connect` |
| Scope | `/scope` | Current engagement scope view |
| Audits | `/audits` | Switch among independent live audits without stopping their work |
| Onboarding | `/onboard` | Reopen guided setup without replacing the current audit |
| Harness | `/harness` | Live harness controls, workspace trust and rollback |
| Keybindings | `/keybindings`, `/keys`, `/keymap` | Inspect or rebind supported keyboard shortcuts |
| Back | `/back` | Navigate to the previous screen |

### Slash commands

Every command is available as `/command` in the composer. Type `/` to open
the command menu. The readline console supports a subset (noted below).

| Command | Aliases | Category | Readline? |
|---------|---------|----------|-----------|
| `/help` | `/?`, `/commands` | info | ✓ |
| `/capabilities` | `/caps` | info | — |
| `/status` | — | info | ✓ |
| `/tools` | — | info | ✓ |
| `/agents` | — | info | — |
| `/clear` | — | session | ✓ |
| `/new-chat` | `/new` | navigation | — |
| `/audits` | — | navigation | — |
| `/onboard` | — | navigation | — |
| `/harness` | — | navigation | — |
| `/stop` | — | session | — |
| `/history` | — | session | — |
| `/transcript` | `/review` | session | — |
| `/findings` | `/finds` | session | — |
| `/finding` | `/finding-detail` | session | — |
| `/impact` | — | session | — |
| `/copy` | `/export`, `/dump` | session | — |
| `/replay` | — | session | — |
| `/resume` | `/sessions` | session | — |
| `/explain` | `/eli5` | session | — |
| `/mode` | — | mode | ✓ |
| `/model` | `/models` | mode | — |
| `/chat` | — | navigation | — |
| `/launcher` | `/run`, `/home` | navigation | — |
| `/ops` | `/runs` | navigation | — |
| `/herd` | `/workers` | navigation | — |
| `/comms` | `/messages` | navigation | — |
| `/hackstore` | `/store`, `/market`, `/marketplace` | navigation | — |
| `/connect` | `/login`, `/auth` | navigation | — |
| `/usage` | `/cost`, `/tokens` | navigation | — |
| `/back` | — | navigation | — |
| `/scope` | — | navigation | — |
| `/exit` | `/quit` | system | ✓ |
| `/feedback` | — | system | — |
| `/settings` | `/config`, `/prefs` | system | — |
| `/theme` | `/themes` | system | — |
| `/keybindings` | `/keys`, `/keymap` | system | — |
| `/doctor` | — | system | — |
| `/providers` | — | system | — |

### Command palette

Open with **Ctrl+P** (or **Ctrl+K**) from any screen. Type to filter commands;
each entry shows its title, keybinding or category, and description. Press
**Enter** to run.

The palette is available on every screen. On the home screen it lists workspace
commands and navigation destinations; on the chat screen it lists session
actions, settings toggles, and screen switches.

### Model picker

For BYOK connections, `/model` opens the priced core and includes the active
model even when it is a custom deployment. With an empty query, **Tab**
switches between this curated list and the full catalog. Any nonblank
model/provider query searches the full catalog, regardless of the Tab setting.
**↑ / ↓** moves the highlight, **Enter** selects, **Ctrl+U** clears the query,
and **Esc** clears a query before going back.

Models with the same ID remain separate provider rows. Moving between them
shows each provider's own price and context window. Provider labels describe
catalog entries; configured credentials determine runtime routing.

Hosted connections show only the account's model catalog. **Tab** does not
add BYOK models, and a catalog failure does not substitute an offline list.

The detail pane keeps its height while filtering, so a single BYOK result still
shows its price estimate, credential source, and setup guidance. A listed model
does not guarantee account access; missing prices remain unknown.

Model, role-model and single-model selections apply to the current audit
immediately while idle, or after the current turn finishes. They also carry
into the next audit. Conversation history, scope and self-extension remain
intact; an in-flight turn is never reconfigured.

If the selected provider is not connected, the selection stays staged for the
next audit. Connect that provider, then select the model again to apply it live.
These rules also apply when opening the picker through **Ctrl+P**.

To assign different models to workers:

1. Connect a provider route that serves all intended models through `/connect`.
2. Open `/model`. **Ctrl+Left / Ctrl+Right** changes the target from the parent
   model to a worker role. Search, highlight a model and press **Enter**.
3. **Ctrl+Backspace** removes the selected role's override and restores parent
   inheritance. **Ctrl+S** toggles single-model mode; while it is on, role picks
   remain stored but are inactive.

The parent selection closes the picker; a role selection keeps it open for more
assignments. **Ctrl+R** reloads an available hosted catalog. Role overrides
select models for work that actually runs; they do not start workers themselves.
Workers inherit the parent's provider, key and endpoint; selecting a role's
model does not switch it to another account. A gateway route can serve several
vendors' models through that one transport. See
[multi-model role routing](/configuration/#multi-model-role-routing) for a
concrete example and precedence. The role map and single-model switch are TUI
and embedding-API controls, not general CLI flags or environment variables.

## Keyboard shortcuts

These are default shortcuts in the main Chat screen unless otherwise noted.
`/keybindings` shows effective bindings and lets you change supported actions;
fixed composer and safety keys are not all rebindable.

### Global exit

| Shortcut | Context | Action |
|----------|---------|--------|
| **Ctrl+C** (once) | Chat screen | Shows exit confirmation with running subagent count |
| **Ctrl+C** (twice) | Chat screen | Quits |
| **Ctrl+C** | Any modal/overlay | Exits (declines pending action, releases caller) |
| **q** | Screens without composer | Quit (Run.tsx screens: Findings, History, Operations, …) |

### Navigation and overlays

| Shortcut | Action |
|----------|--------|
| **Ctrl+P** / **Ctrl+K** | Open command palette (all screens) |
| **Ctrl+O** | Open transcript review; in worker focus, expand/collapse its tool output |
| **Ctrl+R** | Toggle collapsed/expanded tool call detail across the entire transcript |
| **Ctrl+G** | Jump to agents |
| **Ctrl+T** | Open agent communications |
| **Esc** | Clear composer / close overlay / go back / interrupt running turn |
| **Esc** (with no overlay or draft) | Stop a running turn, or navigate back |

### Composer

| Shortcut | Action |
|----------|--------|
| **Enter** | Send message / execute command |
| **Shift+Enter** | Insert newline |
| **Esc** | Cancel draft / close command menu |
| **Up** | Recall previous submission (readline history) |
| **Down** | Walk history forward / enter subagent list |
| **Ctrl+U** | Delete to start of line |
| **Ctrl+W** | Delete previous word |
| **Alt+Backspace** / **Ctrl+Backspace** | Delete previous word |
| **Tab** | Auto-complete slash command |
| **Ctrl+Y** | Pull last queued message back into composer for editing |

### Transcript

| Shortcut | Action |
|----------|--------|
| **PageUp** / **Ctrl+Up** | Scroll transcript up (half page) |
| **PageDown** / **Ctrl+Down** | Scroll transcript down (half page) |
| **Ctrl+Home** | Scroll to transcript start (transcript review only) |
| **Ctrl+End** | Scroll to transcript end (transcript review only) |

### Sidebars and mode

| Shortcut | Action |
|----------|--------|
| **Ctrl+B** | Toggle left sidebar (recent chat sessions + findings) |
| **Ctrl+L** | Toggle right sidebar (active agents + context strip) |
| **Shift+Tab** | Cycle autonomy mode |

### Approval and picker modals

| Shortcut | Action |
|----------|--------|
| **↑ / ↓** | Move selection |
| **Enter** | Confirm selection / approve |
| **Esc** | Cancel / decline |
| **Space** | Toggle option (multi-select) |
| **Backspace** | Remove last character (filter/input field) |
| **Type** | Filter items (in picker) / Enter text (in free-text field) |

### Subagent focus

| Shortcut | Action |
|----------|--------|
| **Down** (idle composer) | Enter subagent list |
| **↑ / ↓** (in list) | Navigate subagent list |
| **Enter** (on agent) | Drill into focused subagent |
| **Esc / Left** (focused) | Return from subagent focus |
| **↑ / ↓**, **PageUp / PageDown** | Scroll the retained worker transcript |
| **Ctrl+O** (focused) | Expand/collapse commands, output, diffs, and tool details |
| Type + **Enter** (focused) | Steer a live worker; follow up with Main when a one-shot worker has finished |

### Transcript review overlay (Ctrl+O)

| Shortcut | Action |
|----------|--------|
| **PageUp** / **Ctrl+Up** | Scroll up |
| **PageDown** / **Ctrl+Down** | Scroll down |
| **Ctrl+Home** | Scroll to start |
| **Ctrl+End** | Scroll to end |
| **Ctrl+O** / **Esc** | Close review |

## Modes, approvals, and scope

The TUI presents the requests below as modal prompts. Per-action tool approval
is a **Standard-mode** gate with a wired callback, not a Co-pilot guarantee.
Scope requests, exclusions, Recon restrictions and workspace trust are separate
controls. Readline and `--print` have no interactive approval surface; see
[their callback limitation](#non-interactive-approval-limitations).

### Scope request (Standard mode)

The engine may propose adding hosts to the session scope:

- **"Approve for this session"** — the exact hosts are added for this session only.
  Existing deny rules in the configured [scope file](/scope/) still take precedence.
- **"Reject"** — the tool does not run.

### Filesystem access request

A source-audit tool may request access to a local directory:

- **"Approve this directory"** — grants this subtree for the session only.
- **"Decline"** — tool does not run.

Nothing is persisted to disk.

### Safety gate override

When a source-audit tool is blocked by a safety gate:

- **"Enable for this session"** — lifts the restriction for the session;
  scope, exclusions, workspace trust and Standard per-action approval (when wired) still apply.
- **"Keep disabled"** — tool stays blocked.

<span id="tool-approval-co-pilot-mode"></span>
### Tool approval (Standard mode)

In the Bun TUI, Standard asks before each effectful (non-read-only) tool call:

- **"Approve this call"** — runs once; the next call asks again.
- **"Reject"** — the model continues without it.

Read-only calls bypass this gate. Co-pilot and YOLO skip it entirely; a Standard
session without an `approveTool` callback also bypasses it. These exemptions
do not remove the separate scope, exclusions, Recon or workspace-trust controls.

### Operator question (`ask_operator`)

The engine may present a structured question (multiple choice, free text, or
both). This modal authorizes nothing — Esc resolves `null` (tool renders as
"dismissed"), Enter confirms the collected answer.

## Capabilities

The capability registry (`/capabilities` or `/caps`) lists every primary surface
organised by safety tier:

| Tier | Meaning |
|------|---------|
| **automatic** | Runs without operator confirmation |
| **operator-confirmed** | Classified for operator confirmation; actual per-action prompts depend on the mode and wired approval callback, not this label alone |
| **blocked** | Disabled for the session (can be lifted per-session) |

Categories: engagement, findings, verification, connect, settings, evolution, automation.

## Sessions, resume, and non-interactive mode

### Session persistence

The TUI saves conversations to `~/.0/console-sessions/<id>.json` after turns,
including failed turns. Files are owner-only (`0600`), and the directory is
`0700`. Metadata includes working directory, model, target, mode, preview,
optional summary, timestamp and native-message count.

The payload is the native message array: **prompts, replies, tool calls and full
tool results are plaintext and are not scrubbed for secrets**. It can include
source, captured requests, credentials and undisclosed findings. Filesystem
permissions are not encryption; review exports and backups before sharing.
The redacted conversation-history tools described above are a different view.
Readline and `--print` can load saved context, but do not write this TUI store.

### Resume

```bash
# Open the session picker
0 console --resume

# Resume a specific session by id (or unique prefix)
0 console --resume a1b2c3d4

# Resume the most recent session
0 console --continue
```

In the TUI, `/resume` or `/sessions` opens the same picker, showing preview
text, relative age (`12s`, `5m`, `3h`, `2d`, `6w`), model, and turn count for
each saved session.

The browser starts with **this project's** sessions. **Tab** includes all
projects without clearing your query. Type or paste to search, **Ctrl+U** clears
the query, and **Enter** resumes the highlighted conversation directly.

To remove a saved transcript, press **Delete** twice on the same session;
**Esc** cancels. Typing `d` searches rather than deleting. A failed deletion
leaves the session visible and reports the error.
A session that cannot be loaded reports the failure in the browser rather than
closing the console.

`--continue` chooses the most recent saved transcript across projects; it is not
the same as the picker's initial current-project filter. Bare `--resume` needs
the TUI picker; use an explicit ID outside it.

Resume restores conversation context, not running workers or session-only
authorization decisions. Supply the intended scope and mode again. Current CLI
precedence also differs by front-end: a saved target wins over `--target`;
the TUI accepts `--model` over the saved model, `--print` prefers the saved model,
and readline uses the supplied/default model. For a different engagement,
start a new audit rather than assuming resume flags replace all saved context.


### Session management

| Command | Action |
|---------|--------|
| `/clear` | Clear the idle audit's conversation; retain target, scope, mode and prior authorization refusals |
| `/new-chat` / `/new` | Create a separate audit using staged model/connection choices |
| `/audits` | Switch live audits without cancelling their workers |
| `/stop audit` | Stop the current audit's work |
| `/stop worker <exact name or id>` | Stop an owned worker and its descendants |
| `/resume` | Browse saved sessions and pick one to resume |
| `/history` | Review scan history from the database |

`/clear` is not `/new` and is not saved-transcript deletion. Live audits have
separate conversation/runtime ownership; selecting another audit does not
stop background work. Use `/stop` deliberately, and `/resume` for disk history.

### Pruning

After TUI writes, pruning keeps the newest **20 unprotected archived sessions
across all projects**. Active and pending-resume sessions are protected and do
not consume that allowance. `DEFAULT_PRUNE_KEEP = 20` is a code constant with
no environment override. Back up needed evidence before it ages out; corrupt
files that cannot be listed are not automatically pruned.

### Non-interactive mode (`--print`)

```bash
# Inline prompt
0 console --mode recon --print "Summarise the saved findings" --continue

# Piped prompt — reads from stdin
echo "Summarise the findings" | 0 console --mode recon --print --continue
```

`--print` runs one prompt through the engine and exits. Text, tool traces and
outcomes can appear on stdout; this is not a JSON-only or answer-only protocol.
Combine it with `--continue` or `--resume <id>` to load saved conversation context.
The YOLO default requires an explicit nonempty scope on this path; the examples
choose Recon, which still permits its restricted tool set.

There is no interactive approval prompt in `--print`. Standard without an
approval callback and Co-pilot both bypass the per-action gate; see
[readline and headless approval limitations](#non-interactive-approval-limitations)
before using this path for tasks that may run tools.

## Transcript vs replay

The console has two views into past data:

| Aspect | **Transcript** | **Replay** |
|--------|----------------|------------|
| Scope | Current session's conversation turns | Any persisted scan (by scan ID or database) |
| Content | Operator + model turns, tool calls, outcomes | Event-level turn timeline: stages, tool calls, model output |
| Access | `/transcript` (Ctrl+O) | `/replay` |
| Data source | Current in-memory conversation; saved native messages can seed a resumed chat | Scan database (`--db-path` or `~/.0/0.db`) |
| Use case | Review what was discussed and returned by tools in this chat | Inspect the events that a scan actually persisted |

The **transcript review** (Ctrl+O) is a scrollable, virtualised rendering of
the current conversation.

The **replay screen** (`/replay`) loads a completed scan's recorded events.
Browse scan runs, select one, and step through its events.

## Feedback and secrets

### Local feedback

`/feedback <message>` appends a Markdown entry with timestamp, version, model,
and mode metadata to `~/.0/feedback.md`. This file is yours — never sent
anywhere without explicit action.

### Staged submission

```text
/feedback submit This scan found an interesting edge case
/feedback send       ← transmits the staged feedback over HTTPS
/feedback cancel     ← clears the staged message without sending
```

- `/feedback submit <message>` writes the entry to the local file AND shows a
  preview of what would be sent (target URL, body, headers with auth redacted,
  any warnings).
- `/feedback send` transmits the most recently submitted message to the
  configured endpoint.
- `/feedback cancel` clears the staged message.

### Transmission

Submission is disabled by any of: `ZERO_OFFLINE=1`, `ZERO_NO_TELEMETRY=1`,
`DO_NOT_TRACK=1`. Transmission goes to the URL in `ZERO_FEEDBACK_URL`, or to
the 0cloud feedback endpoint (`/api/cli-feedback`) when the CLI is
authenticated with a compatible configured 0cloud deployment.

The feedback payload body contains: `message`, `timestamp`, `version`, `model`,
`mode`. The body is capped at 64 KB; request timeout is 5 seconds. Failure to
submit never blocks the session.

### Automatic problem reports

Problem reporting defaults to `automatic`. Tool and runtime failures can produce
a diagnostic through the same feedback transport, independently of manually
staged messages; it does not upload `~/.0/feedback.md`. At analytics levels
`off` or `usage`, the diagnostic is limited to failure categories and runtime
metadata. Opting into `commands` or `full` allows bounded error messages,
stack traces and captured output after redaction. Redaction is not a guarantee
that arbitrary engagement data is safe to share; choose the sharing level
appropriate for your target and credentials.

Open `/feedback` → **Problem-report preferences** to choose `off`, `ask`, or
`automatic`. This global preference cannot be overridden by a project. Explicit
saved opt-outs and the environment opt-outs above remain effective. `ask`
requires confirmation before sending. Without Cloud authentication or a
configured HTTPS endpoint, automatic reports remain local and the console
reports submission as unavailable.

### Secret scanning

When entering an API key through the TUI's credential prompt (`/connect` or
`/providers`), the entered value is stored directly to
`~/.0/credentials.json`. The store's `redactSecret` function produces a
display form showing only a prefix and the last 4 characters (e.g.
`sk-ant-…a4f2`) — the full key is never echoed to the transcript.

The feedback system's `scanForSecrets` is a separate path that inspects
feedback messages for credential patterns before preview display. This does not
affect provider credential storage.

### Storable providers (API-key auth)

API-key connections offered by `/connect` are stored in
`~/.0/credentials.json`; the account store also supports provider-specific
OAuth records and multiple accounts. ChatGPT Codex is an OAuth connection, not
a pasted API-key provider. Explicit nonblank environment credentials take
precedence over saved credentials. See [API Keys](/api-keys/) for each provider's
supported methods and the additional Azure settings.

## Settings

Display settings are layered: **default** → **global** (`~/.0/tui-settings.json`)
→ **project** (`.0/tui-settings.json`). Use `/settings` in the TUI to toggle
them.

The full settings table lives in [Configuration](/configuration/). Key
console-specific controls include sidebar visibility (`showLeftSidebar`,
`showRightSidebar`), transcript density and style, theme, and cost display
toggles.

Type to search across groups, or use **/** before a query beginning with `r`.
Bracketed paste and Unicode backspace work in search. **↑ / ↓** select a
setting; **← / →** cycle its value in either direction; **Enter** changes it
without leaving the search. **Ctrl+U** clears the query, and **Tab** switches
groups when no query is active.

The detail pane retains room for the description, current/default values, and
a visual preview where one exists. Changed settings carry a dot; the status
line reports how many differ from their defaults. Changes save immediately.
**r** resets the selected setting and **Shift+R** resets all settings, after
confirmation. A failed save remains explicitly marked as session-only.

## Working feedback and live plans

Working feedback distinguishes connecting, thinking, streaming, tool execution,
and waiting for operator input. A failed startup is **unavailable**. During a
turn, entering a follow-up interrupts the current turn and sends the queued
message.

Enable **Reduce motion** in settings for static activity glyphs, logo, and
highlights; elapsed time remains visible. Working highlights keep their text
stationary and use normal foreground colors rather than failure red.

The right-hand plan sidebar prioritizes active tasks, then pending work, then
completed work. Phase labels provide context when space permits; tight layouts
favor the task itself. Overflow reports remaining/completed counts, and a fully
completed plan collapses to a compact summary.

## Monitoring subagents

Open **/herd** or **/workers** for the worker overview. **s** searches worker
names, identifiers, tasks, and activity. **Enter** accepts the search; another
**Enter** opens the selected worker. The header counts agents rather than
including group headings in the count.

Worker states have distinct text/glyphs as well as color. Focus view retains
live progress and failure details, with **↑ / ↓** scrolling, **m** for a steering
message, and **Esc** returning to the list. Wide terminals show the overview
and detail side by side; narrow terminals use a stacked layout.

Inside chat, **/agents** opens the retained worker roster without leaving the
conversation. Completed and failed workers stay selectable. A focused worker
shows its task, assistant replies, tool start/completion state, and final answer.
**Ctrl+O** or a tool card's disclosure expands the retained output rather than
another shortened preview. Execution-level truncation limits still apply.

Messages to a live or parked worker use its mailbox. A follow-up to a finished
one-shot worker returns to Main with the worker's result quoted as untrusted
context, instead of disappearing into a dead mailbox. Persistent workers send
their result back to the parent; the parent consumes queued results at its next
model-request boundary.

The bottom status area distinguishes measured context from the **turn spend**
budget. Worker focus shows that worker's reported model, input/output/cache
tokens, and duration; missing measurements remain unknown. Main shows worker
counts, plan progress, queued input, and measured context alongside the existing
model, mode, directory, Git, and enabled usage indicators.

Click **PLAN** in the right sidebar to expand and scroll every task, including
full wrapped descriptions; click again to collapse it. The unabridged plan stays
in the main transcript when the sidebar is hidden.

## TUI crash handling

If the TUI crashes, a crash panel shows the message and a short stack. Options:

| Action | Key |
|--------|-----|
| Restart | **R** (on the options panel) |
| Open crash feedback | **F** |
| Quit | **Q** |

Crash text is sanitised — credential-shaped substrings are redacted before they
reach the panel or any feedback file. The crash panel's feedback composer works
exactly like `/feedback`: local file by default, opt-in HTTPS transmission.

## Related

- [Commands reference](/commands/) — all CLI flags across every command
- [Configuration](/configuration/) — runtime, mode, and feature settings
- [API Keys](/api-keys/) — provider setup
- [Scope & Authorization](/scope/) — scope file format and matching
- [Getting Started](/getting-started/) — install and first scan