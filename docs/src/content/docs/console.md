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
| **TUI** (full) | [Bun](https://bun.sh) runtime + TTY (`stdout.isTTY && stdin.isTTY`) | All slash commands, visual transcript, approval prompts, scope extensions, subagent inspection, command palette, theme picker |
| **readline** (Node) | Node.js 24+, `--scope <file>` required | Text-only REPL; limited command subset; scope extensions denied; no interactive tool-approval surface — see [approval limitations](#non-interactive-approval-limitations) |

The runtime auto-detects Bun and uses the TUI when both Bun and a TTY are
available, falling back to the readline console otherwise.
The standalone release binary includes its runtime; Bun is needed separately
when running the full terminal UI from source.

### Online SmolVM workbench

On Apple Silicon macOS, select the workbench profile to run the **entire**
console inside the native SmolVM guest: agents, shell tools, browser, workspace
operations and explicitly granted GitHub integration. This is an online Kali
workbench, not the separate offline candidate-evaluation sandbox. No Colima or
Docker daemon is needed at runtime; image creation can still use Docker.

```bash
0 workbench providers
0 workbench setup --image /absolute/path/0-workbench-linux-arm64.tar \
  --provider chatgpt-codex
0 workbench status
0 console
```

Setup provisions the verified signed native runtime and pins your explicitly
approved image. Later launches resolve that saved approval automatically. The
current invocation directory is mounted at `/workspace`; use relative source,
scope and artifact paths within that workspace. A fixed workspace can instead
be selected with `--workspace <directory>`.

Provider grants select which existing host account credentials reach the guest.
Only the selected account/token values are forwarded, not host login folders.
You can also connect directly inside the guest. Add `--github` explicitly to
grant the current `gh` token or `GH_TOKEN`/`GITHUB_TOKEN`; otherwise no GitHub
credential crosses the boundary. Host HOME, SSH agents and Docker sockets are
not granted. Guest session state and writable storage are private to this VM
profile.

Isolated executable and reproduction actions use bounded, host-supervised
**sibling SmolVM guests** through private file-based admission, not nested Docker
or KVM and not unfenced execution beside provider credentials. Setup/status show
the concrete source, I/O, time and concurrency ceilings. Sharing and diagnostic
opt-outs remain effective in the guest without forwarding reporting endpoint
authority. Networking stays online by default; an explicitly enabled
`ZERO_OFFLINE` keeps that invocation offline.

The original arguments and terminal streams reach guest `0` unchanged, including
piped prompts and resume shortcuts. Provisioning, launch and ambiguous-cleanup
failures are refusals, never fallback to the host or Docker. `0 workbench status`
and `0 config` remain host-side management commands; `0 workbench disable`
explicitly selects host-local execution. See [workbench configuration](/configuration/#whole-harness-execution-profile).

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

Scope authorization is the first-party **scope plugin**, disabled until you
explicitly activate it for the current project with `0 plugin enable scope`.
Use `0 plugin disable scope` to deactivate it. A [`--scope` file](/scope/)
supplies policy; it does not activate the plugin by itself. With the plugin
enabled, the existing host/path checks, exclusions, local filesystem boundaries
and missing-scope refusals apply. With it disabled, those authorization checks
do **not** run. Credential protection, sandboxing and resource limits remain.

:::caution[Choose your autonomy policy]
The console defaults to **YOLO**. Use `--mode standard` in the Bun TUI for
interactive per-action approval, or `--mode recon` for the restricted Recon
tool policy. **Co-pilot does not add per-action approval.** Standard also
bypasses that gate when no approval callback is wired; see the
[readline and headless limitation](#non-interactive-approval-limitations).
When enabled, the scope plugin enforces restrictions independently of autonomy;
live `scan` targets then require a configured scope file or host policy.
:::

### Setup and navigation

Running `0` opens the branded main console directly, including on a fresh
installation. Setup does not block the composer. Use `/connect` for your API key
or provider subscription, `/models` to choose a model, or `/onboard` for optional
guided setup: Welcome → Provider → Model → Theme → Data sharing.

In guided setup, Escape goes back one decision.
Within a provider login or search, Escape cancels that local operation first.
Connect and Models use Ctrl+N to skip; Theme and Data sharing use `s`.
Back, Confirm, and Skip also have clickable controls. At Welcome, Escape skips
setup without marking it complete. Confirming or skipping Data sharing completes
setup and returns directly to chat; there is no separate Done screen. Ctrl+C explicitly quits.
Confirmed settings and credentials remain saved. Model selections apply to an
available audit runtime and are also staged for the next audit. Unconfirmed
preference previews are discarded when you go back.

Plugins are configured separately, not added as a guided-setup step.
Use `/hackstore` to browse. Installed files live under `~/.0/plugins/<id>/`.
Start authoring with `0 hackstore init my-extension` and validate with
`0 hackstore validate ./my-extension`; see the [Hackstore author guide](/hackstore/).
Registry submissions are prepared locally and published through a reviewed pull
request. Setup never installs, enables or runs plugins.

Finishing setup returns to the wordmark and main composer. Missing credentials
or failed provider checks remain visible beneath the brand with `/connect` and
retry controls; completing setup does not assert that a provider is ready.

The header says `idle` when chat is waiting for input; it does not certify
provider availability. Runtime initialization details and error stacks stay in
the local TUI log (`/tmp/0-tui.log`, overridable with `ZERO_TUI_LOG`). Turn
failures appear once in chat with the cause and model/connection recovery commands.

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

A native Responses `max_output_tokens` incompletion is a recoverable checkpoint
when its terminal state is valid. The console retains completed observations and
plan state, discards incomplete function calls, and makes at most three extra
cap-continuation requests within the original limits. Repeated caps pause with a
resume instruction rather than a provider-failure verdict. Send a new operator
message to resume; authentication, policy, quota, cancellation, and budget errors
remain distinct terminal conditions. The native provider output bound remains
8,192 tokens where supported.

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

Saved conversations are a separate store, shared with `/sessions`. The model can
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

Cycle the mode with **Shift+Tab** in the TUI. The command chooser has no mode selector.

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

Readline sessions keep the mode selected at launch; use `--mode` when starting
a session. Use the **Bun TUI in Standard mode** for interactive per-action approval.

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

The console constructs the direct **API runtime** from your API key or
provider subscription. It does not choose the Claude Code, Codex or Gemini
CLI subprocess wrappers, and has no `--runtime` option. Installing one of
those CLIs is not by itself a console connection.

Use `/connect` and `/model`, or supply the provider configuration described in
[API Keys](/api-keys/). The `--runtime auto|api|claude|codex|gemini` options on
scan/review commands are a different surface; see
[runtime configuration](/configuration/#runtime-modes).

## First interaction

Running `0` opens the main composer directly. Optional `/onboard` setup walks
through Welcome, Provider, Model, Theme and Data sharing. Confirming or skipping
the last step marks setup complete and returns directly to chat. Cancelling does
not undo choices already saved.

For your own API key or a supported subscription connection, follow the
[setup guide](/getting-started/#configure-a-provider). A normal `/connect`
selection prepares the next chat; it does not automatically replace a healthy
chat's current provider. After connecting, reselect the model in `/model` to
apply it to the current conversation.

When the TUI launches:

- **Home screen** — product mark, engagement panel, composer (text input)
  centred on the screen.
- **Status bar** — active model, mode, working directory, cost/token counters
  (when enabled).
- **Header** — product name, configured scope, and optional objective.
- **Conversation** — Messenger framing by default: your messages align right,
  answers align left. Saved alternative styles remain effective.

Type a message and press **Enter** to send it. The engine streams its response
token-by-token. Tool calls appear as bordered cards showing the command or edit,
output, and exit code (controlled by `richToolCards` setting). The transcript
auto-scrolls to newest content. **PageUp** / **PageDown** (or **Ctrl+Up** /
**Ctrl+Down**) scrolls through history.

The context meter follows the selected conversation's latest reported sample,
not cumulative billing tokens. A known window gives a percentage; an unmeasured
sample stays unknown. Known usage without a window shows tokens used.
Token and dollar costs are estimates for the conversation and its workers.

Use `/copy` (aliases `/export` and `/dump`) while idle to export the complete
public conversation, not just visible transcript rows. It saves private local
JSON even when copying fails. An OSC52 notice means the content was sent to the
terminal clipboard; it does not verify clipboard contents.

Long assistant and reasoning bodies use bounded head-and-tail display previews.
Older rows may use plain text when newer rows consume the rich-Markdown budget;
newlines and code indentation remain intact. Display truncation does not change
canonical messages or the full-message copy/export actions.

Open `/findings` and select a finding to read its persisted impact assessment
alongside the finding's evidence. Observed effects, conditional chains, and
missing evidence remain distinct. An absent or malformed assessment is explicitly
unavailable; selecting a finding does not generate an assessment or start a model turn.

## Screens

| Screen | Command | Description |
|--------|---------|-------------|
| Chat | `/chat` | Main conversation transcript and composer |
| Launcher | `/launcher`, `/run`, `/home` | Engagement control pane (start new scans, browse sessions) |
| Operations | `/ops`, `/runs` | Active and recent operation status |
| Doctor | `/doctor` | Runtime and configuration diagnostics |
| History | `/history` | Scan history from the database (completed scans, not chat sessions) |
| Findings | `/findings`, `/finds` | Session finding list with filtering; select a row to open full detail |
| Replay | Command palette: **Open latest replay** | Event-level turn replay for a completed scan |
| Settings | `/settings`, `/config`, `/prefs` | Console display settings (persist across sessions) |
| Theme | `/theme`, `/themes` | Colour theme live preview |
| Model | `/model`, `/models` | Select the current audit's model, worker-role overrides and single-model policy |
| Sessions | `/sessions` | Switch open native sessions or resume saved conversations |
| Communications | Command palette: **Open agent comms**, or **Ctrl+T** from chat | Agent activity and messages |
| Hackstore | `/hackstore`, `/store`, `/market`, `/marketplace` | Extension marketplace |
| Connect | `/connect` | API-key and provider-subscription connections |
| Usage | `/usage`, `/cost`, `/tokens` | Token, cost, and context-window usage for this chat session |
| Scope | `/scope` | Current engagement scope view |
| Onboarding | `/onboard` | Reopen guided setup without replacing the current audit |
| Keybindings | `/keybindings`, `/keys`, `/keymap` | Inspect or rebind supported keyboard shortcuts |
| Back | `/back` | Navigate to the previous screen |

### Slash commands

Every command is available as `/command` in the composer. Type `/` to open
the command menu. The readline console supports a subset (noted below).
The source-only Node fallback advertises only `/help`, `/status`, `/tools`,
`/clear`, and `/exit`; other registered commands explain that they need the TUI.
Unknown slash input stays local and is never sent to the model.

| Command | Aliases | Category | Readline? |
|---------|---------|----------|-----------|
| `/help` | `/?`, `/commands` | info | ✓ |
| `/capabilities` | `/caps` | info | — |
| `/status` | — | info | ✓ |
| `/tools` | — | info | ✓ |
| `/clear` | — | session | ✓ |
| `/new-chat` | `/new` | navigation | — |
| `/onboard` | — | navigation | — |
| `/history` | — | session | — |
| `/findings` | `/finds` | session | — |
| `/fix` | — | session | — |
| `/copy` | `/export`, `/dump` | session | — |
| `/sessions` | — | session | — |
| `/explain` | `/eli5` | session | — |
| `/model` | `/models` | session | — |
| `/chat` | — | navigation | — |
| `/launcher` | `/run`, `/home` | navigation | — |
| `/ops` | `/runs` | navigation | — |
| `/hackstore` | `/store`, `/market`, `/marketplace` | navigation | — |
| `/connect` | — | navigation | — |
| `/usage` | `/cost`, `/tokens` | navigation | — |
| `/back` | — | navigation | — |
| `/scope` | — | navigation | — |
| `/exit` | `/quit` | system | ✓ |
| `/feedback` | — | system | — |
| `/settings` | `/config`, `/prefs` | system | — |
| `/theme` | `/themes` | system | — |
| `/keybindings` | `/keys`, `/keymap` | system | — |
| `/doctor` | — | system | — |

### Verified source fixes and draft PRs

No environment configuration is required for normal TUI use. `/fix` opens a
compact setup form with a valid Git root suggested from the selected audit's
local source checkout, scan target, or current workspace. Enter your regression
command, review the exact repository and command in the execution-approval card,
then approve that run. Merely answering the setup form authorizes nothing.
Repository package scripts are never silently selected or executed.

After approval, the command is saved as a suggestion for this canonical project
in owner-only `~/.0/source-fix/` state. Checked-in project `.0` files are never
read as execution grants. Every run still shows the actual command for approval.
Optional `ZERO_FIX_REPO` and `ZERO_FIX_TEST_COMMAND` overrides prefill the form
for callers that already know their inputs; they do not bypass TUI approval.

Use `/fix <finding-id>`, or `/fix` to choose a saved finding from this conversation.
The finding-detail **Fix** action requests the same workflow. A finding must have
a reproduced verdict, a scoped source file, and a machine-executable code-only
`verificationSpec`; live-target behavioural specs are not supported here.

The existing source-fix runner creates a detached, isolated Git worktree,
generates a source-only patch, verifies the vulnerable source contract before
patching and its semantic transition after patching, and runs your regression
command. The transcript shows the **actual Git diff**, command, exit status,
test output, rationale, retained candidate path, and review-record path.
The original checkout is not modified. Missing inputs, dirty checkouts,
unreproduced findings and failed candidates remain visible and cannot publish.
Use `/fix cancel` to request cancellation; verified local candidates are preserved.

After reviewing a successful candidate, `/fix publish <finding-id>` shows the
remote, unique source-fix branch, base branch, title, diff, and test result.
The approval picker defaults to **Keep local — do not push**. Only deliberately
choosing **Push branch and create draft PR** permits publication. Before pushing,
0 re-checks the reviewed diff and regression command, and refuses a changed
candidate, changed remote, or remote base different from the verified baseline.
The original checkout can contain new unrelated work: publication commits only
the verified source change in the isolated candidate. GitHub CLI authentication
is required; no templates or unverified suggestions are published.

In the Findings screen, **f** opens this same setup and execution approval in the
owning audit chat. After generation, use `/fix publish <finding-id>` there.
**Esc** declines a setup question or approval without executing the command.
Cancellation/failure preserves the
candidate and any already-created branch; if a push already completed, its
remote branch may remain. A retained candidate and its JSON review record
remain on disk when the console exits; review or remove them deliberately.

### Command palette

Open with **Ctrl+P** (or **Ctrl+K**) from any screen. Type to filter commands;
each entry shows its title, keybinding or category, and description. Press
**Enter** to run.

The palette is available on every screen. On the home screen it lists workspace
commands and navigation destinations; on the chat screen it lists session
actions, settings toggles, and screen switches.

### Model picker

For connected providers, `/model` opens the priced core and includes the active
model even when it is a custom deployment. With an empty query, **Tab**
switches between this curated list and the full catalog. Any nonblank
model/provider query searches the full catalog, regardless of the Tab setting.
**↑ / ↓** moves the highlight, **Enter** selects, **Ctrl+U** clears the query,
and **Esc** clears a query before going back.

Models with the same ID remain separate provider rows. Moving between them
shows each provider's own price and context window. Provider labels describe
catalog entries; configured credentials determine runtime routing.


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
assignments. **Ctrl+R** retries Codex account model discovery when available.
Role overrides select models for work that actually runs; they do not start workers.
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

### Navigation

| Shortcut | Action |
|----------|--------|
| **Ctrl+P** / **Ctrl+K** | Open command palette (all screens) |
| **Ctrl+R** | Toggle folded tool/reasoning steps; click a tool card to disclose retained output beyond its 20-line preview |
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

### Autonomy mode

| Shortcut | Action |
|----------|--------|
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

### Sessions and resume

```bash
# Open the session picker
0 console --resume

# Resume a specific session by id (or unique prefix)
0 console --resume a1b2c3d4

# Resume the most recent session
0 console --continue
```

In the TUI, `/sessions` opens one picker with **Open** and **Saved** groups.
Open rows show native-session status and unread activity; saved rows show preview
text, relative age (`12s`, `5m`, `3h`, `2d`, `6w`), model, and message count.
An open session linked to a saved conversation appears only once.

The browser starts with open sessions and **this project's** saved conversations.
**Tab** includes all projects without clearing your query. Type or paste to search,
**Ctrl+U** clears the query, and **Enter** switches to the highlighted open session
or resumes a saved conversation. Switching open sessions preserves their native
runtime and transcript without replaying history or cancelling workers.

**New** (or **Ctrl+N**) creates an independent session. Highlight an open session
and use **Close** (or **Ctrl+W**) to request its closure; these controls appear only
when the workspace supports their actions. Closing is distinct from deleting history.

To remove a saved transcript, press **Delete** twice on the same session;
**Esc** cancels. Typing `d` searches rather than deleting. A failed deletion
leaves the session visible and reports the error.
A session that cannot be loaded reports the failure in the browser rather than
closing the console.
Open rows cannot delete saved history. Linked saved conversations and other
protected transcripts remain guarded until their native session has closed.

`--continue` chooses the most recent saved transcript across projects; it is not
the same as the picker's initial current-project filter. Bare `--resume` needs
the TUI picker; use an explicit ID outside it.

Resuming a saved conversation restores context, not running workers or session-only
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
| `/sessions` | Switch open sessions without cancelling workers, or browse saved conversations |
| `/history` | Review scan history from the database |

`/clear` is not `/new` and is not saved-transcript deletion. Open sessions have
separate conversation/runtime ownership; selecting another session does not
stop background work. Use `/sessions` to browse saved history.

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

## Saved transcripts and replay

Saved conversations and scan replays are separate views of past work:

| Aspect | **Saved conversation** | **Replay** |
|--------|------------------------|------------|
| Scope | One stored native conversation | Any persisted scan (by scan ID or database) |
| Content | Conversation history restored to chat from native messages | Event-level turn timeline: stages, tool calls, model output |
| Access | `/sessions` → select a saved conversation | Command palette (**Ctrl+P** / **Ctrl+K**) → **Open latest replay** |
| Data source | Saved conversation store (`~/.0/console-sessions`) | Scan database (`--db-path` or `~/.0/0.db`) |
| Use case | Resume a prior conversation with its stored context | Inspect the events that a scan actually persisted |

Selecting a saved conversation from `/sessions` reopens the chat around its
stored transcript. To open a replay, press **Ctrl+P** or **Ctrl+K** to open the
command palette, choose **Open latest replay**, then browse scan runs, select
one, and step through its recorded events.

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
the configured Cloud host's `/api/cli-feedback` endpoint when an explicit
`ZERO_CLOUD_TOKEN` authorizes it. `ZERO_CLOUD_HOST` can select an
operator-provided deployment.

The feedback payload body contains: `message`, `timestamp`, `version`, `model`,
`mode`. The body is capped at 64 KB; request timeout is 5 seconds. Failure to
submit never blocks the session.

### Automatic problem reports

Problem reporting defaults to `ask`, so a diagnostic is reviewed before
submission. Saved reporting choices remain effective. Tool and runtime failures
can produce a diagnostic independently of manually staged messages; it does not
upload `~/.0/feedback.md`. Diagnostic content never broadens with analytics
consent: error categories and runtime metadata are bounded, while error
messages, captured output and full local review detail stay on this machine.

An operator-provisioned `ZERO_SENTRY_DSN` selects a dedicated HTTPS Sentry
envelope destination for diagnostics only. Sentry also receives at most 32
allowlisted built-in package-relative stack locations, with no absolute paths,
function names, source lines or arbitrary stack text. Events identify the
actual CLI version, the existing embedded build SHA when available, and the
development/production channel; explicit `NODE_ENV` takes precedence over the
source/bundled default. There is no built-in DSN or dashboard DSN fallback.

Without that DSN, diagnostics keep the existing HTTPS feedback route, whose
first-party Cloud delivery goes to Slack/email rather than Sentry. Manual
`/feedback` submissions are not rerouted to Sentry.

Open `/feedback` → **Problem-report preferences** to choose `off`, `ask`, or
`automatic`. This global preference cannot be overridden by a project.
Explicit saved opt-outs and environment opt-outs remain effective. `off` and
`ask` require individual confirmation before diagnostic transmission;
`automatic` permits submission after the first-report consent flow.
Without a configured Sentry DSN, Cloud token or HTTPS feedback endpoint,
automatic reports remain local and submission is reported as unavailable.

### Secret scanning

When entering an API key through the TUI's credential prompt (`/connect`), the
entered value is stored directly to
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
console-specific controls include transcript density and style, theme, and
cost display toggles.

Agent tasks use compact tabs above a shared, full-width chat transcript. Switching
tasks keeps the shared composer and conversation state; there are no left or
right sidebar visibility settings. The operator-global **Execution profile**
setting applies on the next launch and cannot be changed by project settings.

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

## Agents in chat
- Each delegated worker appears below the composer. Tasks and live activity
  wrap separately within the available space; only remaining overflow is clipped.
  Selecting a row uses the same transcript and composer as Main, with a separate
  draft per conversation.
- Additional workers remain reachable with `+N more · Next task`. Completed
  output stays available; `Ctrl+PageUp` / `Ctrl+PageDown` cycles active workers
  with Main.
- Selection and browsing do not message or stop a worker. Type a follow-up to
  message the selected active/parked worker. A finished one-shot worker returns
  its result to Main as untrusted context. `Ctrl+Shift+Home` returns to Main.
- Use **Open agent comms** in the command palette, or **Ctrl+T** from chat, for
  the separate observed peer-message history; no agent roster window is required.

The activity row sits above the composer and names the current main action or
agent count. The bottom status area keeps measured context, model, mode, Git and
enabled usage indicators. A focused worker uses its own model, provider and
measured context. Partial updates retain the latest sample; missing measurements
stay unknown rather than borrowing Main's count.

The unabridged plan stays in the main transcript.

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