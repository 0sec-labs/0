---
title: Configuration
description: Settings, environment variables, telemetry, updates and the security model.
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

## State directory

Per-user state lives in `~/.0`.

| Path | Purpose |
| --- | --- |
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

Overrides: `--db-path` over `ZERO_DB_PATH` sets the database file. Moving one path does not move the others.

A running console is tied to one folder and owns its database. Commands such as `0 skills list`, `0 memory list` and `0 threads list` run from another folder stop with `This console is for <folder>. Run the command there, or add --db-path <path>.`

Thread transcripts hold target hostnames, findings and raw request and response bodies, including any cookies or tokens a tool echoed. They are not scrubbed or encrypted. File permissions (`0600` files, `0700` directory) are the only protection.

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

`approvals` is `auto` (default: threads and Sentinels run commands without asking) or `ask` (each command or change is put to you first). It is **Ask before running commands** under **Settings → Helpers**, and `--approvals ask|auto` on `0 -p` overrides it for one run. It is the only place asking first is decided: threads and Sentinels have one mode (shell access) and follow this setting. Reset all leaves it alone.

### Development source updates

Enable **Development source updates** (`allowDevSourceUpdates`) only for a source checkout you trust. It reloads changed computer code between turns, and that code runs with the full access of the console process, including your credentials. Start a development console from the checkout with `./scripts/0dev.sh web`. A build failure stops launch. For frontend work, run `pnpm dev`.

## Environment variables

Set them inline, for example `env ZERO_LOG_FORMAT=json 0`.

### Output

| Variable | Effect |
| --- | --- |
| `ZERO_LOG_FORMAT=json` | NDJSON operational records on stderr. Lifecycle and cost metadata only, no prompts, responses, tool data or finding evidence. Not uploaded. |
| `ZERO_DB_PATH` | Database file. |
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

Values are positive integers. Restart the computer after changing them. Provider rate limits still apply.

These limits also exist as settings: `subagentConcurrency` (1-128, default 32), `subagentMaxDepth` (1-16, default 8) and `subagentFanOut` (1-4096, default 1024). The `ZERO_SUBAGENT_*` variables win over them, and a project can only lower them.

### Feature gates

`ZERO_FEATURE_MULTIMODAL` and `ZERO_FEATURE_WEB_SEARCH` turn those features on or off. Enabling a gate does not supply its credentials or tools.

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
| `ZERO_SKIP_PROVIDER_BANNER` | `ZERO_SUPPRESS_PROVIDER_STARTUP_LOG` |

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

Never in any telemetry: targets, URLs, hostnames, IP addresses, file paths, finding titles, descriptions or evidence, prompts, model output, chat messages, tool arguments or results, source code, credentials, environment variables, usernames, or error message text. Every string passes through the same redaction step before it leaves the process, and the usage fields above are an explicit allowlist, so a new field cannot be sent without a deliberate change.

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

`ZERO_UPDATE_ORIGIN` points the check and the installer at a mirror or a test server that serves `/latest`, `/install.sh` and `/releases/download/<tag>/<asset>`. It is not set normally.

The check never blocks startup for long and never retries within a day. It asks the GitHub API, then the release page redirect (no API quota), then the API by repository id. When GitHub is offline, rate limited or unreachable, 0 starts normally with the old version and checks again the next day.

## Execution boundary

The default shell executor runs on your host. It is not a firewall, container or VM. Use a disposable environment for untrusted code and targets.

## Cost estimates

0 shows estimated model cost on each thread. Provider and infrastructure costs are yours; set a spending limit with your provider.

The estimator prices input, output, cached-input and cache-write tokens from a bundled rate table. An unknown model price is unknown, not zero.

- Gateway prices can differ from direct-provider prices, even for the same model name.
- Subscription routes (ChatGPT Codex, coding plans) have their own allowances. Token-dollar estimates do not show remaining quota.
- Failed or cancelled requests can use provider capacity without usage reaching the CLI. Check your provider invoice.

## Security model

0 runs as you, with bash. The agent can do what you can do in a terminal; the defences are approvals, the sandbox when you use one, and the prompts below. This page covers third-party code and text: extensions, MCP servers and skills.

### Extensions and MCP

An extension or MCP server you add runs other people's code as your user. 0 puts an explicit review in front of it. It does not sandbox it. Setup is in [Extensions](/extensions/).

- **Pinned by commit.** A git extension is fetched without running anything and pinned to a full 40-character commit. Branches, tags and short SHAs are refused. The installed folder is hashed; if it changes on disk, it is blocked until you review it again. Local folders are pinned by content hash.
- **The install prompt.** It shows `repo @ commit`, the licence, the file list, hidden-Unicode flags and what the extension can do: scripts it ships, MCP servers (command or URL, variable names), services it calls (hosts, read or write). The click echoes the commit, and the server re-checks that the revision it installs is the one you saw. Approving is yours: a command run by a thread, or without a terminal, is refused. The audit log records `extension.install` with the commit and capabilities.
- **Updates re-prompt.** Any change, even one new script, shows the folder diff and a capability delta and asks again. There is no silent auto-update of third-party extensions. Built-ins update with the binary.
- **Per-tool MCP pins.** The first time an MCP server connects you approve its tools; 0 stores a sha256 of each tool's name, description, input schema and annotations. If any tool is changed, new or removed, the whole server is blocked until you approve again. MCP servers start only when the model first loads them, run through `beforeCommand` (your approvals), and their output is labelled untrusted and capped. Details are in [MCP servers in extensions](/extensions/#servers-bundled-in-an-extension).
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

- Cost figures are estimates, and unknown model prices count as unknown, not zero.
- Operational logs are written to stderr. Collect them with your runner or container logging.
