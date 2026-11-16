---
title: Configuration
description: Settings, environment variables, scope, costs, telemetry, updates and the security model.
---

Settings, credentials and run state are separate. This page covers settings and the environment. Provider keys and model routing are on [Models](/models/).

## Quick start

```bash
0 config get                    # effective settings, each labelled default, global or project
0 config get --export ./settings.json  # write the effective settings as JSON
0 config set --from-file ./settings.json  # merge into the global layer
0 config doctor upgrade                        # install the latest release
```

Resolution order, highest first: command-line flag, environment variable, project settings, global settings, built-in default.

## Execution profile

`executionProfile` chooses where the agent and its tools run. It does not choose the model.

| Value | Meaning |
| --- | --- |
| `local` | Default. Helpers, browser and shell run on your computer. |
| `smolvm` | Everything runs inside a local Kali VM (the workbench). |

Set up the workbench, then start the app:

```bash
0 config doctor workbench setup --image /absolute/path/0-workbench-linux-arm64.tar --provider chatgpt-codex
0 config doctor workbench status --json
0
```

Setup downloads the pinned VM runtime and approves a digest-pinned local image archive. It never trusts a mutable registry tag. The native runtime is qualified on Apple Silicon macOS.

| `setup` option | Default | Effect |
| --- | --- | --- |
| `--image <archive>` | saved approved image | Local OCI or Docker archive to approve (limit 8 GiB). |
| `--state <directory>` | `~/.0/workbench` | VM state, image approval and guest data. |
| `--workspace <directory>` | current directory per launch | Host folder mounted at `/workspace` in the guest. |
| `--provider <id>` | none | Grant a host provider account to the guest. Repeat to grant several. `0 config doctor workbench providers` lists the IDs. |
| `--no-github` | | Revoke the GitHub token grant. Forwarding a GitHub token is refused. |
| `--cpus`, `--memory <MiB>`, `--storage <GiB>` | `2`, `4096`, `20` | Guest resources. |
| `--sandbox-image <reference=archive>` | none | Approve a `repository@sha256:<64 hex>` image for isolated container actions. Repeat for more. |

Change it later:

```bash
0 config doctor workbench configure --provider openai,anthropic --no-github   # replace grants
0 config doctor workbench configure --provider none                           # revoke provider grants
0 config doctor workbench configure --current-workspace                       # drop a fixed workspace
0 config doctor workbench configure --clear-sandbox-images
0 config doctor workbench disable                                             # return to local; keeps image and state
```

Rules:

- Choices live in `~/.0/workbench.json` (owner-only). Credential values are never stored there.
- The guest sees only granted providers. Host HOME, SSH keys, Docker sockets and other environment variables are not forwarded.
- If the runtime, image or admission check fails, launch is refused. It never falls back to the host.
- Project settings cannot change the profile. A change applies at the next launch.
- `0 config doctor workbench status` is read-only and never downloads anything.

## Runtime modes

`--runtime` chooses the model backend for a command.

| Runtime | Meaning |
| --- | --- |
| `auto` | Default. Picks an available runtime for the workflow. |
| `api` | Direct HTTPS calls to a configured provider. Required for `--provider` pinning and `--cyber-access-program`. |
| `claude` | Runs the signed-in Claude Code CLI. |
| `codex` | Managed source review keeps the native API tool boundary. Live scans use the ChatGPT Codex provider when you are signed in. |

`--model` does not select a runtime. Pass `--runtime api` to use the provider rules in [Models](/models/) instead of workflow-based selection.

The `claude` and `codex` runtimes need that CLI installed and signed in (`npm i -g @anthropic-ai/claude-code`, `@openai/codex`):

```bash
0 scan ./my-repo --runtime claude --depth deep
```

`--runtime gemini` and `--runtime ollama` were removed in 0.35. Use `--runtime api` with an OpenAI-compatible endpoint instead; see [Custom and local providers](/models/#custom-and-local-providers).

## Common flags

The full list is in the [CLI reference](/commands/). These change behavior most.

| Flag | Values | Notes |
| --- | --- | --- |
| `--depth` | `quick`, `default`, `deep` | Sets the investigation budget, not a test count. See [Costs and budgets](#costs-and-budgets). |
| `--format` | `terminal`, `json`, `md`, `html`, `sarif`, `pdf` | `html` and `pdf` are saved to a temporary file. |
| `--diff-base <ref>` | git ref | Diff-aware source review. Add `--changed-only` to limit leads to changed files. |
| `--cost-ceiling <usd>` | number | Stop when estimated cost passes the limit. |
| `--verbose` | | Detailed agent output. |
| `--timeout <ms>` | number | Per-request timeout. |

```bash
0 scan ./my-repo --diff-base origin/main --changed-only --format sarif
```

For web scans, `--mode` is `deep`, `probe`, `web`, `mcp` or `http_audit`. Targets starting with `mcp://` default to `mcp`. See [Quickstart](/#scan-from-the-terminal).

## State directory

Per-user state lives in `~/.0`.

| Path | Purpose |
| --- | --- |
| `runs/<scan-id>/state.db` | Findings and state for one run. |
| `tui-settings.json` | Global settings (legacy filename). |
| `credentials.json` | Stored API keys, mode `0600`. |
| `console-sessions/` | One transcript JSON per thread. |
| `engines.json` | Registered remote computers. See [Computers](/computers/). |
| `workbench.json` | Workbench choices. |
| `last-update-check` | Cache for update checks. |
| `feedback.md` | Locally staged feedback. |
| `diagnostics/pending/` | Crash reports waiting for your review (only with `diagnosticReporting` set to `ask`), mode `0600`. At most 10, oldest removed first. |
| `analytics-id` | The random install ID used for anonymous usage counts. Delete it to start a new one. |
| `analytics-sent.log` | A copy of every usage payload this machine sent. |
| `telemetry-notice` | Marks that the one-time telemetry notice was shown. Delete it to see the notice again. |

Project settings live in `<project>/.0/tui-settings.json`.

Overrides: `--db-path` over `ZERO_DB_PATH` sets the database file. `ZERO_RUN_DIR` sets the run directory. Moving one path does not move the others.

Thread transcripts hold target hostnames, scope, findings and raw request and response bodies, including any cookies or tokens a tool echoed. They are not scrubbed or encrypted. File permissions (`0600` files, `0700` directory) are the only protection.

## The `0 config` command

`0 config` reads and writes computer settings. Appearance is set in the browser app under Settings.

```bash
0 config get
0 config get <key>
0 config set <key> <value> [--project] [--yes]
0 config set --reset [keys...] --yes
0 config get --export [file] [--global]
0 config set --from-file <file> [--global | --project] [--yes]
0 config set <key> <value> [--yes]
```

Layers, highest first: project, global, default. Unknown keys are dropped and invalid values reset to the default when settings load.

Some settings are operator-global, and a project can never change them: `analyticsLevel`, `diagnosticReporting`, `updatePolicy`, onboarding state, development source updates, `executionProfile` and `approvals`.

`0 config set --from-file <file>` refuses to change security-sensitive settings unless you pass `--yes`: `executionProfile`, `allowModelSelfExtension`, `allowDevSourceUpdates`, `allowSubagentPeerMessaging` and `allowSubagentOperatorMessaging`. It prints each rejected change.

Two conversation settings are worth knowing. `titleInstructions` (up to 500 characters) guides automatic thread titles, for example a language or style. `archiveIdleDays` (0 = off, 365 at most, global only) archives saved threads idle for that many days when the app starts.

### Ask before running commands

`approvals` is `auto` (default: threads and Agents run commands without asking) or `ask` (each command or change is put to you first). It is **Ask before running commands** under **Settings → Helpers**, and `--approvals ask|auto` on `0 lab console` overrides it for one run. It is the only place asking first is decided: threads and Agents have one mode (shell access) and follow this setting. Older stored access values load as that mode. Reset all leaves it alone. Asking and scope share one decision point: a scope denial is final and is never turned into a prompt. Scope is on whenever a scope is set.

### Development source updates

Enable **Development source updates** (`allowDevSourceUpdates`) only for a source checkout you trust. It reloads changed computer code between turns, and that code runs with the full access of the console process, including your credentials. Start a development console from the checkout with `./scripts/0dev.sh web`. A build failure stops launch. For frontend work, run `pnpm dev`. See Self-improvement.

## Environment variables

Set them inline, for example `env ZERO_LOG_FORMAT=json 0 scan ./repo`.

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
  0 scan https://example.com --scope ./scope.json --depth deep
```

Other gates: `ZERO_FEATURE_MULTIMODAL` and `ZERO_FEATURE_WEB_SEARCH`. Enabling a gate does not supply its credentials or tools. Check the execution records before you accept a finding that a gate produced.

### Dashboard

Set these on the process that runs `0`.

| Variable | Default | Effect |
| --- | --- | --- |
| `ZERO_CSP` | `enforce` | Content-Security-Policy mode: `enforce`, `report-only` or `off`. Leave it on. The page embeds the control token. |

### Deprecated names

The old name still works. 0 copies it to the new name and prints one notice on stderr. Set `ZERO_NO_DEPRECATION_WARNINGS=1` to silence it.

| Deprecated | Use |
| --- | --- |
| `ZERO_CHATGPT_AUTH_FILE` | `ZERO_CODEX_AUTH_JSON_PATH` |
| `ZERO_WPSCAN_API_TOKEN` | `WPSCAN_API_TOKEN` |
| `ZERO_SKIP_PROVIDER_BANNER` | `ZERO_SUPPRESS_PROVIDER_STARTUP_LOG` |

Renamed flags keep hidden aliases: `--backend` is now `--engine`, `--backends-config` is `--engines-config`, `--session` is `--chat`, and `mcp-server --workflows` is `--automations`. 0 reads `~/.0/backends.json` only when `engines.json` does not exist.

## Telemetry

0security is one product with two interfaces, the terminal and the browser app, over one engine. Telemetry is **automatic by default** in official release builds. It has two parts, each with its own switch, and both follow the same data boundary below.

| Setting | Default | Values |
| --- | --- | --- |
| **Usage metrics** (`analyticsLevel`) | `usage` | `off`, `usage` |
| **Problem reports** (`diagnosticReporting`) | `automatic` | `off`, `ask`, `automatic` |
| **Updates** (`updatePolicy`) | `automatic` | `off`, `notify`, `automatic` |

Each setting is global to your computer. Project settings cannot change them. A saved `off` is always kept. A saved `ask` or `automatic` for problem reports is kept too. The one exception is an `ask` that was only the old default: installs upgraded from a version where `ask` was the default, with no recorded choice, now use `automatic`. Choose `ask` again with `0 config set diagnosticReporting ask` or in the browser app under Settings, Privacy, and it stays.

### First-run notice

The first time you run the CLI or `0`, 0security prints one notice to stderr saying that it sends anonymous usage counts and crash reports, with a link here and how to opt out. It is printed once per install, only when stderr is a terminal, and never in CI, with `--format json`, `--json` or other machine formats, with `ZERO_LOG_FORMAT=json`, or when telemetry is already off. The browser app shows the same disclosure under Settings, Privacy, next to the switches.

### Usage metrics

When `analyticsLevel` is `usage`, a release build sends anonymous counts directly to 0security's PostHog project in the EU (`https://eu.i.posthog.com`). No account or cloud token is needed. Each `usage` event carries exactly these fields:

| Field | Meaning |
| --- | --- |
| `tool_counts` | How many times each built-in tool ran. MCP tools count as `mcp`, any other name as `other`. |
| `error_counts` | Tool failures by category (`timeout`, `network`, `permission`, `not-found`, `rate-limit`, `parse`, `resource`, `nonzero-exit`, `stream-incomplete`, `tool-error`, `other`). |
| `finding_severity_counts` | Findings by severity (`critical`, `high`, `medium`, `low`, `info`, `unknown`, `other`). |
| `turn_count`, `duration_ms`, `cost_usd` | Agent turns, time spent, and model spend in USD when known. |
| `version`, `channel` | 0security version and release channel (`beta` or `dev`). |
| `surface` | `web` for `0`, otherwise `cli`. |
| `os`, `arch`, `runtime` | Operating system, CPU architecture, and `node` or `bun`. |
| `$lib`, `$geoip_disable`, `$process_person_profile`, `$ip` | Fixed values (`0security`, `true`, `false`, `null`) that turn off IP lookup and person profiles. |

The event also has a timestamp and a `distinct_id`, which is a random UUID (the install ID). It is not derived from your name, email, hostname, MAC address or machine ID. Counts are sent as increments, a short while after they happen and when the process exits. A send is fire-and-forget with a 3 second limit, no retries, and failures are silent.

PostHog discards IP addresses (`anonymize_ips` is on for the project) and 0security disables GeoIP lookup. To get a new install ID, delete `~/.0/analytics-id`. Every payload sent is also recorded in `~/.0/analytics-sent.log`, without the project key.

If you are signed in with a 0security cloud token (`ZERO_CLOUD_TOKEN` or `~/.0/cloud.env`), usage goes to the authenticated cloud endpoint instead, and nothing is sent to PostHog, so nothing is counted twice. The `commands` and `full` levels of `ZERO_ANALYTICS_LEVEL` exist only for that authenticated path and are never sent to PostHog.

### What is never collected

Never in any telemetry: targets, URLs, hostnames, IP addresses, file paths, finding titles, descriptions or evidence, prompts, model output, chat messages, tool arguments or results, scope entries, source code, credentials, environment variables, usernames, or error message text. Every string passes through the same redaction step before it leaves the process, and the usage fields above are an explicit allowlist, so a new field cannot be sent without a deliberate change.

### Crash reports

The terminal and the browser app are two interfaces over one 0security process, so they share one crash reporter and one destination. A report carries a `surface` tag (`cli` or `web`) and nothing else about which interface produced it. It is captured in two places:

- **Computer process.** A last-resort handler for uncaught exceptions and unhandled rejections. It never changes what happens on a crash: the error is still printed to stderr and the exit code is still `1`. The exit waits at most two seconds for reporting.
- **Browser app.** An error boundary and window error listeners. The page sends only a closed error category and locations inside the built app bundle. The computer validates them again before building the report. Repeated errors are collapsed to one report per minute, at most five per page session.

Your `diagnosticReporting` choice decides what happens to a report:

| Value | What happens |
| --- | --- |
| `off` | The report is dropped. Nothing is stored or sent. |
| `ask` | The report is stored locally in `~/.0/diagnostics/pending/`. Nothing is sent until you preview the exact body in the browser app (Settings, Feedback) and confirm. |
| `automatic` | The report is sent once, with a short timeout. A failure is ignored. This is the default. |

A report contains the error class (for example `TypeError`), the 0security version and release channel, Node version, operating system, CPU architecture, the surface, the name of the command that was running (only from the built-in command list, never arguments) and scrubbed locations inside 0security's own code. It never contains error messages, command output, file paths, targets, hostnames, findings, source code or credentials.

`0 config doctor` prints one line when reports are waiting. `0 config doctor --discard-reports` deletes them without sending anything.

### Opting out

Any one of these turns telemetry off, and the environment variables beat every saved setting:

| How | Effect |
| --- | --- |
| `ZERO_NO_TELEMETRY=1`, `DO_NOT_TRACK=1` or `ZERO_OFFLINE=1` | Everything off: usage and crash reports. Set to any value other than empty, `0`, `false` or `no`. An organization can set one of these for every operator, and it overrides each person's settings. |
| `0 config set analyticsLevel off` | No usage metrics. Also `ZERO_ANALYTICS_LEVEL=off` for one process. |
| `0 config set diagnosticReporting off` | No crash reports. Use `ask` to review each one first. |
| Browser app, Settings, Privacy | The same two switches. |

```bash
export ZERO_NO_TELEMETRY=1
0 config set analyticsLevel off
0 config set diagnosticReporting off
```

Change them in the browser app under Settings, Helpers. Every payload that is sent over HTTP is also recorded in `~/.0/analytics-sent.log`.

### Destinations and overrides

Release builds embed the PostHog project key and the Sentry DSN when they are built, and so does the published Docker image. Source builds, including a `docker build` of the Dockerfile that does not pass the build secrets, and pull-request builds embed neither, so they send nothing. You can point telemetry at your own projects:

- `ZERO_ANALYTICS_POSTHOG_KEY` is a PostHog project key (`phc_` followed by letters and digits). An empty value turns the direct PostHog path off.
- `ZERO_ANALYTICS_POSTHOG_HOST` is the PostHog host. It must be `https`, or `http` on `localhost`, `127.0.0.1` or `::1` for local testing. Anything else disables the path.
- `ZERO_SENTRY_DSN` overrides the crash report destination with your own HTTPS Sentry project. An empty value disables it.

`/feedback <message>` in a thread saves a note locally in `~/.0/feedback.md`. Nothing is sent until you confirm a staged payload. `ZERO_FEEDBACK_URL` points sending at your own HTTPS relay. Do not put a Slack webhook URL there.

## Update checks

At startup, 0 checks GitHub for a newer release, at most once every 24 hours. What happens next depends on `updatePolicy`.

| Policy | Behavior |
| --- | --- |
| `automatic` | Default, also for installs that never chose. Runs the installer before starting, then tells you to restart. This can delay startup by a few seconds. A running `0` does the same in the background (see below). |
| `notify` | Prints `Update available: <old> → <new>. Run 0 config doctor upgrade.` In the console, the update card waits for your click. |
| `off` | No request. |

Only an explicit global choice moves a setting off `automatic`. An install that never picked one, including one with an unrelated saved settings file, follows the default; an explicit `notify` or `off` is kept.

The check runs only in an interactive terminal. It is skipped when `CI`, `ZERO_NO_UPDATE_CHECK` or `ZERO_OFFLINE` is set to a non-empty value other than `0` or `false`. Project settings cannot change the policy. Automatic installation is not available on Windows. Download a release instead.

```bash
0 config doctor upgrade                    # install the latest release now
0 config doctor upgrade --version v0.10.0  # pin a release
env ZERO_NO_UPDATE_CHECK=1 0 # skip the check for one run
```

The installer is the same `install.sh` used for a fresh install. Repeated attempts for one release tag are rate limited. An update replaces the folder the running binary lives in when that folder is writable, otherwise `~/.0/bin` (override with `--install-dir` or `ZERO_INSTALL_DIR`).

### Updating a running console

`0` can run for days, so it does not wait for the next start. For a standalone `0` binary in a writable folder (a managed install):

- Every six hours, with up to ten percent of random spread, it asks for the newest release. The answer is cached in `last-update-check`, shared with the command line, and a failed or offline check is ignored until the next pass. With **Automatic**, it installs the verified release in the background only while no thread is running, then shows **Restart to finish updating**.
- The **Update available** card has **Update and restart**. It runs the same installer as `0 config doctor upgrade` (checksum verified, atomic swap in the folder of the running binary), then shuts the console down cleanly and starts the same command again with the same port, `--db-path` and `--asset-dir`. The page shows **Updating…**, reconnects on its own and reports **Updated to <version>**. If threads are running it asks first, because the restart stops them. Only one update runs at a time, and only the browser console can start one (an attached engine or tool is refused).
- With **Automatic**, server mode off and no service manager, the console also restarts by itself once nothing has run for 10 minutes. In [server mode](/server-mode/) it never restarts itself: it shows the card instead.
- Under launchd, systemd or pm2 (detected from the environment, or set `ZERO_SUPERVISED=1` or `0`), the console exits with code 0 after installing and expects the service manager to start it again: use `KeepAlive` (launchd), `Restart=always` (systemd) or pm2's default. It never starts a second copy.

The card never offers a button that cannot work. Docker images are replaced, never changed in place (`docker pull ghcr.io/0sec-labs/0security:latest`, then recreate the container); a source checkout updates with `git pull` and a rebuild; an npm install must move to the standalone binary; a binary in a read-only folder or on Windows shows `0 config doctor upgrade`.

Copies older than this feature cannot be updated from the console, and nothing can reach them remotely. Update them once with `0 config doctor upgrade` or the install one-liner on the [Quickstart](/#update); every later update then works from the card.

`ZERO_UPDATE_ORIGIN` points the check and the installer at a mirror or a test server that serves `/latest`, `/install.sh` and `/releases/download/<tag>/<asset>`. It is not set normally.

The check never blocks startup for long and never retries within a day. It asks the GitHub API, then the release page redirect (no API quota), then the API by repository id. When GitHub is offline, rate limited or unreachable, 0 starts normally with the old version and checks again the next day. Copies older than 0.29 only check when `ZERO_UPDATE_CHECK=1` is set; update those with the installer, or with the upgrade command that older versions have.

## Scope

A scope file lists the hosts 0 may test. Use one for every live target.

Only test systems you own or are authorized to test. A scope file encodes that authorization; it does not grant it, and it is not a sandbox.

### Set up scope

Scope enforcement is a built-in extension. It is **on by default**, in every project. Scope is on whenever a scope is set: with no scope nothing is restricted, and the moment you set one (`--scope`, a thread, Agent or automation scope, or a pull request checkout) its hosts, paths and exclusions are enforced.

If the scope extension is turned off or fails while a scope is set, commands are **denied**, not allowed. To also require a scope for every live target, enable it explicitly for the project:

```bash
0 skills extensions enable scope
```

Save `scope.json` with your authorized hosts:

```json
{
  "in_scope": ["app.example.com"],
  "out_of_scope": []
}
```

Pass it to the scan:

```bash
0 scan https://app.example.com --scope ./scope.json \
  --depth quick --cost-ceiling 2
```

With the extension enabled explicitly, `scan` refuses HTTP, HTTPS and MCP targets without a scope file, including localhost. The target is checked before work starts. A missing or malformed file is always an error.

With no scope set, host checks, exclusions and local filesystem boundaries have nothing to enforce. Credential protection, sandboxing and resource limits apply either way. Turning the extension off (`0 skills list scope --disable`) makes any scope you set deny commands until you turn it back on.

### Matching rules

Rules match the URL's **hostname**, case-insensitive. Port, path and resolved IP address are ignored.

| Rule | Matches | Does not match |
| --- | --- | --- |
| `app.example.com` | `https://app.example.com/` on any path or port | `api.app.example.com`, `example.com` |
| `*.example.com` | `app.example.com`, `a.b.example.com` | The apex `example.com`, `example.com.attacker.test` |
| `192.0.2.0/24` | A literal IPv4 host in range, such as `http://192.0.2.10/` | A DNS name that resolves into the range |

- Write the hostname alone. No `https://`, path or `:443`.
- Only a leading `*.` wildcard works. No bare `*`, interior wildcards or IPv6 CIDRs.
- Add the apex and `*.` as two rules if both are authorized.
- IPv4 prefix lengths are integers from 0 to 32. Avoid broad ranges unless all of it is authorized.
- Exact IPv6 addresses work in bare or bracketed form.
- A trailing root dot is ignored (`app.example.com.` equals `app.example.com`).

#### Exclusions win

A matching `out_of_scope` rule always beats `in_scope`. An empty `in_scope` denies everything.

```json
{
  "in_scope": ["example.com", "*.example.com"],
  "out_of_scope": ["payments.example.com", "*.production.example.com"]
}
```

- `https://app.example.com/` is allowed.
- `https://payments.example.com/` is denied.
- `https://api.production.example.com/` is denied.
- `https://production.example.com/` is **allowed**. The wildcard does not match its apex; add it to `out_of_scope` too.

A redirect or a linked third-party host does not become in scope because the start page was.

### Scope is one input of several

| Input | What it controls |
| --- | --- |
| `--scope` | Which hosts may be reached, once a scope is set. |
| `--auth` | Credentials for the target. Not permission to test it. |
| `--model` and your provider key | Which model does the work. |
| `--engagement-profile conservative` | A quieter testing posture. Not a new scope. |
| `--rate-limit` | Request pacing. |
| `--cost-ceiling` | Estimated model spend for the run. |

With scope on, generic scanner wrappers (sqlmap, nikto and similar) are hidden on scoped scans. `--allow-scanners` shows them without widening the host list.

<span id="requirements-differ-by-command"></span>
#### What each command enforces

| Command | With a scope set |
| --- | --- |
| `scan web` (HTTP, HTTPS, MCP) | Needs a matching scope file before it starts. |
| `recon --active`, `js-recon`, `cloud`, `agent-assure` | Need `--scope`; candidates are checked before live work. |
| `recon` without `--active` | Still does CT, DNS and HTTP lookups. `--scope` only guards active subdomain enumeration, not passive discovery or probes. |
| `identity` | The scope must allow `graph.microsoft.com`. |
| `adgraph`, `entragraph` | Offline analysis of exports you supply. No network. |
| `scan source`, `fix`, `scan repair` | Local source and tool boundaries. `fix` and `scan repair` do not take `--scope`. |

If an engagement needs a hard boundary for all traffic, enforce it outside the process, for example with a firewall.

There is no access setting: a thread or Agent has shell access, and scope, budget and the sandbox are what limit it. Asking before each command is the global **Ask before running commands** setting (see [Ask before running commands](#ask-before-running-commands)).

### Local workflows and strict scope mode

Source and package workflows without a scope file do not turn on scope-based shell egress guards. The `scope_guards_inert` diagnostic marks that state. Cloning code, model requests and tools can still use the network.

In threads, cloning a public HTTPS repository does not add its host to scope. Exclusions apply whenever a scope is set. Private-network restrictions always apply.

To make unscoped local runs fail instead, set `ZERO_REQUIRE_SCOPE=1` or pass `scan --require-scope`. Both need the scope extension to be on, which it is by default.

### Execution boundary

The default shell executor runs on your host. URL checks and scanner suppression are not a firewall, container or VM. Use a disposable environment for untrusted code and targets.

`scan repair` runs setup commands, tests and probes in disposable checkouts **inside the current computer**. They can reach that machine's network and credentials. `--publish` also lets it push a branch and open a pull request.

Saved state is not ongoing authorization. Before you resume a run, confirm the target, scope, credentials and allowed side effects are still valid.

### Diagnose a scope refusal

1. Check that `--scope` points to the right file where 0 lab runs. A host path is not inside a container unless you mount it.
2. Check the JSON is valid and `in_scope` and `out_of_scope` are string arrays.
3. Compare the target hostname with each rule, including apex versus wildcard and exclusions.
4. Check whether a redirect, API call or tool argument goes to another host.
5. Fix the mismatch or get more authorization. Do not widen scope just to silence the refusal.

### Authorized scope

Before you start, agree on destinations, credentials, testing windows, traffic attribution, allowed side effects and evidence handling. Attribution and scope controls help constrain supported traffic paths. They are not proof of authorization or a network sandbox.

<span id="engagement-posture-profile"></span>
### Posture profile

The default posture paces at 5 requests per second per host and escalates WAF evasion when blocked. `--engagement-profile conservative` is quieter:

```bash
0 scan https://app.example.com --scope ./engagement-scope.json \
  --engagement-profile conservative
```

| Behavior | Default | Conservative |
| --- | --- | --- |
| Request rate | 5 rps per host | 1 rps per host |
| Jitter | none | 0 to 750 ms |
| Reset-endpoint burst probe | 15 POSTs | off (reported as a manual-test lead) |
| Web recon pre-pass | unthrottled | rate-limited |
| WAF-evasion ladder | on when blocked | off |

The profile lowers the fallback rate. It does **not** cap an explicit `--rate-limit`.

Turn off WAF evasion on its own with `--no-waf-evasion` or `ZERO_WAF_EVASION=0`. Detection and block reporting still work.

Set the same controls in the scope file. The scope file beats environment variables, which beat CLI flags:

```json
{
  "in_scope": ["app.example.com"],
  "out_of_scope": [],
  "engagement": {
    "profile": "conservative",
    "waf_evasion": false,
    "reset_burst_probe": false,
    "rate_limit_rps": 1,
    "jitter_ms": 750
  }
}
```

Environment variables: `ZERO_ENGAGEMENT_PROFILE`, `ZERO_WAF_EVASION`, `ZERO_ENGAGEMENT_RATE_RPS` and `ZERO_ENGAGEMENT_JITTER_MS`. A bad profile name or value stops the scan with exit code 2.

When a profile is active, the report carries an `engagementPosture` record with the posture as applied, and the run emits an `engagement_posture_applied` event. These controls cover 0's own request paths, not arbitrary subprocess or extension traffic.

<span id="what-0-does-not-do"></span>
### What scope does not cover

- Recon starts from domains you supply. It is not an organization-wide inventory or a CIDR sweep.
- Identity collection and AD or Entra graph analysis do not exploit, spray credentials or walk the paths they report. See the CLI reference.
- A quiet posture is not stealth.
- A hostname in scope does not authorize persistence, implants, C2, pivoting or destructive impact.
- A saved lead or a model's confirmation is not always a reproduced vulnerability. Check the verifier result before disclosure. See [Verify and fix](/findings/#verify-and-fix).
- Scope does not limit where model traffic goes. See [Keep model traffic in one region](/models/#keep-model-traffic-in-one-region).

## Costs and budgets

0 has three separate limits: estimated model cost, agent turns and request timeouts. Provider and infrastructure costs are yours.

### Set a cost ceiling

```bash
0 scan ./authorized-repo --runtime api --cost-ceiling 5
0 scan npm:lodash --runtime api --cost-ceiling 2
env ZERO_COST_CEILING_USD=3 0 scan https://authorized.example --scope ./scope.json --runtime api
```

`--cost-ceiling <usd>` beats `ZERO_COST_CEILING_USD`. The value must be positive. With neither, there is no dollar limit.

When the estimate passes the ceiling, 0 stops, keeps partial findings and exits with code `4`. With `ZERO_EMIT_RESULT_LINE=1` the result line carries `exit_reason: "cost_ceiling_exceeded"`. Treat a cost stop as incomplete, not as a clean result.

Commands that take `--cost-ceiling`: `scan web`, `scan source`, `scan package`, `scan deep`, `scan campaign`, `scan repair`.

Gotchas:

- It is a soft stop on estimated usage, not an invoice cap. Calls in flight finish, so each active session can overshoot by one turn.
- Source and package scans share one ledger across research, per-file sessions and verification. `scan deep` shares one across its planner and finders.
- `scan repair --cost-ceiling` is not a whole-workflow cap. The repair loop checks its own ledger between findings, so the shown cost is not a reliable investigation-plus-repair total.
- Tool services, infrastructure and other integrations are not metered by the ledger.

### Turn limits

A turn is one model round trip. It can hold several tool calls.

| Work | Default |
| --- | --- |
| Web and deep scan attack stage | 20 (`quick`), 40 (`default`), 100 (`deep`) |
| Source and package research and verification | No limit. The agent stops when the work is done. |
| Browser app threads | No limit per message. `0 lab console --max-tool-calls <n>` sets one. |

A larger limit raises the ceiling on work, not the floor. A run that finishes early does not use the rest.

To bound source and package scans, for example in CI:

```bash
env ZERO_MAX_TURNS_REVIEW=30 ZERO_MAX_TURNS_VERIFY=12 \
  0 scan ./authorized-repo --runtime api --cost-ceiling 5
```

| Variable | Applies to |
| --- | --- |
| `ZERO_MAX_TURNS` | Every shared-runner session |
| `ZERO_MAX_TURNS_AUDIT` | Package audit research (beats the global value) |
| `ZERO_MAX_TURNS_REVIEW` | Source review research (beats the global value) |
| `ZERO_MAX_TURNS_VERIFY` | Verification (beats the global value) |

Invalid, zero or negative values are ignored. These do not limit the web attack stage. MCP, kernel and per-file hunts have their own limits.

Near the end of a session the agent gets two one-time warnings, at 85% of the limit and three turns before it. `ZERO_FEATURE_BUDGET_WARNINGS=0` turns the warnings off. It does not remove the limit.

### When a budget runs out

0 keeps partial findings and records an incomplete session. An exhausted attack stage can still feed verification and reporting. Read the incomplete-run reason before you trust a partial report, and do not assume every saved finding was reproduced.

Loops checkpoint every two turns when a database is attached. Resume does not replay requests that were in flight.

### Cost estimates

The estimator prices input, output, cached-input and cache-write tokens from a bundled rate table. An unknown model price is unknown, not zero.

- Gateway prices can differ from direct-provider prices, even for the same model name.
- Subscription routes (ChatGPT Codex, coding plans) have their own allowances. Token-dollar estimates do not show remaining quota.
- Failed or cancelled requests can use provider capacity without usage reaching the CLI. Check your provider invoice.

### Choosing a depth

Use `quick` for a short pass, `default` for routine work and `deep` when the target needs more. Set a dollar ceiling and a provider-side spending limit as separate controls.

A repeated run can take another path and spends again. A run with no findings does not show the target is secure.

## Security model

0 runs as you, with bash. The agent can do what you can do in a terminal; the defences are scope, approvals, the sandbox when you use one, and the prompts below. This page covers third-party code and text: extensions, MCP servers and skills.

### Extensions and MCP

An extension or MCP server you add runs other people's code as your user. 0 puts an explicit review in front of it. It does not sandbox it. Setup is in [Extensions](/extensions/).

- **Pinned by commit.** A git extension is fetched without running anything and pinned to a full 40-character commit. Branches, tags and short SHAs are refused. The installed folder is hashed; if it changes on disk, it is blocked until you review it again. Local folders are pinned by content hash.
- **The install prompt.** It shows `repo @ commit`, the licence, the file list, hidden-Unicode flags and what the extension can do: scripts it ships, MCP servers (command or URL, variable names), services it calls (hosts, read or write) and any scope it defines. The click echoes the commit, and the server re-checks that the revision it installs is the one you saw. Approving is yours: a command run by a thread, or without a terminal, is refused. The audit log records `extension.install` with the commit and capabilities.
- **Updates re-prompt.** Any change, even one new script, shows the folder diff and a capability delta and asks again. There is no silent auto-update of third-party extensions. Built-ins update with the binary.
- **Per-tool MCP pins.** The first time an MCP server connects you approve its tools; 0 stores a sha256 of each tool's name, description, input schema and annotations. If any tool is changed, new or removed, the whole server is blocked until you approve again. MCP servers start only when the model first loads them, run through `beforeCommand` (your scope and approvals), and their output is labelled untrusted and capped. Details are in [MCP servers in extensions](/extensions/#servers-bundled-in-an-extension).
- **Environment allowlist.** A process gets a scrubbed environment plus only the variable names the extension declared and you approved. Provider keys are never passed unless declared and shown in the prompt. Loader variables (`LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS`) are always rejected. A connection token reaches only a declared variable.
- **Repo config is a suggestion.** A repository's `.0/` or `.claude/` files cannot install or enable anything.
- **Network.** Remote MCP servers need https (plain http only to loopback); hosts that resolve to private, loopback, link-local or metadata addresses are refused and redirects are not followed.

#### Residual risk

- An approved extension or MCP server can read your files, use your network and run programs as your user. Approval is informed consent, not isolation. Use a Computer or SmolVM when you need isolation.
- A commit pin shows you got the code you reviewed, not that it is safe. Review the repository, not only the manifest.
- There are no signatures or publisher identity. A catalog entry marked verified means 0 curated it and pinned its commit.
- An MCP server sees what the agent sends it, and its tool names, descriptions and results can contain prompt injection.

Skills from GitHub get the same treatment: a pinned snapshot, a preview and an explicit click. See [Skills](/skills/#adding-skills-from-github).

### Who can approve

Approval routes are browser-only: agent callers get `403 browser_only`, so an agent cannot add or approve its own tools. In team mode only the workspace owner can use them (`403 owner_required`).

Report problems through the [security policy](https://github.com/0sec-labs/0security/blob/main/.github/SECURITY.md).

## Limits

- `--runtime api` is the only runtime that supports provider pinning.
- A cost ceiling is an estimate. Calls in flight can overshoot it, and unknown model prices count as unknown, not zero.
- Operational logs are written to stderr. Collect them with your runner or container logging.
