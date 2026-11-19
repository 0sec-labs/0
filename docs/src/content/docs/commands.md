---
title: CLI reference
description: 0 CLI commands, arguments, options, aliases, and registered defaults.
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 2
---

Pick your task below, or search for a command name.

New to 0? Read the [Quickstart](/) first. Settings and environment variables are on [Configuration](/configuration/).

## Start by task

| Task | Commands | Guide |
| --- | --- | --- |
| Scan code | [scan](#scan) | [Findings](/findings/) |
| Review findings and threads | [findings](#findings) · [findings update](#findings-update) · [threads](#threads) | [Findings](/findings/), [Threads](/threads/) |
| Automate | [sentinels](#sentinels) · [api](#api) | [Sentinels](/sentinels/) |
| Set up and extend | [config](#config) · [config doctor](#config-doctor) · [models](#models) · [models connect](#models-connect) · [skills](#skills) · [computers](#computers) | [Models](/models/), [Extensions](/extensions/), [Computers](/computers/) |

## The nine commands

`0` with no arguments opens the web console. Everything else is one of nine commands.

| Command | What it does | Subcommands |
| --- | --- | --- |
| `0 scan` | Scan a folder or git repository for security bugs; prints the findings as a report. | none |
| `0 findings` | Browse findings and change their status. `--format` exports, `--import` loads a report. | `list`, `show`, `update` |
| `0 threads` | Start, follow and stop threads. | `list`, `send`, `start`, `stop` |
| `0 sentinels` | Sentinels and, with `--automation`, saved automations. | `list`, `run`, `set` |
| `0 skills` | Skills, extensions, MCP servers and connectors. | `list`, `add`, `run` |
| `0 memory` | What 0 remembers across threads. | `list`, `add`, `remove` |
| `0 models` | Models and provider connections. | `list`, `set`, `connect` |
| `0 computers` | Remote computers that run 0. | `list`, `add`, `stop` |
| `0 config` | Settings, API keys, team setup and `config doctor`. | `get`, `set`, `doctor` |

## Invocation and safety

Run commands as `0 <command>`. Check your release with `0 --version` and
command-specific `--help`.

The browser app's chat uses the same words as slash commands: `/threads list`,
`/findings list`, `/models default` and `/config get` mirror `0 threads list`,
`0 findings list`, `0 models set` and `0 config get`. See [Slash commands](/threads/#slash-commands).

Option tables show registration defaults. **— means no default is registered**:
a handler may resolve configuration or require an explicit value. Inverse
`--no-*` options show the underlying positive boolean default. See
[Configuration](/configuration/) for environment and runtime resolution.

- With no arguments, `0` opens the browser app. No account is needed. See [Browser app](/threads/).
- `0 -p "<prompt>"` runs one headless chat prompt. `0 -c` continues the last chat and `0 --resume <id>` a saved one.
- `0 --help` lists the 8 top-level commands.
- Use explicit commands in automation. Recognizable bare targets are routed automatically; ambiguous input is refused.
- Provider authentication, target authentication, filesystem access, and execution isolation have independent controls.
- The operator-global SmolVM profile runs the entire CLI inside an online Kali guest, preserving original arguments and terminal streams. `workbench` and `config` remain host management commands. No Colima/Docker daemon is needed at runtime; failures never choose host execution implicitly.

## Replacements for moved commands

These forms run the implementation commands documented in the sections below.

### findings update

Change a finding's status. `--status accepted` runs `findings accept`, `suppressed` runs `findings suppress`, `open` runs `findings reopen` and `false-positive` runs `findings triage mark-fp`.

```text
0 findings update [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--status <status>` | — | accepted \| suppressed \| open \| false-positive |
| `--note <text>` | — | Why (optional) |
| `--reason <text>` | — | Why; required with false-positive |
| `--db-path <path>` | — | Path to SQLite database |

### models set

Show or choose the default model. It takes the arguments of `models default`.

```text
0 models set [options] [model]
```

| Argument | Required | Description |
| --- | --- | --- |
| `model` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--provider <provider>` | — | Provider of the model |

### models connect

Add a provider connection (`0 models connect <provider>`), or `--list`, `--test` and `--remove` one. These run `models connections add|list|test|remove`.

```text
0 models connect [options] [provider]
```

| Argument | Required | Description |
| --- | --- | --- |
| `provider` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--key-env <VAR>` | — | Add: read the API key from this environment variable |
| `--stdin` | — | Add: read the API key from stdin |
| `--list` | — | List connections (the default with no provider) |
| `--test` | — | Test a connection |
| `--remove` | — | Remove a connection (with --yes) |

### config doctor

Check this machine and the engine. `config doctor upgrade`, `config doctor workbench` and `config doctor checks` reach the subcommands of `doctor`; `--fix` repairs the local database.

```text
0 config doctor [options] [checks...]
```

| Argument | Required | Description |
| --- | --- | --- |
| `checks` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--fix` | — | Repair the local database |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

## Interactive & setup

### scan

Scan a folder or git repository for security bugs and print the findings as a report.

```text
0 scan [options] <target>
```

A scan is a thread that follows the `scan` skill, so it appears in `0 threads` and in the web app. The findings are stored under the thread's id and exported from there, so `0 findings export --scan <thread id>` gives the same report later. `target` is a folder or a git URL. The scan needs a running console (`0 --headless`) and reads findings from the local database. Exit codes: 0 done, 1 a finding at or above `--fail-on` or the scan failed, 2 usage error, 3 stopped at the budget or the time limit (the report is partial).

| Argument | Required | Description |
| --- | --- | --- |
| `target` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--budget <usd>` | `5` | Stop when the estimated spend reaches this many USD; partial findings are kept |
| `--format <format>` | `md` | Report format: json, md, sarif, html, pdf |
| `-o, --output <file>` | — | Write the report to a file instead of stdout |
| `--fail-on <severity>` | — | Exit 1 when a finding is at or above this severity (critical, high, medium, low, info) |
| `--skill <id>` | `scan` | Skill that holds the scan method |
| `--model <model>` | — | Model for the scan thread (default: gpt-6-luna) |
| `--timeout <seconds>` | `3600` | Maximum seconds to wait for the scan |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |

### web

Open the local browser workspace for threads and findings.

```text
0 web [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--port <port>` | `48123` | Port to bind; 0 chooses a free loopback port |
| `--host <host>` | `127.0.0.1` | Loopback host to bind (127.0.0.0/8 or ::1) |
| `--asset-dir <path>` | — | Path to the built web app |
| `--dev-url <url>` | — | Loopback Vite server for authenticated frontend hot reload |
| `--team-config <path>` | — | Enable workspace accounts, roles, and shared conversation controls |
| `--engine-token-env <name>` | — | Environment variable holding the engine bearer credential (32–4096 characters) |
| `--engine-workspace <path>` | — | Engine-owned authorized workspace for persistent workflow calls |
| `--engine-allow-apply` | — | Admit explicitly approved patch application in persistent workflow calls |
| `--engine-time-cap <ms>` | — | Server workflow deadline ceiling (default 600000 ms) |
| `--engine-cost-cap <usd>` | — | Server workflow estimated cost ceiling (default $5) |
| `--server-mode` | — | Serve the console to a network behind a TLS proxy: requires sign-in, an allowed-host list and a single node (off by default) |
| `--allowed-host <host...>` | — | Server mode: accepted Host header names (default: only the bind host); also ZERO_ALLOWED_HOSTS |
| `--trusted-proxy <cidr...>` | — | Server mode: proxy addresses or CIDRs whose X-Forwarded-* headers are trusted; also ZERO_TRUSTED_PROXY |
| `--public-url <url>` | — | Server mode: the public https URL of this console (sign-in cookies, single sign-on); also ZERO_PUBLIC_URL |
| `--access-token-env <name>` | — | Server mode: environment variable holding the access token (32+ characters); default ZERO_ACCESS_TOKEN, else one is generated |
| `--shutdown-timeout <seconds>` | — | Server mode: seconds to finish in-flight requests on SIGTERM (default 20) |
| `--ready-json` | — | Emit the bound console URL as machine-readable JSON |
| `--no-open` | — | Do not auto-open a browser |
| `--headless` | — | Serve the API only: no browser, and no web app files needed (use with `0 threads`) |
| `--engines-config <path>` | — | Trusted engine connection registry JSON (default ~/.0/engines.json) |

### api

Call an admitted HTTP API on a running engine without sending a model prompt.

```text
0 api [options] [path]
```

Select either `--engine <id>` from an operator-managed registry, or both
`--engine-url <url>` and `--engine-token-env <name>` for direct attachment.
The optional path defaults to `/api/backend/handshake`; it must be an admitted
`/api/` route. The client checks the selected engine's identity and advertised
capabilities before dispatch. Missing credentials, unsupported routes, redirects,
and capability mismatches fail without falling back to local execution.

The default method is GET. Use an explicit write method and `--data` for a
mutation; JSON input can be inline or `@file`, with regular files and serialized
bodies limited to 1 MB. GET and HEAD reject request bodies. Pass the name of an
environment variable for the bearer credential, never the credential as an
argument. Existing server authentication and approval checks still apply.

Responses are JSON envelopes with `ok`, HTTP `status`, and `data`; text exports
appear as strings. Errors produce a nonzero exit and a JSON diagnostic on stderr.
Successful HTTP submission does not mean queued work has finished: retain the
returned resource ID, inspect its status, and cancel explicitly when needed.
This command is not a binary-download or event-stream client. Browser appearance
and interactive OAuth consent remain browser operations.

| Argument | Required | Description |
| --- | --- | --- |
| `path` | No | Admitted /api/ route; defaults to /api/backend/handshake. |

| Option | Registered default | Description |
| --- | --- | --- |
| `--method <method>` | `GET` | GET, POST, PATCH, PUT, DELETE or HEAD. Mutations require an explicit method and remain subject to engine authorization and approvals. |
| `--data <json-or-@file>` | — | JSON body, or @regular-file containing JSON (at most 1 MB) |
| `--engine-url <url>` | — | Attach directly to a trusted HTTP engine; requires --engine-token-env and cannot be combined with registered-engine options. |
| `--engine-token-env <name>` | — | Name of the environment variable holding the engine bearer credential, not the credential itself. Required with --engine-url. |
| `--engine <id>` | — | Select an operator-registered HTTP engine; cannot be combined with --engine-url. |
| `--engines-config <path>` | — | Operator engine registry JSON file |

### findings reports

Import retained CI artifacts into a chosen local browser workspace without
starting an assessment.

```text
0 findings reports
```

Subcommands: [import](#findings-reports-import) · [export](#findings-reports-export).

#### findings reports import

Read a JSON report and optional `run.json`, validate them, and retain a passive
snapshot in the explicitly selected database. Stop the engine using that database
before importing, then open `0 web --db-path <same-path>`. The same report and
metadata import only once. Imported findings remain discovered and unverified by
this engine; importing does not restore execution state or authorize fixes.

```text
0 findings reports import [options] <report>
```

| Argument | Required | Description |
| --- | --- | --- |
| `report` | Yes | JSON report produced by 0; importing executes no report commands |

| Option | Registered default | Description |
| --- | --- | --- |
| `--metadata <path>` | — | Optional run.json invocation and revision metadata |
| `--db-path <path>` **required** | — | Destination engine database; stop its browser engine before importing |

#### findings reports export

Write a share-safe copy of a JSON report. The copy is built from an allowlist: it
keeps the target, summary and, for each finding, the id, title, severity, category,
status, fingerprint, CVSS, confidence and source location. It drops evidence, PoC
steps, agent transcripts, triage notes, suggested code and local absolute paths, and
it removes credentials, query strings and fragments from URL targets. Free-text
descriptions are left out unless you pass `--include-description`. The command only
writes the copy; it sends nothing anywhere.

```text
0 findings reports export [options] <report>
```

| Argument | Required | Description |
| --- | --- | --- |
| `report` | Yes | JSON report produced by 0 |

| Option | Registered default | Description |
| --- | --- | --- |
| `--include-description` | — | Include each finding's free-text description (can quote code or secrets) |
| `--output <path>` | — | Write the share-safe report to a file instead of stdout |

### doctor

Check local runtime prerequisites and suggest the next command

```text
0 doctor [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--discard-reports` | — | Delete crash reports waiting for review on this computer |
| `--json` | — | Print JSON |

Subcommands: [upgrade](#doctor-upgrade) · [workbench](#doctor-workbench).

### config

Inspect, export, and import the two-level console configuration

```text
0 config
```

Subcommands: [get](#config-get) · [set](#config-set) · [doctor](#config-doctor) · [show](#config-show) · [list](#config-list) · [reset](#config-reset) · [export](#config-export) · [import](#config-import) · [audit-log](#config-audit-log) · [team](#config-team) · [db](#config-db) · [github](#config-github).

#### config show

Show each setting's effective value and source: default, global, or project.

```text
0 config show [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### config list

Same as `config show`. Add `--json` for each key's value and source layer.

```text
0 config list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### config get

Print one setting's effective value. `--json` adds the layer it comes from.

```text
0 config get [options] [key]
```

| Argument | Required | Description |
| --- | --- | --- |
| `key` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON with the source layer |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### config set

Change one setting, with the same validation as the Settings page. It writes the global layer unless `--project` is given; operator-global settings refuse `--project`. Security-sensitive settings need `--yes`. Exit code 2 means a bad key or value; 1 means the engine refused the change.

```text
0 config set [options] <key> <value>
```

```bash
0 config set compactionThreshold 85%
0 config set allowModelSelfExtension on --yes
```

| Argument | Required | Description |
| --- | --- | --- |
| `key` | Yes |  |
| `value` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--project` | — | Write the override for this folder |
| `--yes` | — | Confirm a security-sensitive setting |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### config reset

Reset named settings, or every engine setting when none is named, to their defaults. Safety settings never reset to a looser value; the command lists any it kept. Requires `--yes`.

```text
0 config reset [options] [keys...]
```

| Argument | Required | Description |
| --- | --- | --- |
| `keys` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm the reset |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### config export

Export effective configuration as JSON. Use `--global` for the global layer. Output goes to stdout unless a file is supplied.

```text
0 config export [options] [file]
```

| Argument | Required | Description |
| --- | --- | --- |
| `file` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--global` | — | Export only the global layer instead of the effective config |

#### config import

Merge a shared config into the global (default) or --project layer

```text
0 config import [options] <file>
```

| Argument | Required | Description |
| --- | --- | --- |
| `file` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--project` | — | Import into the override for this folder instead of the global config |
| `--global` | — | Import into the global config (default) |
| `--yes` | — | Accept changes to security-sensitive settings (required to flip them) |

### models connections

Manage model provider connections, the same actions as Settings → Connections in the browser. These commands use a running `0 web` engine when there is one, and otherwise apply the change directly on this computer. Keys are never passed as an argument: use `--key-env` or `--stdin`.

```text
0 models connections
```

```bash
export OPENAI_API_KEY_FOR_0="sk-..."
0 models connections add openai --key-env OPENAI_API_KEY_FOR_0
0 models connections list
0 models connections test openai
0 models connections remove openai --yes
```

Subcommands: [list](#models-connections-list) · [add](#models-connections-add) · [test](#models-connections-test) · [remove](#models-connections-remove).

#### models connections list

List providers with their status and saved accounts. `*` marks the active account.

```text
0 models connections list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### models connections add

Verify and save an API key for a provider. Exit code 2 means no key source was given; 1 means the provider rejected it.

```text
0 models connections add [options] <provider>
```

| Argument | Required | Description |
| --- | --- | --- |
| `provider` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--key-env <VAR>` | — | Read the API key from this environment variable |
| `--stdin` | — | Read the API key from stdin |
| `--account-id <id>` | — | Name this saved account |
| `--base-url <url>` | — | Custom API endpoint |
| `--model <model>` | — | Deployment model, where required |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### models connections test

Check that a connected provider answers and lists models.

```text
0 models connections test [options] <provider>
```

| Argument | Required | Description |
| --- | --- | --- |
| `provider` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### models connections remove

Remove a provider's saved credentials, or one saved account with `--account`. Requires `--yes`. A key supplied by an environment variable cannot be removed here.

```text
0 models connections remove [options] <provider>
```

| Argument | Required | Description |
| --- | --- | --- |
| `provider` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--account <id>` | — | Remove only this saved account |
| `--yes` | — | Confirm the removal |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

### models

List the models your connected providers offer and choose the default, as on the Models page.

```text
0 models
```

```bash
0 models list --provider openai
0 models default --provider openai gpt-5.4-mini
0 models recommended
```

Subcommands: [list](#models-list) · [set](#models-set) · [connect](#models-connect) · [default](#models-default) · [recommended](#models-recommended) · [connections](#models-connections) · [usage](#models-usage).

#### models list

List models offered by connected providers, with price and context size.

```text
0 models list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--provider <id>` | — | Only this provider |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### models default

Show the default model, or set it. Setting requires `--provider`, and the provider must be connected.

```text
0 models default [options] [model]
```

| Argument | Required | Description |
| --- | --- | --- |
| `model` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--provider <id>` | — | Provider that serves the model |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### models recommended

Show the recommended model for each role, chosen from your connected providers.

```text
0 models recommended [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

### config github

Check or connect the GitHub account used to publish fixes, as in Settings → Git.

```text
0 config github
```

```bash
0 config github status
0 config github connect --stdin < token.txt
0 config github repos --search api
```

Subcommands: [status](#config-github-status) · [connect](#config-github-connect) · [repos](#config-github-repos).

#### config github status

Show whether GitHub is signed in and which scopes are missing.

```text
0 config github status [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### config github connect

Sign in with a personal access token read from an environment variable or stdin. The token is never printed.

```text
0 config github connect [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--key-env <VAR>` | — | Read the token from this environment variable |
| `--stdin` | — | Read the token from stdin |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### config github repos

List repositories the signed-in account can reach (cached for five minutes).

```text
0 config github repos [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--search <text>` | — | Only names containing this text |
| `--refresh` | — | Bypass the five-minute cache |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

### models usage

Show spend and tokens of the open threads, by model or by thread. Open threads are only tracked by a running `0 web` engine; without one the report is empty.

```text
0 models usage [options]
```

```bash
0 models usage --by thread --json
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--by <model\|thread>` | — | Group by model (default) or list each thread |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

### config audit-log

Show the local log of privileged actions: connection and settings changes, extension installs and denied attempts. The log is append-only.

```text
0 config audit-log [options]
```

```bash
0 config audit-log --q connection --limit 20
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--q <text>` | — | Only events whose action, subject or actor contains this text |
| `--limit <n>` | — | Maximum events to show |
| `--before <id>` | — | Only events older than this id (pagination) |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

### doctor workbench

Set up and inspect the online SmolVM security workbench on
Apple Silicon macOS. The local Linux guest contains 0, the security tools and
the browser; Docker is not required to run the workbench.

```text
0 doctor workbench
```

Subcommands: [run-agent](#doctor-workbench-run-agent) · [console-agent](#doctor-workbench-console-agent) · [setup](#doctor-workbench-setup) · [status](#doctor-workbench-status) · [providers](#doctor-workbench-providers) · [configure](#doctor-workbench-configure) · [disable](#doctor-workbench-disable).

#### doctor workbench run-agent

Internal, hidden entrypoint for the host-controlled CLI engine inside an admitted
Linux SmolVM workbench. It exchanges framed controller messages over standard
input/output; it is not an interactive command or a host-side launch shortcut.
Normal CLI commands select this entrypoint automatically when the workbench
profile is enabled. Direct invocation outside an admitted guest is refused.

```text
0 doctor workbench run-agent
```

#### doctor workbench console-agent

Internal, hidden entrypoint for the host-controlled chat engine inside an
admitted Linux SmolVM workbench. The host owns the terminal/browser UI and
forwards requests, events and approvals over the framed controller transport.
Use `0 -p` or `0` to start a chat; do not invoke this transport endpoint
manually. Direct invocation outside an admitted guest is refused.

```text
0 doctor workbench console-agent
```

#### doctor workbench setup

Verify/provision the signed native runtime, approve a local archive by digest,
and persist the operator-global SmolVM profile.

```text
0 doctor workbench setup [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--image <archive>` | — | Local OCI/Docker archive to digest-pin and approve; never a mutable registry tag |
| `--state <directory>` | — | Private VM state directory (defaults to ~/.0/workbench) |
| `--workspace <directory>` | — | Explicit workspace mount; otherwise each invocation mounts its current directory |
| `--provider <id>` | — | Grant chatgpt-codex requests through the host provider broker; credentials stay on the host |
| `--github` | — | Unsupported: GitHub credential forwarding is refused |
| `--no-github` | — | Revoke the GitHub token grant |
| `--cpus <count>` | — | Guest virtual CPUs |
| `--memory <MiB>` | — | Guest RAM in MiB |
| `--storage <GiB>` | — | Guest private writable storage in GiB |
| `--sandbox-image <reference=archive>` | — | Approve an immutable image reference for brokered isolated container actions; repeat for multiple images |

The supported provider grant is `chatgpt-codex`: model requests go through the
host broker, and credentials stay on the host. GitHub credential forwarding is
refused. The host HOME, SSH configuration and Docker socket are not mounted
into the guest.

#### doctor workbench status

Read configuration, native runtime readiness, image approval, effective privacy,
network mode, broker resource ceilings and retained guest admission. Does not
download or launch a VM or reveal credential values.

```text
0 doctor workbench status [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable status (no credential values) |

#### doctor workbench providers

List the exact identifiers accepted by `--provider`; this does not expose credentials.

```text
0 doctor workbench providers
```

#### doctor workbench configure

Replace integration grants or operator-approved sibling image references.

```text
0 doctor workbench configure [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--provider <ids>` | — | Replace provider grants with comma-separated IDs, or none |
| `--github` | — | Enable the explicit GitHub credential grant |
| `--no-github` | — | Revoke the GitHub credential grant |
| `--current-workspace` | — | Mount each invocation's current directory instead of a fixed saved workspace |
| `--sandbox-image <reference=archive>` | — | Add or replace an operator-approved immutable sandbox image reference; repeat for multiple images |
| `--clear-sandbox-images` | — | Revoke all explicit sandbox image-reference grants |

#### doctor workbench disable

Explicitly switch to host-local execution. Approved image and guest state remain.

```text
0 doctor workbench disable
```

### doctor upgrade

Fetch and install the latest release binary for 0 (re-runs install.sh).

```text
0 doctor upgrade [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--version <tag>` | — | Pin a specific release tag (e.g. v0.10.0) |
| `--install-dir <path>` | — | Override the install directory (default: the folder of this binary, else ~/.0/bin) |

## Findings & evidence

### findings

Browse and manage persisted findings

```text
0 findings [options]
```

Human triage (`new`, `accepted`, `suppressed`) and verification have independent states. Accepting a finding records the operator's decision; reproduction and fix verification remain separate steps.

Subcommands: [list](#findings-list) · [show](#findings-show) · [update](#findings-update) · [accept](#findings-accept) · [suppress](#findings-suppress) · [reopen](#findings-reopen) · [triage](#findings-triage) · [export](#findings-export) · [keys](#findings-keys) · [reports](#findings-reports).

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--scan <scanId>` | — | Filter by scan ID |
| `--severity <severity>` | — | Filter by severity: critical, high, medium, low, info |
| `--category <category>` | — | Filter by attack category |
| `--status <status>` | — | Filter by status: discovered, verified, confirmed, scored, reported, fixed, false-positive |
| `--triage <triage>` | — | Filter by triage: new, accepted, suppressed |
| `--limit <n>` | `50` | Max findings/groups to show |
| `--all` | `false` | Show raw finding rows instead of grouped fingerprints |

#### findings list

List findings from the database

```text
0 findings list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--all` | — | Show raw finding rows instead of grouped fingerprints |
| `--db-path <path>` | — | Path to SQLite database |
| `--scan <scanId>` | — | Filter by scan ID |
| `--severity <severity>` | — | Filter by severity: critical, high, medium, low, info |
| `--category <category>` | — | Filter by attack category |
| `--status <status>` | — | Filter by status: discovered, verified, confirmed, scored, reported, fixed, false-positive |
| `--triage <triage>` | — | Filter by triage: new, accepted, suppressed |
| `--limit <n>` | — | Max findings/groups to show |

#### findings show

Show detailed information about a finding

```text
0 findings show [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes | Finding ID (full or prefix) |

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### findings accept

Mark a finding family as accepted

```text
0 findings accept [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes | Finding ID (full or prefix) |

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--note <text>` | — | Optional triage note |

#### findings suppress

Suppress a finding family across duplicate occurrences

```text
0 findings suppress [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes | Finding ID (full or prefix) |

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--note <text>` | — | Suppression reason |

#### findings reopen

Reset a finding family back to new

```text
0 findings reopen [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes | Finding ID (full or prefix) |

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--note <text>` | — | Optional triage note |

#### findings export

Export selected findings, or a whole scan, as `json`, `md`, `sarif`, `html` or `pdf`. Reads the local database; no engine needs to run. IDs accept a unique prefix. For a share-safe copy of a JSON report use `0 findings reports export`.

```text
0 findings export [options] [ids...]
```

```bash
0 findings export 3f2a 91bc --format sarif -o findings.sarif
0 findings export --scan 20260101-abc --format pdf -o report.pdf
```

| Argument | Required | Description |
| --- | --- | --- |
| `ids` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--scan <id>` | — | Export every finding of this scan instead of selected IDs |
| `--format <format>` | `json` | json, md, sarif, html or pdf |
| `-o, --output <file>` | — | Write to a file instead of stdout |
| `--severity <severity>` | — | With no IDs: only this severity |
| `--category <category>` | — | With no IDs: only this category |
| `--status <status>` | — | With no IDs: only this status |
| `--triage <triage>` | — | With no IDs: only this triage state |
| `--db-path <path>` | — | Path to SQLite database |
| `--json` | — | Print the result of writing a file as JSON |

#### findings keys

Manage read-only API access keys for the findings API. The secret is printed once at creation and never stored in plaintext. Team workspaces manage keys in the browser.

```text
0 findings keys
```

```bash
0 findings keys create ci-reader --expires-in 30
```

Subcommands: [list](#findings-keys-list) · [create](#findings-keys-create) · [revoke](#findings-keys-revoke).

#### findings keys list

List keys with their expiry and status. Secrets are never shown.

```text
0 findings keys list [options]
```

```bash
0 findings keys list --json
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### findings keys create

Create a read-only key. Default expiry is 90 days.

```text
0 findings keys create [options] <name>
```

```bash
0 findings keys create ci-reader --expires-in 30
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--expires-in <days>` | — | Days until the key expires (default 90) |
| `--db-path <path>` | — | Path to SQLite database |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### findings keys revoke

Revoke a key. Requires `--yes`.

```text
0 findings keys revoke [options] <id>
```

```bash
0 findings keys revoke 643b88a4-2fae-409b-b4d9-bea00fc75812 --yes
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm the revocation |
| `--db-path <path>` | — | Path to SQLite database |
| `--json` | — | Print JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

### findings triage

Triage findings and manage learned FP memories

```text
0 findings triage
```

Subcommands: [memory](#findings-triage-memory) · [mark-fp](#findings-triage-mark-fp).

#### findings triage memory

Manage Semgrep-style triage memories

```text
0 findings triage memory
```

Subcommands: [add](#findings-triage-memory-add) · [list](#findings-triage-memory-list) · [remove](#findings-triage-memory-remove).

#### findings triage memory add

Create a memory from an existing finding

```text
0 findings triage memory add [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--finding <id>` **required** | — | Finding ID (full or prefix) to derive the memory from |
| `--reason <text>` **required** | — | Why this finding is a false positive |
| `--scope <scope>` | `target` | Memory scope: global \| target \| package |
| `--scope-value <value>` | — | Scope identifier (target URL or package name) |
| `--db-path <path>` | — | Path to SQLite database |

#### findings triage memory list

List all triage memories

```text
0 findings triage memory list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |

#### findings triage memory remove

Delete a memory by id

```text
0 findings triage memory remove [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes | Note ID |

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |

#### findings triage mark-fp

Mark a finding as false positive and auto-create a memory

```text
0 findings triage mark-fp [options] <finding-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `finding-id` | Yes | Finding ID (full or prefix) |

| Option | Registered default | Description |
| --- | --- | --- |
| `--reason <text>` **required** | — | Why this finding is a false positive |
| `--scope <scope>` | `target` | Memory scope: global \| target \| package |
| `--scope-value <value>` | — | Scope identifier (target URL or package name) |
| `--db-path <path>` | — | Path to SQLite database |

#### Real kernel VM verification

Imported crash logs record a prior run. For a new reproduction, follow Kernel VM Verification and its execution and evidence requirements.

### config db

Manage the local findings database.

```text
0 config db
```

Subcommands: [repair](#config-db-repair) · [reset](#config-db-reset).

#### config db repair

Back up a malformed local SQLite database and recreate a clean one

```text
0 config db repair [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |

#### config db reset

Delete the local SQLite database and optionally reseed the verification workbench

```text
0 config db reset [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--seed <preset>` | `verification` | Seed preset to load after reset |

Reset also removes `<db>-journal` and the `<db>.lock` directory left by the SQLite WASM engine. It refuses, and deletes nothing, when the database path is a directory (check `ZERO_DB_PATH` and `--db-path`), when the process recorded in `<db>.lock/pid` is still alive, or when the lock has no owner information and was modified in the last 5 minutes. Symlinks are removed as links and never followed; recursive deletion applies only to the `.lock` path. The browser's reset-database route shares this behavior and can return an error for a held lock.

## Automation & integration

### computers

Add and manage remote computers. A computer is a remote 0 engine that runs
threads and automations on its host; select it in the browser's computer menu
to work there. `worker` still works as an older name.

```text
0 computers
```

Subcommands: [list](#computers-list) · [add](#computers-add) · [stop](#computers-stop) · [repair](#computers-repair) · [remove](#computers-remove) · [hosts](#computers-hosts).


#### computers list

List the registered remote computers with their host and whether 0 deployed them
(managed computers can be reconnected and stopped from here).

```text
0 computers list [options]
```

```bash
0 computers list --json
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON |
| `--engines-config <path>` | — | Engine registry path |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### computers add

Also available as `computers add`. Deploy the built CLI engine onto a running Linux Lima instance or an SSH host and
register its connection locally. Run `pnpm build` in a source checkout first.
Use `--ssh` for an SSH host alias or `user@host`; otherwise the command uses the
`zero-worker` Lima instance. SSH deployment uses noninteractive key authentication.

```text
0 computers add [options]
```

Use `--target-git` to clone your repository into the remote workspace. Forwarding
`OPENAI_API_KEY` is explicit through `--forward-provider-key`; use it only for a
host you own. Deployment installs runtime dependencies and starts the engine on
the remote machine. Inspect the returned backend ID and connection details, then
select that computer in the browser before starting remote work.

| Option | Registered default | Description |
| --- | --- | --- |
| `--ssh <user@host>` | — | SSH target host (BatchMode; key auth from ssh config/agent) |
| `--lima <name>` | `zero-worker` | Lima instance name |
| `--target-git <url>` | — | Repository the remote server clones into the engine folder instead of the bundled demo target |
| `--ssh-config <path>` | — | OpenSSH config file for the SSH target (e.g. a Lima instance's ssh.config) |
| `--engine-port <port>` | — | Engine port on the remote server (default: stable port derived from host) |
| `--trust-new-host` | `false` | Trust and remember the computer's SSH host key if it is not known yet |
| `--forward-provider-key` | `false` | Forward this computer's OPENAI_API_KEY to the remote engine (user-owned hosts only) |
| `--engines-config <path>` | — | Engine registry path |

Aliases: `deploy`.

#### computers repair

Also available as `computers reconnect`.

Reconnect a previously deployed worker using its saved deployment metadata and
credentials. The command starts the retained managed engine if needed and
recreates its owned SSH tunnel. It preserves remote files and refuses to replace
an unrelated process or an occupied engine port. If the deployment files are
missing, deploy the worker again.

```text
0 computers repair <id>
```

The result is JSON with the backend ID, reconnection status, and whether the
engine was started.

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

Aliases: `reconnect`.

#### computers stop

Stop a worker engine that Zero deployed and disconnect its owned local tunnel.
The command verifies the saved deployment metadata, remote working directory,
PID and process command before sending a termination signal. It retains the
remote workspace and the saved backend registration so the worker can be
redeployed later.

```text
0 computers stop <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

#### computers remove

Remove a remote computer from this machine: closes the tunnel and forgets its
saved connection. Files on the remote computer stay in place.

```text
0 computers remove [options] <id>
```

Run `0 computers list` to see the IDs.

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--engines-config <path>` | — | Engine registry path |

#### computers hosts

List SSH host aliases discovered from `~/.ssh/config`, with their resolved host
and user when present. This lists configuration entries rather than checking
connectivity or whether each host supports a Linux engine.

```text
0 computers hosts
```

### skills

Browse, add, create, edit, import, export and link skills

```text
0 skills
```

Every command works with the app running or on its own, and takes `--json`. Adding from GitHub or the catalog shows a review first and needs `--yes`.

```bash
0 skills list
0 skills catalog --search handoff
0 skills add mattpocock~skills~handoff --yes
```

Subcommands: [list](#skills-list) · [add](#skills-add) · [show](#skills-show) · [new](#skills-new) · [edit](#skills-edit) · [copy](#skills-copy) · [delete](#skills-delete) · [import](#skills-import) · [export](#skills-export) · [link](#skills-link) · [unlink](#skills-unlink) · [catalog](#skills-catalog) · [extensions](#skills-extensions) · [remove](#skills-remove).

#### skills list

List installed skills and linked folders

```text
0 skills list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills show

Show a skill's SKILL.md and files

```text
0 skills show [options] <id-or-name>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id-or-name` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills new

Create a skill from a SKILL.md file

```text
0 skills new [options] <file>
```

| Argument | Required | Description |
| --- | --- | --- |
| `file` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills edit

Replace a skill's SKILL.md with the contents of --file

```text
0 skills edit [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--file <path>` **required** | — | SKILL.md with the new content |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills copy

Save a workspace copy of a skill under a new name

```text
0 skills copy [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--name <name>` **required** | — | Name for the copy (lowercase letters, digits, hyphens) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills delete

Delete a skill from the workspace library

```text
0 skills delete [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm the deletion |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills import

Import a skill bundle (.skill.json) or a folder with SKILL.md

```text
0 skills import [options] <bundle>
```

| Argument | Required | Description |
| --- | --- | --- |
| `bundle` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills export

Export a skill as a bundle

```text
0 skills export [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `-o, --output <file>` | — | Write the bundle to a file instead of stdout |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills link

Link a folder of skills; they stay where they are

```text
0 skills link [options] <folder>
```

| Argument | Required | Description |
| --- | --- | --- |
| `folder` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills unlink

Unlink a folder by its link id (see `0 skills list --json`)

```text
0 skills unlink [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills catalog

Browse the skills catalog

```text
0 skills catalog [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--search <text>` | — | Filter by name, publisher or summary |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills add

Add a skill from the catalog or GitHub (owner/repo[/path]); shows a review first

```text
0 skills add [options] <source>
```

| Argument | Required | Description |
| --- | --- | --- |
| `source` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--preview` | — | Only show the review |
| `--yes` | — | Install the reviewed commit |
| `--enable` | — | Extensions: also enable it |
| `--project <dir>` | — | Extensions: with --enable, enable for this folder only |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills extensions

Installed extensions: list, info, enable, disable, update, remove (install with `0 skills add`)

```text
0 skills extensions
```

Subcommands: [add](#skills-extensions-add) · [mcp](#skills-extensions-mcp) · [list](#skills-extensions-list) · [info](#skills-extensions-info) · [enable](#skills-extensions-enable) · [disable](#skills-extensions-disable) · [remove](#skills-extensions-remove) · [update](#skills-extensions-update) · [import](#skills-extensions-import).

#### skills extensions add

Install an extension: <url|owner/repo|folder>@<full sha>; same as `0 skills add`

```text
0 skills extensions add [options] <source>
```

| Argument | Required | Description |
| --- | --- | --- |
| `source` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--preview` | — | Only show the install prompt |
| `--yes` | — | Install the exact revision shown |
| `--enable` | — | Also enable it |
| `--project <dir>` | — | With --enable: enable for this folder only |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills extensions mcp

Add one MCP server as a local extension

```text
0 skills extensions mcp [options] <name> [command...]
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |
| `command` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--url <https-url>` | — | A remote server instead of a command |
| `--preview` | — | Only show the install prompt |
| `--yes` | — | Install the exact revision shown |
| `--enable` | — | Also enable it |
| `--project <dir>` | — | With --enable, enable for this folder only |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills extensions list

List installed extensions and built-ins

```text
0 skills extensions list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--project <dir>` | — | Show enablement for this project |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills extensions info

Show the install prompt for an installed extension

```text
0 skills extensions info [options] <name>
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills extensions enable

Enable globally, or for one project with --project

```text
0 skills extensions enable [options] <name>
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--project <dir>` | — | Enable for this folder only |
| `--yes` | — | Approve an unapproved revision (for example an imported one) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills extensions disable

Disable globally, or for one project with --project

```text
0 skills extensions disable [options] <name>
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--project <dir>` | — | Disable for this folder only |
| `--yes` | — | Confirm disabling a built-in |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills extensions remove

Remove an installed extension and its stored revisions

```text
0 skills extensions remove [options] <name>
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm the removal |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills extensions update

Show the diff and install prompt for a newer revision; --yes --to <sha> approves it

```text
0 skills extensions update [options] <name>
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--to <sha>` | — | Full commit SHA to update to (default: the remote HEAD) |
| `--yes` | — | Approve the revision given by --to |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills extensions import

Import earlier plugins, MCP servers and skills (runs once automatically); shows what could not be migrated

```text
0 skills extensions import [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--force` | — | Run the importer again |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### skills remove

Remove a skill that was added from GitHub or the catalog

```text
0 skills remove [options] <name>
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm the removal |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |
| `--format <format>` | — | Output: text or json Choices: text, json. |

### memory

List, add, remove, export and import what 0 remembers across threads

```text
0 memory
```

Memory is what 0 remembers across threads: short plain notes per folder or everywhere, kept as Markdown under `~/.0/memory/`. The commands work on those files and need no running engine. False-positive reasons are notes tagged `avoid`. A note you add here is saved at once. A note 0 wants to keep after reading web pages, files or tool output waits in the proposed inbox until you accept it. Secrets are never saved.

```bash
0 memory list
0 memory add "Run tests with pnpm test" --kind command
0 memory proposed list
0 memory proposed accept m_1a2b3c4d
0 memory export --to AGENTS.md
```

Subcommands: [list](#memory-list) · [add](#memory-add) · [remove](#memory-remove) · [clear](#memory-clear) · [disable](#memory-disable) · [enable](#memory-enable) · [proposed](#memory-proposed) · [export](#memory-export) · [import](#memory-import).

#### memory list

List notes

```text
0 memory list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--folder <path>` | — | Only notes for this folder |
| `--global` | — | Only global notes |
| `--search <text>` | — | Only notes containing this text |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### memory add

Remember a note

```text
0 memory add [options] <text>
```

| Argument | Required | Description |
| --- | --- | --- |
| `text` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--folder <path>` | — | Folder the note is about (default: this folder) |
| `--global` | — | Remember it everywhere |
| `--kind <kind>` | — | One of fix-decision, convention, command, avoid |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### memory remove

Forget a note

```text
0 memory remove [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### memory clear

Forget every note, or every note for one folder

```text
0 memory clear [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--folder <path>` | — | Only this folder |
| `--yes` | — | Confirm |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### memory disable

Stop using notes in new threads (they stay on disk)

```text
0 memory disable [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### memory enable

Use notes in new threads again

```text
0 memory enable [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### memory proposed

Review notes 0 proposed after reading web pages, files or tool output (they are not used until accepted)

```text
0 memory proposed
```

Subcommands: [list](#memory-proposed-list) · [accept](#memory-proposed-accept) · [reject](#memory-proposed-reject).

#### memory proposed list

List proposed notes

```text
0 memory proposed list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### memory proposed accept

Accept a proposed note so it is used in new threads. `--text` corrects the wording while accepting.

```text
0 memory proposed accept [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--text <text>` | — | Correct the wording while accepting |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### memory proposed reject

Discard a proposed note

```text
0 memory proposed reject [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### memory export

Write notes to a file: JSON for 0 by default, or with `--to` an AGENTS.md section for a person to review and commit. Only notes you wrote or accepted are exported. 0 never imports notes from a repository.

```text
0 memory export [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--folder <path>` | — | Only this folder (default for --to: this folder) |
| `-o, --output <file>` | — | Write the JSON export to a file instead of stdout |
| `--to <file>` | — | Add accepted notes to this markdown file (for example AGENTS.md) as a section you review and commit |
| `--markdown` | — | Print the markdown section instead of JSON |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### memory import

Add the notes from an export file

```text
0 memory import [options] <file>
```

| Argument | Required | Description |
| --- | --- | --- |
| `file` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Engine database to import older memories from |
| `--format <format>` | — | Output: text or json Choices: text, json. |

## Automations

### automation

Saved automations.

```text
0 automation
```

Subcommands: [list](#automation-list) · [show](#automation-show) · [create](#automation-create) · [edit](#automation-edit) · [duplicate](#automation-duplicate) · [versions](#automation-versions) · [rollback](#automation-rollback) · [delete](#automation-delete).


#### automation list

List saved automations and templates.

```text
0 automation list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--templates` | — | List only templates |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `json` | Output format: json or text |

#### automation show

Inspect one saved automation or select a template with `--template`.

```text
0 automation show [options] [id]
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--template <id>` | — | Show a template definition |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `json` | Output format: json or text |

#### automation create

Create an automation from a template or a JSON definition.

```text
0 automation create [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--template <id>` | — | Start from a template (see `0 sentinels list --automation --templates`) |
| `--file <path>` | — | Definition JSON object |
| `--name <name>` | — | Name for the new automation |
| `--target <target>` | — | Target the automation runs against |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### automation edit

Replace an automation's definition from a JSON file.

```text
0 automation edit [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--file <path>` **required** | — | Definition JSON object |
| `--revision <n>` | — | Reviewed revision to edit (default: the current one) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### automation duplicate

Save a copy of an automation.

```text
0 automation duplicate [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--name <name>` | — | Name for the copy |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### automation versions

List saved revisions of an automation.

```text
0 automation versions [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### automation rollback

Restore an earlier revision as a new revision.

```text
0 automation rollback [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--revision <n>` **required** | — | Revision to restore (see `0 sentinels set --automation versions`) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### automation delete

Delete a saved automation and its schedules.

```text
0 automation delete [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--revision <n>` | — | Reviewed revision to delete (default: the current one) |
| `--yes` | — | Confirm deletion |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

### threads

Inspect and control the same live sessions used by the browser. Attach with --engine or --engine-url/--engine-token-env, or use the discovered local engine. Session operations preserve current engine admission grants.

```text
0 threads
```

```bash
0 threads list --engine production
```

Subcommands: [list](#threads-list) · [show](#threads-show) · [send](#threads-send) · [start](#threads-start) · [stop](#threads-stop) · [create](#threads-create) · [continue](#threads-continue) · [cancel](#threads-cancel) · [force-stop](#threads-force-stop) · [events](#threads-events) · [resume](#threads-resume) · [decide](#threads-decide) · [retry](#threads-retry) · [set](#threads-set) · [rename](#threads-rename) · [clear](#threads-clear) · [close](#threads-close) · [archive](#threads-archive) · [delete](#threads-delete) · [export](#threads-export).

#### threads list

List live sessions, or retained snapshots with --saved. Listing does not resume work.

```text
0 threads list [options]
```

```bash
0 threads list --saved --engine production
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--saved` | — | List retained thread snapshots |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `text` | Output format: json or text |
| `--json` | — |  |

#### threads show

Read an existing live session without recreating it or restoring approvals.

```text
0 threads show [options] <id>
```

```bash
0 threads show SESSION_ID --engine production
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--wait` | — | Wait for the answer; stdout is the reply only (thread id and usage go to stderr) |
| `--timeout <seconds>` | `600` | Maximum seconds to wait with --wait |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `text` | Output format: json or text |
| `--json` | — |  |

#### threads create

Create a session within the engine's authorized workspace and model configuration. --config reads a bounded JSON object; it cannot expand engine grants.

```text
0 threads create [options]
```

```bash
0 threads create --config session.json --engine production
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--config <path>` | — | Thread configuration JSON object |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `json` | Output format: json or text |
| `--json` | — |  |

#### threads send

Send text to a live engine session. The engine runs the turn using its configured provider and tools.

```text
0 threads send [options] <id> <text>
```

```bash
0 threads send SESSION_ID "Review the current findings" --engine production
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `text` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--wait` | — | Wait for the answer; stdout is the reply only (thread id and usage go to stderr) |
| `--timeout <seconds>` | `600` | Maximum seconds to wait with --wait |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `text` | Output format: json or text |
| `--json` | — |  |

#### threads continue

Continue the selected live session with optional text. This preserves the existing engine context.

```text
0 threads continue [options] <id> [text]
```

```bash
0 threads continue SESSION_ID --engine production
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `text` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--wait` | — | Wait for the answer; stdout is the reply only (thread id and usage go to stderr) |
| `--timeout <seconds>` | `600` | Maximum seconds to wait with --wait |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `text` | Output format: json or text |
| `--json` | — |  |

#### threads cancel

Explicitly cancel the session's active work. Transport disconnect alone does not request cancellation from an attached engine.

```text
0 threads cancel [options] <id>
```

```bash
0 threads cancel SESSION_ID --engine production
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `text` | Output format: json or text |
| `--json` | — |  |

#### threads events

Read engine session events after an optional nonnegative cursor. Cursors belong to that engine and session.

```text
0 threads events [options] <id>
```

```bash
0 threads events SESSION_ID --after 0 --engine production
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--after <cursor>` | — | Nonnegative engine event cursor |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `json` | Output format: json or text |
| `--json` | — |  |

#### threads force-stop

Explicitly stop a qualified session's owned execution process and registered resources. Use the exact **live** ID from `0 threads list`; this command never restores a saved chat or substitutes a replacement session. The owning engine checks authorization and supervisor availability. Unsupported execution returns an error, and unconfirmed teardown remains quarantined. No automatic escalation or replay occurs.

```text
0 threads force-stop [options] <id>
```

```bash
0 threads force-stop LIVE_SESSION_ID --engine production
0 threads force-stop LIVE_SESSION_ID --engine-url http://127.0.0.1:48123 --engine-token-env ZERO_ENGINE_TOKEN
```

Force stop is available for qualified Bun sessions on macOS/Linux; completed external effects are not undone. Inspect `0 threads show` after an error before taking another action.

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `text` | Output format: json or text |
| `--json` | — |  |

#### threads resume

Restore a retained snapshot as a new session under current engine grants. Stored transcripts do not restore approval or filesystem grants.

```text
0 threads resume [options] <saved-id>
```

```bash
0 threads resume SAVED_ID --engine production
```

| Argument | Required | Description |
| --- | --- | --- |
| `saved-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `text` | Output format: json or text |
| `--json` | — |  |

#### threads decide

Respond to an existing session decision using a JSON response file. The engine checks the decision belongs to that live session.

```text
0 threads decide [options] <id> <decision-id>
```

```bash
0 threads decide SESSION_ID DECISION_ID --response response.json --engine production
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `decision-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--response <path>` **required** | — | Decision response JSON object |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database of the local engine |
| `--format <format>` | `json` | Output format: json or text |
| `--json` | — |  |

#### threads start

Create a thread, send the first prompt and print its ID. With `--wait`, block until the turn ends and print the reply.

```text
0 threads start [options] <prompt>
```

```bash
0 threads start "Triage the open findings" --model gpt-5 --effort high --mode recon --wait
```

| Argument | Required | Description |
| --- | --- | --- |
| `prompt` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--model <model>` | — | Model for this thread |
| `--effort <level>` | — | Reasoning effort: minimal, low, medium, high, xhigh |
| `--approvals <ask\|auto>` | — | Moved to the global setting |
| `--folder <path>` | — | Folder the thread works in |
| `--skill <id>` | — | Built-in skill to follow; if it declares a check, the harness runs it and the thread cannot claim Verified without it |
| `--title <title>` | — | Thread title |
| `--wait` | — | Wait for the answer; stdout is the reply only (thread id and usage go to stderr) |
| `--cost-ceiling <usd>` | — | Stop the thread when its estimated spend reaches this many USD |
| `--timeout <seconds>` | `600` | Maximum seconds to wait with --wait |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |
| `--json` | — | Print the engine response as JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### threads stop

Cancel a thread's active work. `--force` force stops owned execution that did not drain.

```text
0 threads stop [options] <id>
```

```bash
0 threads stop 3f2a --force
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--force` | — | Force stop owned execution that did not drain |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |
| `--json` | — | Print the engine response as JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### threads retry

Re-run the last turn of a thread.

```text
0 threads retry [options] <id>
```

```bash
0 threads retry 3f2a
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |
| `--json` | — | Print the engine response as JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### threads set

Change a thread's model, reasoning effort, mode or folder. A computer is chosen when the thread starts.

```text
0 threads set [options] <id>
```

```bash
0 threads set 3f2a --mode copilot --folder ~/code/app
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--model <model>` | — | Model |
| `--effort <level>` | — | Reasoning effort: minimal, low, medium, high, xhigh |
| `--approvals <ask\|auto>` | — | Moved to the global setting |
| `--folder <path>` | — | Folder the thread works in |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |
| `--json` | — | Print the engine response as JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### threads rename

Rename a thread, or generate a new title from its conversation.

```text
0 threads rename [options] <id> [title]
```

```bash
0 threads rename 3f2a --regenerate
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `title` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--regenerate` | — | Generate a new title from the conversation |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |
| `--json` | — | Print the engine response as JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### threads clear

Erase a thread's conversation but keep the thread. Requires `--yes`.

```text
0 threads clear [options] <id>
```

```bash
0 threads clear 3f2a --yes
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm the destructive action |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |
| `--json` | — | Print the engine response as JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### threads close

Stop and close a live thread. Its saved copy stays.

```text
0 threads close [options] <id>
```

```bash
0 threads close 3f2a
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |
| `--json` | — | Print the engine response as JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### threads archive

Archive a thread, or a retained snapshot with `--saved`.

```text
0 threads archive [options] <id>
```

```bash
0 threads archive 3f2a
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--saved` | — | The ID is a retained snapshot, not a live thread |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |
| `--json` | — | Print the engine response as JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### threads delete

Permanently delete a thread or, with `--saved`, a retained snapshot. Requires `--yes`.

```text
0 threads delete [options] <id>
```

```bash
0 threads delete 3f2a --yes
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--saved` | — | The ID is a retained snapshot, not a live thread |
| `--yes` | — | Confirm the destructive action |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |
| `--json` | — | Print the engine response as JSON |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### threads export

Export a thread transcript as JSON or Markdown.

```text
0 threads export [options] <id>
```

```bash
0 threads export 3f2a --format md -o transcript.md
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--saved` | — | The ID is a retained snapshot, not a live thread |
| `--format <format>` | `json` | json or md |
| `-o, --output <file>` | — | Write to a file instead of stdout |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--computer <id>` | — | Use a registered remote computer |
| `--engine <id>` | — |  |
| `--computers-config <path>` | — | Operator computer connection registry JSON file |
| `--engines-config <path>` | — |  |
| `--db-path <path>` | — | Control database of the local engine to attach to |
| `--json` | — | Print the engine response as JSON |

### sentinels

Create, inspect and control Sentinels.

```text
0 sentinels
```

Subcommands: [list](#sentinels-list) · [run](#sentinels-run) · [set](#sentinels-set) · [show](#sentinels-show) · [presets](#sentinels-presets) · [create](#sentinels-create) · [pause](#sentinels-pause) · [resume](#sentinels-resume) · [acknowledge](#sentinels-acknowledge) · [archive](#sentinels-archive) · [delete](#sentinels-delete) · [activations](#sentinels-activations) · [files](#sentinels-files) · [triggers](#sentinels-triggers) · [webhook](#sentinels-webhook).

#### sentinels list

List Sentinels.

```text
0 sentinels list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--status <status>` | — | Only active, paused, archived |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels show

Show a Sentinel (full or prefix ID).

```text
0 sentinels show [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels presets

List Sentinel presets.

```text
0 sentinels presets [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels create

Create a Sentinel from a preset or a JSON definition.

```text
0 sentinels create [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--preset <id>` | — | Start from a preset (see `0 sentinels list --presets`) |
| `--name <name>` | — | Name |
| `--file <path>` | — | Sentinel JSON object (overrides preset fields) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels set

Change a Sentinel's settings.

```text
0 sentinels set [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--name <name>` | — | Name |
| `--purpose <text>` | — | One-line purpose |
| `--mission <text>` | — |  |
| `--file <path>` | — | Patch JSON object |
| `--version <n>` | — | Reviewed version (default: the current one) |
| `--state <state>` | — | active, paused, acknowledged, archived or deleted |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels pause

Pause a Sentinel.

```text
0 sentinels pause [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels resume

Resume a paused Sentinel.

```text
0 sentinels resume [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--acknowledge` | — | Also acknowledge review of changed model or tools |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels acknowledge

Mark changed model or tools as reviewed.

```text
0 sentinels acknowledge [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels archive

Archive a Sentinel; its history stays.

```text
0 sentinels archive [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels delete

Delete a Sentinel; its automations are detached, not deleted.

```text
0 sentinels delete [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm deletion |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels run

Run a Sentinel now; starts a thread (needs a running engine).

```text
0 sentinels run [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--task <text>` | — | Task for this run |
| `--yes` | — | Confirm that this run is authorized |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels activations

List a Sentinel's recent runs.

```text
0 sentinels activations [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--limit <n>` | `50` | Maximum rows (1-200) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |


#### sentinels files

Read and edit a Sentinel's instructions and memory files.

```text
0 sentinels files
```

Subcommands: [list](#sentinels-files-list) · [get](#sentinels-files-get) · [put](#sentinels-files-put) · [rm](#sentinels-files-rm).

#### sentinels files list

List files.

```text
0 sentinels files list [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels files get

Print a file's content.

```text
0 sentinels files get [options] <id> <path>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `path` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels files put

Create or replace a file from --file or --content.

```text
0 sentinels files put [options] <id> <path>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `path` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--file <path>` | — | Read content from a local text file |
| `--content <text>` | — | Inline content |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels files rm

Delete a file.

```text
0 sentinels files rm [options] <id> <path>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `path` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm deletion |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels triggers

Control what starts a Sentinel's automations.

```text
0 sentinels triggers
```

Subcommands: [list](#sentinels-triggers-list) · [add](#sentinels-triggers-add) · [enable](#sentinels-triggers-enable) · [disable](#sentinels-triggers-disable) · [check](#sentinels-triggers-check) · [rm](#sentinels-triggers-rm).

#### sentinels triggers list

List triggers.

```text
0 sentinels triggers list [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels triggers add

Add a trigger for an automation the Sentinel owns; disabled unless --enable --yes.

```text
0 sentinels triggers add [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--automation <id>` | — | What the trigger starts (default: the only one this Sentinel owns) |
| `--kind <kind>` | — | schedule \| manual \| github-pr |
| `--file <path>` | — | Trigger JSON object with schedule or github settings |
| `--enable` | — | Enable immediately |
| `--yes` | — | Confirm that an enabled trigger was reviewed |
| `--frequency <frequency>` | — | schedule: minutes, hourly, daily, weekdays, weekly, cron |
| `--every <minutes>` | — | schedule, minutes: interval (5 or more) |
| `--at <HH:MM>` | — | schedule, daily, weekdays, weekly: local time |
| `--weekday <day>` | — | schedule, weekly: sun, mon, ... or 0-6 |
| `--cron <expression>` | — | schedule, cron: five fields |
| `--timezone <zone>` | — | schedule: IANA timezone (default UTC) |
| `--repo <owner/name>` | — | github-pr: repository to watch |
| `--base-branch <branch>` | — | github-pr: only pull requests into this branch |
| `--comment` | — | github-pr: comment on each pull request with one short summary, edited in place on later pushes (default: off) |
| `--include-forks` | — | github-pr: also review pull requests from forks, marked untrusted (default: skipped) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels triggers enable

Enable a trigger after reviewing it.

```text
0 sentinels triggers enable [options] <id> <trigger-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `trigger-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm that this trigger was reviewed |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels triggers disable

Pause a trigger.

```text
0 sentinels triggers disable [options] <id> <trigger-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `trigger-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels triggers check

Poll a pull request trigger now instead of waiting for its next poll.

```text
0 sentinels triggers check [options] <id> <trigger-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `trigger-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels triggers rm

Delete a trigger.

```text
0 sentinels triggers rm [options] <id> <trigger-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `trigger-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm deletion |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels webhook

GitHub webhook for pull request Sentinels (server mode). Hidden: most installs poll. See [Sentinels](/sentinels/#faster-with-a-github-webhook-server-mode).

```text
0 sentinels webhook
```

Subcommands: [status](#sentinels-webhook-status) · [secret](#sentinels-webhook-secret).

#### sentinels webhook status

Show whether the webhook is set up and the last deliveries.

```text
0 sentinels webhook status [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

#### sentinels webhook secret

Manage the webhook secret.

```text
0 sentinels webhook secret
```

Subcommands: [rotate](#sentinels-webhook-secret-rotate).

#### sentinels webhook secret rotate

Create the secret, or replace it; the old one keeps working for 5 minutes. Printed once.

```text
0 sentinels webhook secret rotate [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm; update the secret on GitHub afterwards |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |
| `--format <format>` | — | Output: text or json Choices: text, json. |

## Team workspace setup

### config team

```text
0 config team
```

Provision opt-in accounts for a customer-controlled team engine. Account-free local
use remains the default. Creating a config does not activate it on a running host.
See [Team workspaces](/computers/) for roles and deployment boundaries.

Subcommands: [init](#config-team-init) · [add-user](#config-team-add-user) · [list](#config-team-list).

### config team init

Create a private configuration with the first owner account. The password is read
from protected terminal input or stdin; it is stored as a salted password hash.
No email invitation is sent. Then start `0 web --team-config <path>`.

```text
0 config team init [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--config <path>` **required** | — | Configuration file to create |
| `--name <name>` **required** | — | Workspace name |
| `--owner <id>` **required** | — | Owner account ID |
| `--display-name <name>` **required** | — | Owner display name |

### config team add-user

Add an explicit account to a private configuration. Assign `owner`, `editor` or
`viewer`; viewer access does not grant agent control. Restart the team engine to
load configuration changes. Password input is not a command-line argument.

```text
0 config team add-user [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--config <path>` **required** | — | Team configuration |
| `--user <id>` **required** | — | Account ID |
| `--display-name <name>` **required** | — | Display name |
| `--role <role>` **required** | — | owner, editor or viewer |

### config team list

List configured account IDs, display names and roles without password hashes.
The configuration must remain a private regular file.

```text
0 config team list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--config <path>` **required** | — | Team configuration |
