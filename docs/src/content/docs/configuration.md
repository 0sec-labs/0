---
title: Configuration
description: Runtime modes, scan modes, depth settings, state paths, env vars, feature flags, and diagnostics.
---

> Status: 2026-09-19. Living document.

Configure command options, provider credentials, console settings and run storage
separately. Each section below gives its precedence rules.

## Runtime modes

`--runtime` selects the LLM backend.

| Runtime | Flag | Description |
|---------|------|-------------|
| `api` | `--runtime api` | Direct HTTP calls to a configured provider. |
| `claude` | `--runtime claude` | Spawns the authenticated Claude Code CLI; capabilities depend on the workflow and installed CLI. |
| `codex` | `--runtime codex` | Uses the Codex CLI for source review. For live target scans, routes to the direct ChatGPT Codex provider when `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN` is configured. |
| `gemini` | `--runtime gemini` | Spawns the authenticated Gemini CLI for source-oriented work. |
| `auto` | `--runtime auto` | Resolve an available runtime for the selected workflow. Default for `scan`, `review`, and `audit`. |
| `ollama` | `--runtime ollama` | Local Ollama `/api/chat` runtime, exposed by `review`; requires an available tool-calling model. |

### API runtime

The `api` runtime makes direct HTTP calls to a provider. Set one of:

```bash
# API-key providers can be exported normally.
export OPENROUTER_API_KEY="sk-or-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export AZURE_OPENAI_API_KEY="..."
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="..."
export Z_AI_API_KEY="..."
export KIMI_API_KEY="..."
export QWEN_API_KEY="..."
export XAI_API_KEY="..."
export OPENCODE_API_KEY="..."

# `ZERO_*` names begin with a digit; pass a Codex token with env.
env ZERO_CHATGPT_OAUTH_REFRESH_TOKEN="..." 0 doctor
```

See [API Keys](/api-keys/) for the full provider list, default models, and
credential priority.

For Azure, configure an explicit endpoint and deployment. Ambient API routing
can also read an Azure-backed `~/.codex/config.toml`; explicit provider pinning
and fallback routes require an environment endpoint. For the Responses API,
include `/openai/v1`. See [Azure setup](/api-keys/#azure-openai-configuration)
for precedence and a complete pinned example.

For ChatGPT Codex, run `codex login`, then either rely on
`~/.codex/auth.json` or supply an explicit access/refresh token with `env`.
Codex auth leads the ambient API credential order, but an explicit provider pin
or recognized model with its own configured provider can override it.

Use `--runtime api` when you specifically want these HTTP provider rules rather
than workflow-dependent `auto` selection. Model selection is not runtime
selection: `--model` alone does not require `auto` to choose the API runtime.

### CLI runtimes (claude, codex, gemini)

These spawn the respective CLI as a subprocess — install and authenticate it
first:

```bash
# Claude Code CLI
npm i -g @anthropic-ai/claude-code

# Codex CLI
npm i -g @openai/codex

# Gemini CLI
npm i -g @google/gemini-cli
```

Then use them:

```bash
0 scan --target https://api.example.com/chat --scope ./scope.json --runtime claude
0 review ./my-repo --runtime codex --depth deep
```

The Codex CLI isn't used as a live-target wrapper. For live scans on a Codex
subscription, configure the direct provider instead:

```bash
env ZERO_CHATGPT_OAUTH_REFRESH_TOKEN="..." \
  0 scan --target https://example.com --scope ./scope.json --runtime codex
```

### Codex runtime parity matrix

Codex routing depends on the entry point and credentials. Source review can use
the authenticated CLI; live-target subscription calls use the direct provider.

| Surface                                | Command                                                      | Supported via direct provider |
|----------------------------------------|--------------------------------------------------------------|--------------------------------|
| Web / URL scan                         | `0 scan --target https://example.com --scope ./scope.json --runtime codex` | yes |
| npm package audit                      | `0 audit lodash --ecosystem npm --runtime codex`        | yes                            |
| PyPI package audit                     | `0 audit requests --ecosystem pypi --runtime codex`     | yes                            |
| crates.io package audit                | `0 audit tokio --ecosystem cargo --runtime codex`       | yes                            |
| OCI image audit                        | `0 audit nginx:1.25 --ecosystem oci --runtime codex`    | yes                            |
| Default source-code review             | `0 review ./repo --runtime codex`                       | yes                            |
| Linux kernel review                    | `0 review ./linux --profile linux-kernel --runtime codex` | yes                          |
| C/C++ library review                   | `0 review ./lib --profile c-library --runtime codex`    | yes                            |

Managed runtime availability follows the separate [0cloud deployment policy](/roadmap/#0cloud).

### Local Ollama source review

Start your Ollama server and provision a tool-calling model before running:

```bash
OLLAMA_HOST=http://localhost:11434 \
  0 review ./authorized-repo --runtime ollama --model gemma4:27b
```

The runtime uses `--model`, then `ZERO_OLLAMA_MODEL`, then `gemma4:27b`.
`OLLAMA_HOST` defaults to `http://localhost:11434`. A remote host sends source
context to that server; a local model is not a guarantee that every tool or
optional integration stays offline.

## Scan modes

`--mode` controls what kind of target is scanned.

| Mode | Description |
|------|-------------|
| `deep` | Agentic LLM/AI-target probing; select explicitly for an HTTP endpoint that should not use web mode. |
| `probe` | Lightweight surface scan — recon and fingerprinting without deep exploitation. |
| `web` | Shell-first web application assessment. The automatic mode for HTTP/HTTPS targets passed to `scan`. |
| `mcp` | Scan MCP (Model Context Protocol) servers for tool poisoning and schema abuse. **Default** when the target starts with `mcp://`. |
| `http_audit` | Worker-driven authenticated HTTP assessment using operator-provided `ZERO_TARGET_*` configuration. |

```bash
# LLM API assessment: select deep mode explicitly.
0 scan --target https://api.example.com/chat --scope ./scope.json --mode deep

# Web application assessment.
0 scan --target https://example.com --scope ./scope.json --mode web
```

## Depth settings

`--depth` controls how thorough the scan is.

| Depth | Use |
|-------|-----|
| `quick` | Shorter investigation budget |
| `default` | Normal workflow budget |
| `deep` | Larger investigation budget |

These are not fixed test-case counts or guaranteed completion times. See
[Budget Management](/budget-management/) for the budget mechanisms.

```bash
0 scan --target https://api.example.com/chat --scope ./scope.json --mode deep --depth quick
0 audit express --depth deep
0 review ./my-repo --depth deep --runtime claude
```

## Output formats

Set with `--format`:

| Format | Description |
|--------|-------------|
| `terminal` | Human-readable terminal summary |
| `html` | Rich browser report saved to a temporary file |
| `pdf` | Printable report saved to a temporary file |
| `json` | Machine-readable JSON output for pipelines |
| `sarif` | SARIF format for the GitHub Security tab |
| `md` / `markdown` | Human-readable Markdown report (`md` is the CLI alias) |

For GitHub Code Scanning, run the CLI with `--format sarif` and upload the
result with `github/codeql-action/upload-sarif`. A dedicated 0 composite
action has not shipped; use the complete [GitHub CI](/ci/github-action/) workflow.

## Diff-aware review

Review only changed files against a base branch — handy in CI to skip scanning
the whole codebase on every PR:

```bash
0 review ./my-repo --diff-base origin/main --changed-only
```

## Verbose output

`--verbose` shows detailed agent output:

```bash
0 scan --target https://api.example.com/chat --scope ./scope.json --verbose
```

## Operational logs

Enable metadata-only operational records on stderr:

```bash
env ZERO_LOG_FORMAT=json 0 review ./my-repo
```

Each NDJSON record contains `timestamp`, `level`, `service`, `event`, and
allowlisted lifecycle or cost metadata. Prompts, responses, reasoning, tool
arguments/results, finding evidence, summaries and raw error text are excluded
from these records. Credential-like values in retained identifiers are redacted.

This adds records alongside existing stderr diagnostics; it does not make all
stderr output JSON or replace `--format`. Stdout and the `ZERO_EVENT_*` cloud
relay protocol are unchanged. Unset `ZERO_LOG_FORMAT` to disable the sink;
only the `json` format enables it. These operational log records are not uploaded
automatically; collect stderr through your runner or container logging pipeline.

## Analytics and training data

**Full sharing is the default for new installations.** Onboarding and
`/settings` → **Analytics and training data** disclose the categories and let
you choose a lower tier:

| Tier | Collected records |
| --- | --- |
| `off` | No analytics or training uploads |
| `usage` | Feature/finding counters, error categories, turns, duration and available cost totals; no tool content |
| `commands` | Usage plus credential-scrubbed tool arguments/results and submitted executable-plugin files |
| `full` | Commands plus credential-scrubbed scope entries and findings |

Training records support model improvement and security research. **Ordinary
content is retained, including emails, URLs, identifiers and opaque strings.**
Only recognized credentials are scrubbed: authentication headers, known API-key
and token shapes, private keys, credential-named fields and URL user/password
information. Structured JSON is decoded before scrubbing nested values.
This is best-effort credential protection, **not anonymization or a guarantee
that every secret is recognized**. Requests are authenticated; random
install/session identifiers do not make them anonymous. The v1 `*Redacted`
field names refer to credential scrubbing, not broad PII removal. This pipeline
does not introduce a separate conversation-transcript record.

The setting is operator-global; project settings cannot broaden it. Saved
opt-outs survive upgrades. An explicit `ZERO_ANALYTICS_LEVEL` limits the
effective tier, even if the saved setting is higher. `ZERO_OFFLINE`,
`ZERO_NO_TELEMETRY`, or `DO_NOT_TRACK` forces analytics off when set to a
non-empty value other than `0`, `false`, or `no`. For example:

```bash
env ZERO_ANALYTICS_LEVEL=off 0 console
env ZERO_ANALYTICS_LEVEL=usage 0 scan https://authorized.example
```

Sending requires Cloud credentials and uses `/api/cli-analytics` on the
configured Cloud host. Run `0 auth login` again if an older CLI grant lacks
`analytics:submit`. Organization policy can further exclude training records;
usage is stored separately. A `202` response reports accepted and excluded
counts, not unconditional training-data acceptance.

Tool arguments, tool results and submitted source each have a **262,144-byte
UTF-8 limit after redaction**. Accepted content is not cut to a short preview.
Other metadata strings retain a 4,000-character cap, including any overflow
marker; this does not reduce the tool/code content allowance.
POSTs contain at most 100 records and 1,048,576 encoded JSON bytes, including
escaping and the batch wrapper. An oversized field or single encoded record
is skipped, not truncated or retried: stderr and
`~/.0/analytics-outcomes.log` report only the field, byte counts, limit and
timestamp. Post-redaction payloads attempted over HTTP are recorded in
`~/.0/analytics-sent.log`; that log is not proof of server acceptance.

Consent is checked again before every POST. Lowering it discards disallowed
pending records; re-enabling does not replay those discarded records. Skipping
the onboarding choice leaves the current setting unchanged. Choosing `off`
there also disables automatic problem reports; choosing a higher analytics
tier does not re-enable an existing problem-report opt-out.

## Feedback delivery

`/feedback <message>` is local-only and appends to
`~/.0/feedback.md`. After `0 auth login`, staged feedback defaults to the
authenticated `cloud.0.security/api/cli-feedback` receiver; it attributes the
message to the signed-in organization and delivers through the existing
team-feedback channel. Re-authenticate after upgrading if an older CLI token
lacks the `feedback:submit` scope.

Use `/feedback submit <message>` to save locally and inspect the exact endpoint,
JSON body, headers, and secret-shaped-content warnings. Only a second
`/feedback send` transmits that exact staged payload; `/feedback cancel` drops
the pending network action while retaining the local file.

`ZERO_FEEDBACK_URL` overrides the cloud receiver for a self-hosted HTTPS relay:

```bash
env ZERO_FEEDBACK_URL="https://feedback.example.org/v1/feedback" 0 console
```

Do **not** place an incoming Slack webhook URL directly in the CLI environment:
it is a bearer secret and does not accept 0's feedback wire schema.
`ZERO_OFFLINE`, `ZERO_NO_TELEMETRY`, and `DO_NOT_TRACK` block every submission
before any connection is made.

### Automatic problem reports

The console's **Problem reports** setting defaults to `automatic`. After a tool
or runtime problem, it constructs a limited diagnostic summary and attempts to
send it through the feedback transport. This is separate from operational
stderr logs and manually staged `/feedback` messages.

Use `/feedback` → **Problem-report preferences** to select `off`, `ask`, or
`automatic`. The preference is global to this computer; project settings cannot
override it. An explicit saved opt-out remains off after upgrading.
`ZERO_OFFLINE`, `ZERO_NO_TELEMETRY`, and `DO_NOT_TRACK` still block submission.

Delivery requires Cloud authentication or a configured HTTPS feedback endpoint.
Without an available transport, the automatic report is saved locally and the
console reports that submission is unavailable. Choosing `ask` requires review
and confirmation before sending; `off` disables automatic submission.
At analytics levels `off` or `usage`, the report contains bounded diagnostic
categories. At `commands` or `full` (the new-install analytics default), it may
also include a scrubbed tool name, error message, stack and captured failure
output, capped at 8,192 UTF-8 bytes. Recognized credentials and emails are
redacted and home usernames masked; this is best-effort, not a guarantee that
all sensitive content is removed. Reports do not upload the feedback file or
enable update checks.

## Permissioned run contributions

Run contributions use a separate, explicit enrollment. Analytics preferences,
problem reports, Cloud login and paid credits don't enroll a run.

`ZERO_RUN_CONTRIBUTION_CONFIG` points to an absolute, operator-owned JSON file
with private permissions (`0600`). It contains `orgId`, the authoritative
`receipt`, the matching `policy`, and an optional absolute `spoolDir`. Use the
configuration issued for your enrollment. A locally written receipt doesn't
grant permission at the collector.

The client validates this configuration before capture and rechecks the receipt
before upload. The existing `ZERO_OFFLINE`, `ZERO_NO_TELEMETRY` and `DO_NOT_TRACK`
switches take precedence. Without valid enrollment, it creates no contribution
spool or contribution upload. Collection doesn't change target scope or tool
authorization.

The spool defaults to `run-contributions` under the configured state directory.
Receipt content flags control model, tool and scope capture; redaction isn't
anonymization. Versioned manifests and ordered transitions retain missing usage
as unknown, and interrupted attempts aren't treated as successful runs.
Upload uses the existing Cloud credential loader and resumes from the collector's
acknowledged chunk index. The policy and receipt bound local retention.

This is a candidate integration contract, not production enrollment or a grant
of model-training, licensing or public-distribution rights.

## Update checks

Startup behavior depends on the **saved global** `updatePolicy`:

- `off`: no startup update request.
- `notify`: check asynchronously and report a newer release.
- `automatic`: check and, if needed, run the canonical installer **before**
  proceeding. This can delay startup; the current process keeps its running
  version, so restart to use the installed binary.

If no global policy is saved, the built-in setting default alone does not grant
automatic installation. The compatibility path checks asynchronously only when
`ZERO_UPDATE_CHECK=1`. All startup paths require a TTY and honor `CI`,
`ZERO_NO_UPDATE_CHECK` and `ZERO_OFFLINE` (nonempty values other than `0` or
`false` suppress the check). Project settings cannot enable updates.

```bash
env ZERO_UPDATE_CHECK=1 0 --version
env ZERO_NO_UPDATE_CHECK=1 0 console
```

Release checks use GitHub's API and cache results for 24 hours. Automatic
installation downloads through the repository installer; repeated attempts for
the same tag are bounded. Windows automatic installation is unavailable.
Use `/settings` or the global config to set policy intentionally.

## State directory

Most per-user state is under `~/.0`. Scan execution state is run-local,
while console settings and credentials are user-level. Project overrides,
Codex authentication, temporary reports, and the `~/.0cloud` credential copy
have separate paths; moving one directory does not relocate every subsystem.

Fresh scans default to `~/.0/runs/<scan-id>/state.db`. `--db-path` overrides
`ZERO_DB_PATH`; `ZERO_RUN_DIR` controls the run directory. Managed workers can
bind the local run ID through `ZERO_CLOUD_SCAN_ID`. The legacy `0sec.db` is a
resume fallback, not the default database for every new scan.

| Path | Purpose |
|------|---------|
| `tui-settings.json` | Console display settings (global layer). |
| `credentials.json` | Stored API-key credentials (console credential store). |
| `cloud.env` | Cloud auth token (`ZERO_CLOUD_TOKEN`) and optional host (`ZERO_CLOUD_HOST`). Written by `0 auth login`. |
| `console-sessions/` | Transcript JSON files, one per session. Owner-only (`0600` file, `0700` dir). |
| `feedback.md` | Locally staged feedback entries. |

<span id="0sec-config--console-settings-cli"></span>
## `0 config` — console settings CLI

The `0 config` command lets you inspect, export, and import the console
display settings without launching the TUI.

```bash
0 config show        # effective config, each key labelled default/global/project
0 config export      # write effective config as shareable JSON to stdout
0 config export ./my-settings.json
0 config import ./my-settings.json          # merge into global layer (default)
0 config import ./my-settings.json --global  # explicit global (same as default)
0 config import ./my-settings.json --project # merge into project override
```

### Configuration layers (precedence)

Settings are resolved per-key, highest-priority first:

1. **Project** — `<cwd>/.0/tui-settings.json` overrides individual keys.
2. **Global** — `~/.0/tui-settings.json` is the per-user base.
3. **Default** — built-in defaults shown below.

Operator-global settings are exceptions: a project cannot override analytics,
problem-report consent, update policy, onboarding state, or authorization for
development-engine updates.

On load, settings are normalized against the schema: unknown keys are dropped
and invalid values reset to defaults. Saving writes the normalized object.
Persisted `messenger` framing migrates to `bubble`; new sessions default to
`minimal`. Other saved styles and explicit off settings remain effective.

### Security-gated import

`0 config import` refuses to change security-sensitive settings, including
`allowModelSelfExtension`, `allowDevSourceUpdates`, `allowSubagentPeerMessaging`
and `allowSubagentOperatorMessaging`, unless `--yes` is passed. The specific
changes are printed so you know what was rejected.

### Settings reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `showStatusBar` | boolean | `true` | Bottom bar with model, working directory, git state and counters |
| `showComposerHints` | boolean | `true` | Keyboard-hint line under the input |
| `showLogo` | boolean | `true` | Product mark on an empty transcript |
| `showLeftSidebar` | boolean | `false` | Recent sessions and this run's findings; hidden on narrow terminals |
| `showRightSidebar` | boolean | `false` | Live agents, activity, plan and findings; hidden until enabled and on narrow terminals |
| `showObjective` | boolean | `true` | Header objective derived from the first message |
| `showScope` | boolean | `true` | Header include/exclude scope; absent and explicitly empty scope remain distinct |
| `density` | `comfortable`, `compact` | `comfortable` | Transcript spacing |
| `composerStyle` | `border`, `rail`, `plain` | `border` | Input frame |
| `transcriptStyle` | `minimal`, `bubble`, `rail`, `plain`, `compact`, `document` | `minimal` | Minimal transcript by default; alternative framed and document layouts |
| `roleLabelStyle` | `full`, `short`, `glyph`, `off` | `full` | Speaker label treatment |
| `toolCardStyle` | `compact`, `rail`, `inline`, `hidden` | `compact` | Successful tool/subagent-card treatment; failures always show |
| `richToolCards` | boolean | `true` | Render shell and edit results as rich cards |
| `transcriptDetail` | `expanded`, `collapsed` | `expanded` | Whether successful reasoning and tool steps are folded |
| `showRuntimeNotices` | boolean | `true` | Surface runtime stdout/stderr as transcript notices |
| `showTurnSummary` | boolean | `false` | Per-turn tool-call and token summary |
| `showSubagents` | boolean | `true` | List active subagents while workers run |
| `showTimestamps` | boolean | `false` | Relative timestamps on transcript entries |
| `allowSubagentPeerMessaging` | boolean | `true` | Allow direct sibling-subagent messages |
| `allowSubagentOperatorMessaging` | boolean | `true` | Allow sanitized child-to-operator transcript messages |
| `allowModelSelfExtension` | boolean | `true` | Enable sandboxed model self-extension for new sessions, subject to role and capability gates |
| `allowDevSourceUpdates` | boolean | `false` | Globally authorize trusted development-engine replacement between turns; requires `ZERO_DEV_SOURCE_ROOT` |
| `theme` | built-in or installed theme ID | `slate` | Colour palette; installed themes live in `~/.0/themes` |
| `showTokenUsage` | boolean | `true` | Per-turn input/output token line |
| `showCost` | boolean | `true` | Estimated dollar cost, per turn and in the status bar |
| `showContextMeter` | boolean | `true` | Context-usage bar; missing context-window data displays unavailable |
| `modelDisplay` | `statusbar`, `message`, `off` | `statusbar` | Where the model name appears |
| `logoAnimation` | animation name or `off` | `glitch` | Intro or idle logo effect |
| `reduceMotion` | boolean | `false` | Disable decorative animations |

Additional practical settings include `composerSuggestions: true`,
`mouseSupport: true`, `busyInputMode: "steer"`, `autoCompaction: true`,
`compactionThreshold: "80%"`, and `elapsedTimer: "left"`. Finder-lens
`autoEvolveFinderLenses` and `autoPromoteFinderLenses` both default to `false`.
Operator-global `analyticsLevel` defaults to `"full"`, `diagnosticReporting`
to `"automatic"`, and `updatePolicy` to `"automatic"`. Use `0 config show`
for the full effective inventory and each value's source; see the privacy
sections above before sharing a configuration.

### Self-extension and workspace trust

Self-extension defaults on for new sessions, including the desktop checkbox.
Explicit or saved `false` stays off. Workspace-trusted ESM requires a separate,
acknowledged grant scoped to the canonical workspace.

Autonomy, self-extension and host trust are separate controls. Desktop retains
unscoped-standard and scoped-YOLO authorization.
See [self-evolution](/improvement-plane/) for details.

### Development engine updates

This is separate from sandboxed self-extension. Enable **Development engine
updates** in global settings only for a trusted source checkout. Project settings
cannot grant it. Loading that code runs with the console process's host
permissions, including credential access.

Start a new development console from the built checkout:

```bash
./scripts/0dev.sh console
```

The `0dev` launcher targets `https://dev.cloud.0.security` and sets
`ZERO_DEV_SOURCE_ROOT` to its checkout. Cloud login, reads and logout use
`~/.0/dev/cloud.env`; production `~/.0/cloud.env` and private CLI
`~/.0cloud/credentials.json` are not changed. Inherited Cloud tokens are ignored.
HOME, BYOK credentials and other console settings remain unchanged.

Normal `0` keeps its production default. `--host` takes precedence over
`ZERO_CLOUD_HOST` for login. Restart existing sessions to use the new launcher;
they cannot acquire its source-update environment retroactively.

When enabled, changed Core source is built into an immutable generation and
activated at an idle boundary. Conversation, scope decisions, task progress and
usage survive the handoff. A build or checkpoint rejection leaves the current
engine active. Disabling the setting stops later replacements; it does not
revert an already-active generation.

The terminal/UI shell, injected provider and MCP clients, and shared package
dependencies are not reloaded. Changes to those still require a rebuild and a
new process. See [development engine replacement](/improvement-plane/#development-engine-replacement).

## Console credential store

In the terminal UI, `/connect` offers **0cloud → Sign in**,
**Use my own API key**, and a separate **Provider subscription** section.
Cloud uses browser authorization; ChatGPT Codex uses device sign-in and its
own auth file. Local and direct-provider workflows need no Cloud account.

Keys are stored in plaintext at `~/.0/credentials.json` by default, with
`0600` file and `0700` directory permissions. Nonblank environment credentials win.
See [credential storage](/api-keys/#console-credential-store).

In the BYOK `/model` picker, **Tab** opens the full catalog and a nonblank query
searches it from either view. Check credentials and account access.
Treat missing price data as unknown. See [Model picker](/console/#model-picker).
Model and role-model selections apply to an existing audit while idle or after
its active turn finishes. A normal `/connect` choice prepares the next chat;
after connecting a new provider, reselect its model to apply it live. See
[Model picker](/console/#model-picker).

## Cloud authentication

`0 auth` manages organization credentials:

| Subcommand | Description |
|------------|-------------|
| `0 auth login` | Opens a browser at `<host>/cli-auth?session=…`, polls for a scoped token, and persists it to `~/.0/cloud.env`. |
| `0 auth login --token <value>` | Manual credential path for self-hosted or recovery use. |
| `0 auth login --host <url>` | Override the default cloud host (`https://cloud.0.security`). |
| `0 auth logout` | Deletes `~/.0/cloud.env` and `~/.0cloud/credentials.json`. |
| `0 auth status` | Loads credentials and checks the authenticated inference-account endpoint. Unsupported account data can still remain unavailable. |

Credentials are resolved in this order (first match wins):

1. **Environment variables** — `ZERO_CLOUD_TOKEN` (required) + `ZERO_CLOUD_HOST`
   (optional, defaults to `https://cloud.0.security`).
2. **File** — `~/.0/cloud.env` (line-by-line `KEY=VALUE`). Keep the file
   `chmod 600`; the loader warns on other permissions but does not refuse it.
   Contains `ZERO_CLOUD_TOKEN=…` and optionally `ZERO_CLOUD_HOST=…`.

The token is never printed. `0 auth status` echoes the host on success; on
auth failure it surfaces the status code + path, never the token or Authorization
header.

<a id="hosted-configuration-draft"></a>

### Hosted configuration

See [Cloud setup and availability](/getting-started/#hosted-models).
Hosted inference uses the selected organization's service catalog and account,
without configuring each supplier separately. Authentication, model listing
and request admission are separate checks; none establishes managed execution.
The CLI provides `0 login` (alias of `0 auth login`),
`0 models [--json]` and `0 balance [--json]`, and defaults to
`https://cloud.0.security`. Older releases use `https://cloud.0.ai`.
Check `0 login --help` and use the operator-provided host for testing.

An environment `ZERO_CLOUD_TOKEN` takes precedence over `cloud.env` and uses the
environment host or default. Without that token, the saved token is used with
the file's host, then `ZERO_CLOUD_HOST` if the file omits a host, then the default.

| Setting or action | Behavior |
| --- | --- |
| `--runtime api` | Uses the HTTP runtime; `hosted` is a provider, not a new runtime name. |
| `ZERO_SELECTED_PROVIDER=hosted` | Pins hosted inference instead of ambient BYOK credentials. |
| `ZERO_MODEL` or `--model` | Must match an alias returned by `0 models`. The service catalog determines wire protocol and output ceiling. |
| No provider pin | Configured BYOK providers are considered before hosted credentials. Logging in doesn't replace them. |
| No explicit hosted model | Selects the first service catalog entry. Pin an alias for a repeatable route. |
| `ZERO_LLM_FALLBACK` | Explicit backup chain for eligible failures. No automatic hosted accounting escape or hidden gateway substitution. |
| `0 auth status` | Checks authenticated account access, not model entitlement, schema compatibility, spend eligibility or paid-flow readiness. |
| `0 auth logout` | Removes local credential files; it doesn't revoke an issued token or clear a token exported in the environment. |

Revoke issued credentials through the dashboard's session controls.
The gateway checks membership and scopes; a CLI credential doesn't authorize
purchases.

`0 balance --json` returns the validated `credits-v1` account snapshot or
`null` for unsupported account data. Free credit, overlapping subscription
windows and prepaid credit are separate sources, not one additive balance.
Unavailable amounts are not zero. Use a compatible CLI and service revision;
a successful login or catalog response does not prove their account schemas
match. See [account interpretation](/api-keys/#hosted-inference).

Local cost ceilings are separate from the hosted ledger. Cancellation can still
incur charges. See [billing and errors](/api-keys/#charging-and-interrupted-requests).

## Provider selection and model routing

### Explicit provider pinning

`ZERO_SELECTED_PROVIDER` selects the primary provider for a run or chat.
It accepts `openrouter`, `anthropic`, `openai`, `azure`, `deepseek`,
`chatgpt-codex`, `z-ai`, `kimi`, `qwen`, `xai`, `opencode`, `copilot`,
`google` and `hosted`. Set an explicit `ZERO_MODEL` alongside an environment
selection, except when hosted inference should choose from its service catalog.
The provider must have its own credentials. A separately configured explicit
model can use a different route, such as cross-model verification.

`ZERO_FORCE_PROVIDER` is an unconditional benchmark override. Setting it and
`ZERO_SELECTED_PROVIDER` to different values is an error.

```bash
env ZERO_SELECTED_PROVIDER=deepseek ZERO_MODEL=deepseek-flash \
  0 scan --target https://example.com --scope ./scope.json --mode web --runtime api
```

### Per-model routing

When no explicit pin is set, `--model <id>` (or `ZERO_MODEL`) routes the call to
the provider whose credentials are available. The runtime maps model prefixes:

| Model prefix / identifier | Provider |
|---|---|
| `openrouter/*` | OpenRouter |
| `glm-*`, `z-ai/*`, IDs containing `glm` | Z.ai (GLM) |
| `qwen*`, exact `deepseek-v4-flash-0731` | Alibaba Qwen / Token Plan |
| `k3*`, `kimi*` | Moonshot Kimi |
| `grok*`, `xai/*`, `x-ai/*` | xAI Grok |
| `opencode/*`, `muse-spark*`, `mimo*`, `ling*`, `big-pickle`, `nemotron*`, `minimax*` | OpenCode Zen |
| `copilot/*` | GitHub Copilot |
| `gemini*`, `google/*` | Google Gemini Code Assist |
| `claude*`, `anthropic/*`, IDs containing `sonnet`, `opus` or `haiku` | Anthropic, then OpenRouter when Anthropic auth is absent |
| `gpt-*`, `o1`–`o4` | ChatGPT Codex when configured, otherwise OpenAI |
| Exact `deepseek-flash`, `deepseek-v4-flash` | Direct DeepSeek |
| Recognized Azure Foundry deployment IDs | Azure; takes precedence over family routing |

Natural-provider routing requires that provider's credentials. If no matching
credential is available, selection falls through to ambient priority; an
unrecognized model is not proof of a supported route. Pin a provider to fail
early rather than accidentally send a model ID to another account.
Arbitrary Azure deployment names need an explicit Azure pin; pricing aliases
do not configure provider routing. See [API Keys](/api-keys/#model-routing)
for the Azure/DeepSeek identifier collision and wire protocols.

### Multi-model role routing

The interactive console can use different models for different child-agent
roles. This is not the same as provider failover, and it does not automatically
enable an independent verification stage.

For a concrete multi-family setup, connect one gateway account that serves both
models, then launch the console:

```bash
export OPENROUTER_API_KEY="sk-or-..."
env ZERO_SELECTED_PROVIDER=openrouter \
  ZERO_MODEL=anthropic/claude-sonnet-4.6 0 console
```

In `/model`:

1. Select the parent model with **Enter**.
2. Use **Ctrl+Left/Right** to target `verify` (or another role), search for an
   account-supported model such as `openai/gpt-4o`, and press **Enter**.
3. Use **Ctrl+S** to turn single-model policy off if it is on. When on, all
   role assignments are inactive and children use the parent model.
4. **Ctrl+Backspace** clears the targeted role's assignment so it inherits the
   parent again.

Role choices apply to the current audit while idle or after the active turn
finishes. They affect subsequently created child runtimes, not an already
running child's in-flight request. Forked children retain the parent's resolved
provider, endpoint and credentials and do not inherit its cross-provider
fallback chain. Choose models served by **that same account/route**; connecting
another provider does not turn a role assignment into a cross-account router.
Hosted children must use IDs in the hosted service catalog.

Embedded API callers can supply `RuntimeConfig.agentModels`, `singleModel`,
and `autoRoute`. The `"auto"` role sentinel or `autoRoute` widens the model
selection guard to credential-reachable choices, but does not change the
inherited transport boundary. The stock console has no `--agent-model` or
`--auto-route` flag. Independently constructed runtimes (for example, a workflow's
cross-model refuter) use the per-model provider routing above instead.

### Ambient credential priority

When no model is specified enough to route to one provider, the runtime checks env
vars in this priority order:

1. `ZERO_CHATGPT_ACCESS_TOKEN` / `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN` → ChatGPT Codex
2. `DEEPSEEK_API_KEY` → DeepSeek
3. `OPENROUTER_API_KEY` → OpenRouter
4. `AZURE_OPENAI_API_KEY` → Azure OpenAI
5. `OPENAI_API_KEY` → OpenAI
6. `Z_AI_API_KEY` → Z.ai GLM
7. `KIMI_API_KEY` → Moonshot Kimi
8. `QWEN_API_KEY` → Alibaba Qwen
9. `XAI_API_KEY` → xAI Grok
10. `OPENCODE_API_KEY` → OpenCode Zen
11. `ZERO_COPILOT_GITHUB_TOKEN` → GitHub Copilot
12. `ZERO_GEMINI_ACCESS_TOKEN` / `ZERO_GEMINI_OAUTH_REFRESH_TOKEN` → Google Gemini Code Assist
13. `ANTHROPIC_API_KEY` → Anthropic
14. Configured Cloud credentials → hosted inference
15. No usable credential → Anthropic (reports missing credentials at runtime)

### Provider failover

`ZERO_LLM_FALLBACK` configures an ordered chain of backup providers when the
primary exhausts its retry budget or hits a plan quota limit:

```bash
env ZERO_LLM_FALLBACK=deepseek:deepseek-flash,azure:gpt-5-deployment \
  0 review ./authorized-repo --runtime api
```

Each entry is `<providerId>:<model>`, comma-separated. Eligible retry-budget
exhaustion or recognized plan quota exhaustion advances to the next usable
route. Missing credentials (and missing endpoint configuration for Azure) skip
that entry. Failover changes the recipient of model context and the account
that pays; it is not a free retry or an automatic hosted-ledger escape.
Hosted unknown-outcome requests are not replayed; see
[interrupted requests](/api-keys/#charging-and-interrupted-requests).

## Session persistence

The console stores transcripts as one JSON file per session in
`console-sessions/` under the [state directory](#state-directory), so you can
close it and resume later. Files are owner-only (`0600` file, `0700` dir),
filtered per working directory, capped at the 20 most recent.

A transcript is the full engagement record — every operator prompt, model reply,
and tool call with its result. That means **target hostnames, approved scope,
untriaged findings, and raw request/response bodies**, which can include cookies,
bearer tokens, and anything a tool echoed.

Secrets are not scrubbed. A partial scrub over free-form output would corrupt
resume evidence. Transcripts are not encrypted. Protection is filesystem
permissions. Stored on local disk only.

## Static analyzer selection

Source reviews and package source scans use Foxguard by default for pre-agent
static leads. Set `ZERO_STATIC=semgrep` to route them through Semgrep instead;
`--changed-only` narrowing works with either. Dependency advisory checks (`npm
audit`, OSV, OCI inventory) run separately for package targets regardless.

The static runner uses `foxguard` from `PATH` when provisioned. Otherwise it
launches `npx --yes foxguard@v0.14.0`, which requires Node/npm and access to the
package and release download on first use. Native v1 JSON reports and legacy
finding arrays are accepted. Launch failures, invalid reports, and scanner
error exits are surfaced as failures; the default path does not silently invoke
Semgrep or report a failed scan as clean. Exit 1 with a valid report means
findings were detected.
Scans run from the requested source root, so an explicitly selected installed
package is not skipped just because an ancestor directory is `node_modules`.
Finding paths are resolved back to that source root.

This pre-agent scan is separate from `ZERO_FEATURE_MULTIMODAL=1`, the opt-in
white-box cross-validation layer. Cross-validation and `kernel variant-hunt`
require an installed Foxguard binary (`--foxguard` can override it for
variant hunting). Static hits and scanner agreement remain leads, not proof
of exploitability.

```bash
env ZERO_STATIC=semgrep 0 review ./repo --depth quick
```

Semgrep is required only when explicitly selected. Legacy report fields named
`semgrepFindings` and the `SemgrepFinding` type describe the existing wire shape,
not a runtime dependency. FoxGuard cross-validation remains opt-in; it does not
turn scanner agreement into independent exploit verification. The historical
ablation baseline is still unmeasured, so equal coverage or a speed advantage
over Semgrep is not established by the integration alone.

## Stateful authorization and fix verification

Foxguard findings are static leads. Three complementary paths test authorization
state changes, find incomplete application fixes, and replay a PoC with a negative
control.

### Stateful authorization

The agent tool `access_control_workflow` observes a JSON resource as its owner,
executes up to ten ordered requests as a distinct actor, then observes it again.
It uses the existing per-identity sessions, cookie jars, scope checks, attribution,
and rate limiter without switching the active identity.

```json
{
  "allow_mutation": true,
  "owner_identity": "owner",
  "actor_identity": "other-tenant",
  "observation_url": "https://app.example/api/items/42",
  "observation_json_pointer": "/marker",
  "expected_state": "fresh-disposable-test-marker",
  "steps": [
    {
      "method": "PATCH",
      "url": "https://app.example/api/items/42",
      "body": "{\"marker\":\"fresh-disposable-test-marker\"}"
    }
  ]
}
```

Use only disposable resources covered by the engagement. There is no automatic
cleanup or rollback. Every step is validated before requests start; actor requests
cannot override authentication headers. Both owner observations must succeed and
contain complete JSON. `confirmed` requires an exact string-marker transition,
not merely HTTP 2xx. An unchanged state is `no_change`; incomplete observations,
transport failures, or an unexpected state change are `inconclusive`. Choose a
unique marker to reduce ambiguity from concurrent legitimate activity.

### Application incomplete-fix hunting

```bash
0 review ./repo --fix-commit <sha> --variants-only
0 review ./repo --fix-commit <sha>
```

`--variants-only` emits deterministic JSON without model calls. The second command
feeds candidates into the normal review pipeline as low-confidence `SeedFinding`
leads. The hunter compares the fix commit to its first parent, extracts added
authorization/validation checks, and searches current tracked working-tree files
in the affected directories for similar unguarded functions.

Extraction is heuristic for JavaScript, TypeScript, and Python—not a complete AST,
control-flow, or exploitability analysis. Other languages are explicitly skipped.
The default bound is 200 related files and 50 candidates; source files over 1 MiB
are skipped with an error entry. Guarded siblings are excluded. This is separate
from Foxguard's kernel `variant-hunt`.

### Reproduction bundles

Create a plan with exactly one of `finding_path` or an inline `finding`, explicit
source roots, and file allowlists. Finding JSON uses the same schema as `verify
--finding`, including `timestamp`. Plan-relative paths resolve beside the plan.

```json
{
  "version": 1,
  "finding_path": "./finding.json",
  "vulnerable_root": "./before",
  "patched_root": "./after",
  "files": {
    "vulnerable": ["app.cjs"],
    "patched": ["app.cjs"]
  },
  "runner": "local"
}
```

```bash
0 verify --create-bundle ./plan.json --out ./bundle
0 verify --bundle ./bundle --runner local --out ./replay-results
```

Creation never executes PoC steps. Replay requires an explicit runner, validates
SHA-256 content, sizes, paths, and compatibility before execution, and uses fresh
vulnerable/patched workspaces. Output directories must be empty. Symlinks,
traversal paths, source/output overlap, and dirty output are rejected. Snapshot
content is bounded to 256 MiB; plans and manifests to 4 MiB.

`confirmed` (exit 0) requires reproduction on the vulnerable side and a genuine
assertion failure on a successfully executed patched side. Reproduction on both
sides is `inconclusive` (exit 1); failure to reproduce the vulnerable side is
`not_reproduced` (exit 1). A crash, failed setup, timeout, or missing command is
`error` (exit 3), never proof of a fix. PoC processes must exit zero on both sides
and express the exploit condition through assertions. Results include both sides;
`vulnerable.json`, `patched.json`, and `result.json` are retained with artifacts.

Local replay executes trusted PoC code **on the host**. It checks the Node/engine
version and platform/architecture; external tools and services remain outside the
snapshot. Digests establish file integrity, while authorship requires separate
review. Check bundles for secrets before execution or sharing, including source,
finding metadata, and process output.

For Docker, set `"runner": "docker"` in the plan and provide
`docker_shell_image` / `docker_http_image` for the action types used, each as a full
`repository@sha256:<64-hex-digest>` reference. Docker action images must also be
digest-pinned. Replay binds the images to those references and uses the existing
Docker isolation controls; provision images locally first. HTTP replay additionally
requires `--scope <scope.json>` and an explicit `--docker-network <name>`.
Local replay supports shell actions; Docker supports shell, container, and scoped
HTTP actions. Notes are not executable bundle steps.
Shell `cwd` is relative to the mounted workspace; absolute paths and traversal
outside it are rejected before a container is launched.

The Docker replay CI workflow runs real containers.
It covers isolation, writable workspaces, relative cwd and escape rejection,
pinned-image execution, timeout cleanup, scoped HTTP, and vulnerable/patched
negative controls. To run the same checks against the default local Docker daemon:

```bash
pnpm --filter @0/core... -r build
node scripts/smoke-docker-replay.mjs
```

The smoke script pulls its fixture images, resolves their digests, and removes
its test containers, network, and temporary workspaces afterward.

## Feature flags

[Features](/features/) is the canonical flag inventory. Do not copy a flag
from an archival experiment and assume the current engine reads it.
`ZERO_FEATURE_TRIAGE_MEMORIES` and `ZERO_FEATURE_DEBATE` are not current
standalone toggles.

Use `env` for names beginning with `ZERO_`; POSIX shells cannot export names
beginning with a digit. Enabling a capability does not supply its credentials,
scope, toolchain, or other prerequisites.

### Opt-in Jev assistance

Jev is a bounded advisory evaluator, not a chat-provider replacement. No feature
is enabled merely by having a key. `ZERO_JEV_FEATURES` explicitly opts selected
workflows into sending evaluation state to the selected provider:
`browser`, `memory`, `dedupe`, `redteam`, and `kernel` (comma-separated).
Probabilities do not authorize actions, establish an exploit, or replace
deterministic verification. Unknown feature/provider names are configuration
errors.

| `ZERO_JEV_PROVIDER` | Required credential / endpoint | Route |
| --- | --- | --- |
| `vercel` (default when enabled) | `AI_GATEWAY_API_KEY` | Vercel AI Gateway evaluation model `typesafe-ai/jev` |
| `typesafe` | `TYPESAFE_API_KEY` | `https://api.typesafe.ai/v1/systemone`, model `jev-1.13.0` |
| `cloud` | `ZERO_JEV_CLOUD_TOKEN` and `ZERO_JEV_CLOUD_URL` | Explicit evaluation endpoint; HTTPS except loopback HTTP |
| `classifier` | No key; **kernel only** | External `https://classifier.dev` fast-tier classification |

The shared adapter accepts `kernel`/`classifier`, but that acceptance is not a
wired kernel-command prepass. Current production consumers are the browser
helper, agentic-scan memory/deduplication, and the indirect-prompt-injection
red-team path. Enable only a feature your chosen workflow actually calls;
putting `memory,dedupe` on a source `review` does not add those agentic-scan
consumers to the source pipeline.

For example, opt only the browser helper into the direct Typesafe route:

```bash
export TYPESAFE_API_KEY="..."
env ZERO_JEV_FEATURES=browser ZERO_JEV_PROVIDER=typesafe \
  ZERO_JEV_BROWSER_READ_ONLY_URLS=https://authorized.example/docs \
  0 console --scope ./scope.json
```

`ZERO_JEV_BROWSER_READ_ONLY_URLS` is a comma-separated list of exact normalized
URLs required for assisted navigation, in addition to explicit scope. Jev never
replaces target authorization; absent scope or approved URLs makes assistance
hand off without navigation. The classifier adapter is networked even though
it needs no credential. A normal `ZERO_CLOUD_TOKEN` is not automatically used
as the Jev token. See [Jev budgets](/budget-management/#jev-advisory-budgets)
for per-instance request, timeout, classification and estimated-cost limits.

## Runtime resilience and retries

The runtime layers that keep a provider failure from silently corrupting a scan:

| Variable | Default | Purpose |
|----------|---------|---------|
| `ZERO_LLM_STREAM_IDLE_TIMEOUT_MS` | `120000` | SSE byte-idle watchdog; aborts a stream that stops emitting bytes. |
| `ZERO_LLM_STREAM_EVENT_IDLE_TIMEOUT_MS` | `240000` | SSE event-idle watchdog; keep-alive comments and whitespace alone do not reset it. |
| `ZERO_LLM_MAX_RETRIES` | `6` | Max retries for retryable statuses (429 + transient 5xx), with exponential backoff. |
| `ZERO_LLM_MAX_RETRY_WAIT_MS` | `60000` | Cumulative backoff cap (ms) for the generic retry loop. |
| `ZERO_LLM_429_MAX_RETRIES` | `12` | Max retries for 429 rate-limits specifically. Falls back to `ZERO_LLM_MAX_RETRIES` when unset. |
| `ZERO_LLM_429_MAX_RETRY_WAIT_MS` | `300000` | Cumulative 429 backoff cap (ms). Falls back to `ZERO_LLM_MAX_RETRY_WAIT_MS` when unset. Bound server-guided `Retry-After` waits. |
| `ZERO_SUPPRESS_PROVIDER_STARTUP_LOG` | unset | Set to `1` to suppress the "Provider: …" startup banner line. |

These watchdogs are separate from the request's overall timeout, which remains
armed while streaming. `scan --timeout` defaults to `30000` ms;
`review` and `audit --timeout` default to `600000` ms. Retry counts mean retries
after the initial request. Generic retryable HTTP statuses are 429, 500, 502,
503 and 504; eligible transport failures also use bounded retries.
`Retry-After` / `retry-after-ms` waits are capped at 120 seconds per wait, with
the cumulative caps above and the request's cancellation/timeout still applying.
An explicit operator cancellation is terminal, not a reason to fail over.

Hosted transport errors and HTTP 5xx have unknown charge outcomes and are not
automatically replayed. Hosted 429 is eligible only when the server marks it
`x-0sec-retry-safe: 1`. Consult usage records before manually resubmitting.

Auth errors (**401/403**) are never retried: the agent loop exits immediately,
`warnings[]` carries the provider error, and the run is marked failed, never
clean "0 findings". Package audits add a per-file circuit breaker (3
identical-signature failures abort the rest).

### Provider failover chain

The [provider failover](#provider-failover) configuration is opt-in. It advances
only on eligible failure paths, never because a model answer was unhelpful.
Keep backup credentials and account limits intentional.

## Execution backends

Backend selection is command-specific. It does not provide global console isolation:

- Source evolution defaults to Docker. Set `backend: "smolvm"` and a local
  `imageArchive` in its config to use qualified Linux microVM workers. See
  [Improvement Plane](/improvement-plane/#local-smolvm-backend) for prerequisites,
  image provisioning, restrictions, and real qualification commands.
- Deterministic replay selects `--runner local|docker|qemu`; Docker replay
  networking follows the explicit scope and `--docker-network` rules above.
- Agentic exploit execution requires `--container` or `--exec-script`; it does
  not default to running exploit commands on the host.

Selecting smolvm for evolution does not move general console/PTY tools, replay,
or exploit executors into that VM. Provision toolbox dependencies before offline
evaluation; candidate execution does not bootstrap packages over the network.

## Cost ceiling

Set a soft estimated-model-cost stop per scan, audit, or review. On a ceiling
breach, 0 preserves partial findings, exits with code `4`, and emits
`exit_reason: "cost_ceiling_exceeded"` in the optional machine-readable result
line. `--cost-ceiling` overrides `ZERO_COST_CEILING_USD`; neither supplied means
no dollar ceiling. In-flight/concurrent calls can overshoot. This is not an
invoice cap, hosted-credit reservation, infrastructure budget, or guarantee that
every external service is metered. See [Budget Management](/budget-management/).

```bash
env ZERO_COST_CEILING_USD=5 \
  0 scan --target https://example.com --scope ./scope.json --mode web

0 audit lodash --cost-ceiling 2
0 review ./my-repo --cost-ceiling 10
```

## Cloud sink

Stream findings and the final report to an orchestration layer:

```bash
env \
  ZERO_CLOUD_SINK=https://api.example.com \
  ZERO_CLOUD_SCAN_ID=scan_123 \
  ZERO_CLOUD_TOKEN=secret-token \
  0 scan --target https://example.com --scope ./scope.json --mode web
```

0 then POSTs each finding as `{ "finding": ... }` and the final report as
`{ "report": ..., "final": true }` to
`${ZERO_CLOUD_SINK}/scans/${ZERO_CLOUD_SCAN_ID}/findings`. Set
`ZERO_FEATURE_CLOUD_SINK=0` to disable even when the env vars are present.

Optional: `ZERO_CLOUD_ORG_ID` sends the `X-0sec-Org-Id` header for
organization-scoped sinks.

## Machine-readable result line

Set `ZERO_EMIT_RESULT_LINE=1` to print one final `ZERO_RESULT=...` JSON line with
success/failure, exit code and reason, target type, finding counts, and estimated
cost/token usage. Useful for wrappers, CI parsers, and the cloud path.

## Example: opt-in verification gates

After enabling gates, inspect their execution records and evidence before accepting a finding.

```bash
env \
  ZERO_FEATURE_CONSENSUS_VERIFY=1 \
  ZERO_FEATURE_REACHABILITY_GATE=1 \
  ZERO_FEATURE_POV_GATE=1 \
  ZERO_FEATURE_MULTIMODAL=1 \
  0 scan --target https://example.com --scope ./scope.json --mode web --depth deep
```

## Example: web search

```bash
env ZERO_FEATURE_WEB_SEARCH=1 \
  0 scan --target https://example.com --scope ./scope.json --mode web
```