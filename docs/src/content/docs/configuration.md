---
title: Configuration
description: Execution profile, runtime modes, state directory, 0 config, environment variables, flags, telemetry and updates.
---

Settings, credentials and run state are separate. This page covers settings and the environment. Provider keys and model routing are on [Models and keys](/models/).

## Quick start

```bash
0 config show                    # effective settings, each labelled default, global or project
0 config export ./settings.json  # write the effective settings as JSON
0 config import ./settings.json  # merge into the global layer
0 doctor upgrade                        # install the latest release
```

Resolution order, highest first: command-line flag, environment variable, project settings, global settings, built-in default.

## Execution profile

`executionProfile` chooses where the whole harness runs. It does not choose the model.

| Value | Meaning |
| --- | --- |
| `local` | Default. Helpers, browser and shell run on your computer. |
| `smolvm` | Everything runs inside a local Kali VM (the workbench). |

Set up the workbench, then start the app:

```bash
0 doctor workbench setup --image /absolute/path/0-workbench-linux-arm64.tar --provider chatgpt-codex
0 doctor workbench status --json
0
```

Setup downloads the pinned VM runtime and approves a digest-pinned local image archive. It never trusts a mutable registry tag. The native runtime is qualified on Apple Silicon macOS.

| `setup` option | Default | Effect |
| --- | --- | --- |
| `--image <archive>` | saved approved image | Local OCI or Docker archive to approve (limit 8 GiB). |
| `--state <directory>` | `~/.0/workbench` | VM state, image approval and guest data. |
| `--workspace <directory>` | current directory per launch | Host folder mounted at `/workspace` in the guest. |
| `--provider <id>` | none | Grant a host provider account to the guest. Repeat to grant several. `0 doctor workbench providers` lists the IDs. |
| `--no-github` | | Revoke the GitHub token grant. Forwarding a GitHub token is refused. |
| `--cpus`, `--memory <MiB>`, `--storage <GiB>` | `2`, `4096`, `20` | Guest resources. |
| `--sandbox-image <reference=archive>` | none | Approve a `repository@sha256:<64 hex>` image for isolated container actions. Repeat for more. |

Change it later:

```bash
0 doctor workbench configure --provider openai,anthropic --no-github   # replace grants
0 doctor workbench configure --provider none                           # revoke provider grants
0 doctor workbench configure --current-workspace                       # drop a fixed workspace
0 doctor workbench configure --clear-sandbox-images
0 doctor workbench disable                                             # return to local; keeps image and state
```

Rules:

- Choices live in `~/.0/workbench.json` (owner-only). Credential values are never stored there.
- The guest sees only granted providers. Host HOME, SSH keys, Docker sockets and other environment variables are not forwarded.
- If the runtime, image or admission check fails, launch is refused. It never falls back to the host.
- Project settings cannot change the profile. A change applies at the next launch.
- `0 doctor workbench status` is read-only and never downloads anything.

## Runtime modes

`--runtime` chooses the model backend for a command.

| Runtime | Meaning |
| --- | --- |
| `auto` | Default. Picks an available runtime for the workflow. |
| `api` | Direct HTTPS calls to a configured provider. Required for `--provider` pinning and `--cyber-access-program`. |
| `claude` | Runs the signed-in Claude Code CLI. |
| `codex` | Managed source review keeps the native API tool boundary. Live scans use the ChatGPT Codex provider when you are signed in. |
| `gemini` | Runs the signed-in Gemini CLI. |
| `ollama` | Local Ollama for source review. Needs a tool-calling model. |

`--model` does not select a runtime. Pass `--runtime api` to use the provider rules in [Models and keys](/models/) instead of workflow-based selection.

The `claude`, `codex` and `gemini` runtimes need that CLI installed and signed in (`npm i -g @anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`):

```bash
0 scan source ./my-repo --runtime claude --depth deep
```

Ollama:

```bash
OLLAMA_HOST=http://localhost:11434 0 scan source ./repo --runtime ollama --model gemma4:27b
```

The model is `--model`, then `ZERO_OLLAMA_MODEL`, then `gemma4:27b`. A remote `OLLAMA_HOST` receives your source context.

## Common flags

The full list is in the [CLI reference](/commands/). These change behavior most.

| Flag | Values | Notes |
| --- | --- | --- |
| `--depth` | `quick`, `default`, `deep` | Sets the investigation budget, not a test count. See [Costs and budgets](/budgets/). |
| `--format` | `terminal`, `json`, `md`, `html`, `sarif`, `pdf` | `html` and `pdf` are saved to a temporary file. |
| `--diff-base <ref>` | git ref | Diff-aware source review. Add `--changed-only` to limit leads to changed files. |
| `--cost-ceiling <usd>` | number | Stop when estimated cost passes the limit. |
| `--verbose` | | Detailed agent output. |
| `--timeout <ms>` | number | Per-request timeout. |

```bash
0 scan source ./my-repo --diff-base origin/main --changed-only --format sarif
```

For web scans, `--mode` is `deep`, `probe`, `web`, `mcp` or `http_audit`. Targets starting with `mcp://` default to `mcp`. See [Scan web and APIs](/scan-web/).

## State directory

Per-user state lives in `~/.0`.

| Path | Purpose |
| --- | --- |
| `runs/<scan-id>/state.db` | Findings and state for one run. |
| `tui-settings.json` | Global settings (legacy filename). |
| `credentials.json` | Stored API keys, mode `0600`. |
| `console-sessions/` | One transcript JSON per thread. |
| `engines.json` | Registered remote computers. See [Remote computers](/engines/). |
| `workbench.json` | Workbench choices. |
| `last-update-check` | Cache for update checks. |
| `feedback.md` | Locally staged feedback. |
| `diagnostics/pending/` | Crash reports waiting for your review, mode `0600`. At most 10, oldest removed first. |

Project settings live in `<project>/.0/tui-settings.json`.

Overrides: `--db-path` over `ZERO_DB_PATH` sets the database file. `ZERO_RUN_DIR` sets the run directory. Moving one path does not move the others.

Thread transcripts hold target hostnames, scope, findings and raw request and response bodies, including any cookies or tokens a tool echoed. They are not scrubbed or encrypted. File permissions (`0600` files, `0700` directory) are the only protection.

## The `0 config` command

`0 config` reads and writes computer settings. Appearance is set in the browser app under Settings.

```bash
0 config show
0 config get <key>
0 config set <key> <value> [--project] [--yes]
0 config reset [keys...] --yes
0 config export [file] [--global]
0 config import <file> [--global | --project] [--yes]
```

Layers, highest first: project, global, default. Unknown keys are dropped and invalid values reset to the default when settings load.

Some settings are operator-global, and a project can never change them: `analyticsLevel`, `diagnosticReporting`, `updatePolicy`, onboarding state, development source updates and `executionProfile`.

`0 config import` refuses to change security-sensitive settings unless you pass `--yes`: `executionProfile`, `allowModelSelfExtension`, `allowDevSourceUpdates`, `allowSubagentPeerMessaging` and `allowSubagentOperatorMessaging`. It prints each rejected change.

Two conversation settings are worth knowing. `titleInstructions` (up to 500 characters) guides automatic thread titles, for example a language or style. `archiveIdleDays` (0 = off, 365 at most, global only) archives saved threads idle for that many days when the app starts.

### Development source updates

Enable **Development source updates** (`allowDevSourceUpdates`) only for a source checkout you trust. It reloads changed computer code between turns, and that code runs with the full access of the console process, including your credentials. Start a development console from the checkout with `./scripts/0dev.sh web`. A build failure stops launch. For frontend work, run `pnpm dev`. See [Self-improvement](/self-improvement/).

## Environment variables

Set them inline, for example `env ZERO_LOG_FORMAT=json 0 scan source ./repo`.

### Output and results

| Variable | Effect |
| --- | --- |
| `ZERO_LOG_FORMAT=json` | NDJSON operational records on stderr. Lifecycle and cost metadata only, no prompts, responses, tool data or finding evidence. Not uploaded. |
| `ZERO_EMIT_RESULT_LINE=1` | Print a final `ZERO_RESULT=...` JSON line with status, exit code, finding counts and estimated cost. For wrappers and CI. |
| `ZERO_COST_CEILING_USD` | Default for `--cost-ceiling`. |
| `ZERO_DB_PATH`, `ZERO_RUN_DIR` | Database file and run directory. |
| `ZERO_SUPPRESS_PROVIDER_STARTUP_LOG=1` | Hide the `Provider:` startup line. |
| `ZERO_RUNTIME_TRACE=1` | Print the runtime implementation, provider and model to stderr. |

### Retries and timeouts

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZERO_LLM_STREAM_IDLE_TIMEOUT_MS` | `120000` | Abort a stream that stops sending bytes. |
| `ZERO_LLM_STREAM_EVENT_IDLE_TIMEOUT_MS` | `240000` | Abort a stream that sends only keep-alives. |
| `ZERO_LLM_MAX_RETRIES` | `6` | Retries for 429 and transient 5xx, with backoff. |
| `ZERO_LLM_MAX_RETRY_WAIT_MS` | `60000` | Total backoff cap. |
| `ZERO_LLM_429_MAX_RETRIES` | `12` | Retries for rate limits. |
| `ZERO_LLM_429_MAX_RETRY_WAIT_MS` | `300000` | Total backoff cap for rate limits. |

Auth errors (401, 403) are never retried. The run fails with the provider error instead of reporting a clean "0 findings". Cancelling a run stops it for good.

### Parallel agents

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZERO_SUBAGENT_MAX_FANOUT` | `1024` | Helpers requested in one batch. |
| `ZERO_SUBAGENT_MAX_WORKERS` | `4096` | Queued and active workers in one audit tree. |
| `ZERO_SUBAGENT_CONCURRENCY` | `32` | Helpers running at once per batch. |
| `ZERO_SUBAGENT_MAX_DEPTH` | `8` | Nested subagent depth. |

Values are positive integers. Restart the computer after changing them. Provider rate limits and the shared budget still apply.

These limits also exist as settings: `subagentConcurrency` (1-128, default 32), `subagentMaxDepth` (1-16, default 8) and `subagentFanOut` (1-4096, default 1024). The `ZERO_SUBAGENT_*` variables win over them, and a project can only lower them.

### Feature gates

Opt-in verification and research features read `ZERO_FEATURE_*` variables:

```bash
env ZERO_FEATURE_CONSENSUS_VERIFY=1 ZERO_FEATURE_REACHABILITY_GATE=1 ZERO_FEATURE_POV_GATE=1 \
  0 scan web --target https://example.com --scope ./scope.json --depth deep
```

Other gates: `ZERO_FEATURE_MULTIMODAL` and `ZERO_FEATURE_WEB_SEARCH`. Enabling a gate does not supply its credentials or tools. Check the execution records before you accept a finding that a gate produced.

### Dashboard

Set these on the process that runs `0 web`.

| Variable | Default | Effect |
| --- | --- | --- |
| `ZERO_CSP` | `enforce` | Content-Security-Policy mode: `enforce`, `report-only` or `off`. Leave it on. The page embeds the control token. |
| `ZERO_SELF_EDIT` | off | `1` enables self-edit preview routes. The preview backend runs agent-edited code as your user and is not a sandbox. |

### Deprecated names

The old name still works. 0 copies it to the new name and prints one notice on stderr. Set `ZERO_NO_DEPRECATION_WARNINGS=1` to silence it.

| Deprecated | Use |
| --- | --- |
| `ZERO_CHATGPT_AUTH_FILE` | `ZERO_CODEX_AUTH_JSON_PATH` |
| `ZERO_WPSCAN_API_TOKEN` | `WPSCAN_API_TOKEN` |
| `ZERO_SKIP_PROVIDER_BANNER` | `ZERO_SUPPRESS_PROVIDER_STARTUP_LOG` |

Renamed flags keep hidden aliases: `--backend` is now `--engine`, `--backends-config` is `--engines-config`, `--session` is `--chat`, and `mcp-server --workflows` is `--automations`. 0 reads `~/.0/backends.json` only when `engines.json` does not exist.

## Telemetry

Three separate switches. Each is global to your computer. Project settings cannot widen them.

| Setting | Default | Values |
| --- | --- | --- |
| **Usage metrics** (`analyticsLevel`) | `usage` | `off`, `usage` |
| **Problem reports** (`diagnosticReporting`) | `ask` | `off`, `ask`, `automatic` |
| **Updates** (`updatePolicy`) | `automatic` | `off`, `notify`, `automatic` |

`usage` sends pseudonymous counts, timing, cost totals and error categories. It never sends code, scope, tool arguments or results, or finding content. Random install and session IDs are not anonymity. Saved opt-outs are kept across upgrades.

### Crash reports

The terminal and the browser app are two interfaces over one 0security process, so they share one crash reporter and one destination. A report carries a `surface` tag (`cli` or `web`) and nothing else about which interface produced it. It is captured in two places:

- **Computer process.** A last-resort handler for uncaught exceptions and unhandled rejections. It never changes what happens on a crash: the error is still printed to stderr and the exit code is still `1`. The exit waits at most two seconds for reporting.
- **Browser app.** An error boundary and window error listeners. The page sends only a closed error category and locations inside the built app bundle. The computer validates them again before building the report. Repeated errors are collapsed to one report per minute, at most five per page session.

Your `diagnosticReporting` choice decides what happens to a report:

| Value | What happens |
| --- | --- |
| `off` | The report is dropped. Nothing is stored or sent. |
| `ask` | The report is stored locally in `~/.0/diagnostics/pending/`. Nothing is sent until you preview the exact body in the browser app (Settings, Feedback) and confirm. |
| `automatic` | The report is sent once, with a short timeout. A failure is ignored. |

A report contains the error class (for example `TypeError`), the 0security version and release channel, Node version, platform, CPU architecture, the surface, the name of the command that was running (only from the built-in command list, never arguments) and scrubbed locations inside 0security's own code. It never contains error messages, command output, file paths, targets, hostnames, findings, source code or credentials. `DO_NOT_TRACK`, `ZERO_NO_TELEMETRY` and `ZERO_OFFLINE` drop reports in every mode, so does an organization-wide block, and so does a build with no destination configured. Usage metrics consent never widens crash reports.

`0 doctor` prints one line when reports are waiting. `0 doctor --discard-reports` deletes them without sending anything. `ZERO_SENTRY_DSN` overrides the release destination for your own HTTPS project, and an empty value disables it.

Problem reports are limited diagnostic summaries. With `ask`, you review the exact destination and body before anything is sent. With `automatic`, they send after you accept the first-report consent flow. Without a configured destination they stay local. They never include source code, credentials or your feedback file.

These variables force everything off when set to a non-empty value other than `0` or `false`: `DO_NOT_TRACK`, `ZERO_NO_TELEMETRY`, `ZERO_OFFLINE`. `ZERO_ANALYTICS_LEVEL=off` also turns usage sharing off.

```bash
env ZERO_ANALYTICS_LEVEL=off 0
```

Change them in the browser app under Settings, Helpers. Every payload that is sent over HTTP is also recorded in `~/.0/analytics-sent.log`.

`/feedback <message>` in a thread saves a note locally in `~/.0/feedback.md`. Nothing is sent until you confirm a staged payload. `ZERO_FEEDBACK_URL` points sending at your own HTTPS relay. Do not put a Slack webhook URL there.

## Update checks

At startup, 0 doctor checks GitHub for a newer release, at most once every 24 hours. What happens next depends on `updatePolicy`.

| Policy | Behavior |
| --- | --- |
| `automatic` | Default. Runs the installer before starting, then tells you to restart. This can delay startup by a few seconds. |
| `notify` | Prints `Update available: <old> → <new>. Run 0 doctor upgrade.` |
| `off` | No request. |

The check runs only in an interactive terminal. It is skipped when `CI`, `ZERO_NO_UPDATE_CHECK` or `ZERO_OFFLINE` is set to a non-empty value other than `0` or `false`. Project settings cannot change the policy. Automatic installation is not available on Windows. Download a release instead.

```bash
0 doctor upgrade                    # install the latest release now
0 doctor upgrade --version v0.10.0  # pin a release
env ZERO_NO_UPDATE_CHECK=1 0 # skip the check for one run
```

The installer is the same `install.sh` used for a fresh install. Repeated attempts for one release tag are rate limited.

## Limits

- `--runtime api` is the only runtime that supports provider pinning.
- A cost ceiling is an estimate. Calls in flight can overshoot it, and unknown model prices count as unknown, not zero.
- Operational logs are written to stderr. Collect them with your runner or container logging.
