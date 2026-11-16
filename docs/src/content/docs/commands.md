---
title: CLI reference
description: 0 CLI commands, arguments, options, aliases, and registered defaults.
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 2
---

Pick your task below, or search for a command name.

New to 0? Read the [Quickstart](/) first, then [Scan code](/scan-code/) or [Scan web and APIs](/scan-web/). Settings and environment variables are on [Configuration](/configuration/).

## Start by task

<div class="docs-task-grid">
  <section class="docs-task-card">
    <h3>Scan</h3>
    <p>Assess a repository, a package, or a live web app, API or MCP endpoint with one command.</p>
    <p><a href="#the-nine-commands">scan &lt;target&gt;</a> · <a href="#scan-source">source options</a> · <a href="#scan-package">package options</a> · <a href="#scan-web">web options</a> · <a href="#scan-deep">deep</a> · <a href="#scan-deps">dependencies</a></p>
    <p>Guides: <a href="/scan-code/">Scan code</a> · <a href="/scan-web/">Scan web and APIs</a> · <a href="/dependencies/">Dependencies</a></p>
  </section>
  <section class="docs-task-card">
    <h3>Verify and fix</h3>
    <p>Reproduce an issue, validate a source fix, and close the loop.</p>
    <p><a href="#scan-verify">scan verify</a> · <a href="#scan-fix">scan fix</a> · <a href="#scan-repair">repair</a> · <a href="#scan-disclose">scan disclose</a></p>
    <p>Guides: <a href="/verify-and-fix/">Verify and fix</a> · <a href="/reports/">Reports and disclosure</a></p>
  </section>
  <section class="docs-task-card">
    <h3>Review findings and threads</h3>
    <p>Triage the findings queue, then follow, continue or stop threads.</p>
    <p><a href="#findings">findings</a> · <a href="#findings-update">findings update</a> · <a href="#threads">threads</a> · <a href="#lab-runs">scan runs</a></p>
    <p>Guide: <a href="/findings/">Findings</a></p>
  </section>
  <section class="docs-task-card">
    <h3>Automate</h3>
    <p>Run Agents and saved automations, use 0 in CI, and connect coding agents.</p>
    <p><a href="#agents">agents</a> · <a href="#automation">automations</a> · <a href="#lab-mcp-server">mcp-server</a> · <a href="#api">api</a></p>
    <p>Guides: <a href="/automations/">Automations</a> · <a href="/ci/github-action/">CI/CD</a> · <a href="/mcp/">MCP servers</a></p>
  </section>
  <section class="docs-task-card">
    <h3>Investigate further</h3>
    <p>Specialist discovery, binary analysis, fuzzing and agent assurance.</p>
    <p><a href="#lab-research">research</a> · <a href="#lab-research-hunt">hunt</a> · <a href="#lab-research-memsafety">memsafety</a> · <a href="#lab-research-binary">binary</a> · <a href="#scan-agent-assure">agent-assure</a></p>
    <p>Guide: <a href="/research-workflows/">Specialist research</a></p>
  </section>
  <section class="docs-task-card">
    <h3>Set up and extend</h3>
    <p>Open the app, connect a model, check the install, and add skills and plugins.</p>
    <p><a href="#config">config</a> · <a href="#config-doctor">config doctor</a> · <a href="#models">models</a> · <a href="#models-connect">models connect</a> · <a href="#skills">skills</a> · <a href="#computers">computers</a> · <a href="#web">0 (web console)</a></p>
    <p>Guides: <a href="/models/">Models and keys</a> · <a href="/plugins/">Plugins</a> · <a href="/engines/">Remote engines and teams</a></p>
  </section>
</div>

## The nine commands

`0` with no arguments opens the web console. Everything else is one of nine commands, each with at most three subcommands in `--help`. The sections below also document the earlier names, which still work for one release and print `moved: use ...` on a terminal. See [CLI changes in 0.35](/cli-changes-0-35/) for every old command and what replaces it.

| Command | What it does | Subcommands |
| --- | --- | --- |
| `0 scan <target>` | Scan a URL, a folder or repository, or `npm:`, `pypi:`, `cargo:`, `oci:` packages. `--module deep\|repair\|campaign\|deps\|deps-fix` picks a module that has no target-detecting form. | `fix`, `verify`, `disclose` |
| `0 findings` | Browse findings and change their status. `--format` exports, `--import` loads a report. | `list`, `show`, `update` |
| `0 threads` | Start, follow and stop threads. | `list`, `send`, `stop` |
| `0 agents` | Agents and, with `--automation`, saved automations. | `list`, `run`, `set` |
| `0 skills` | Skills, plugins, MCP servers and connectors. | `list`, `add`, `run` |
| `0 memory` | What 0 remembers across threads. | `list`, `set`, `export` |
| `0 models` | Models and provider connections. | `list`, `set`, `connect` |
| `0 computers` | Remote computers that run 0. | `list`, `add`, `stop` |
| `0 config` | Settings, API keys, team setup and `config doctor`. | `get`, `set`, `doctor` |

`0 doctor` stays as an alias of `0 config doctor`. `0 api` and `0 lab` are hidden developer commands. The old top-level names `web`, `plugin` and `automation` are hidden aliases for one release.

## Invocation and safety

Run commands as `0 <command>`. Check your release with `0 --version` and
command-specific `--help`.

The browser app's chat uses the same words as slash commands: `/threads list`,
`/findings list`, `/models default` and `/config get` mirror `0 threads list`,
`0 findings list`, `0 models set` and `0 config get`. `scan` is CLI-only. See [Slash commands](/app/#slash-commands).

Option tables show registration defaults. **— means no default is registered**:
a handler may resolve configuration or require an explicit value. Inverse
`--no-*` options show the underlying positive boolean default. See
[Configuration](/configuration/) for environment and runtime resolution.

- With no arguments, `0` opens the browser app. No account is needed. See [Browser app](/app/).
- `0 -p` / `0 --print` run one headless chat prompt. Combine `--resume <id>` or `--continue` with a prompt to continue a saved conversation. Scan sessions use `0 lab runs relaunch`.
- `0 --help` lists 9 top-level commands. Every earlier command name and flag still works for one release through hidden aliases with identical behaviour and exit codes. On a terminal (not when piped, in CI or with `--json`) an old name prints one dim `moved: use ...` line to stderr.
- Use explicit commands in automation. Recognizable bare targets are routed automatically; ambiguous input is refused.
- Scope, provider authentication, target authentication, filesystem access, and execution isolation have independent controls. See [Scope and authorization](/scope/).
- The operator-global SmolVM profile runs the entire CLI inside an online Kali guest, preserving original arguments and terminal streams. `workbench` and `config` remain host management commands. No Colima/Docker daemon is needed at runtime; failures never choose host execution implicitly.
- Check the workflow's outcome and verification status after a command completes. Verification exit codes vary by path.
- Before exporting reports, invoking plugins, preparing disclosures, or running queued work, check the inputs and permissions. These actions can write externally or execute code.

## Replacements for moved commands

These subcommands carry the arguments of the commands they replace; `command-compat.ts` translates them onto the older implementation commands documented in the other sections.

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

### skills run

Run a skill or a plugin tool. It takes the arguments of `plugin run`.

```text
0 skills run <name> [tool] [pairs...]
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |
| `tool` | No |  |
| `pairs` | No |  |

### memory set

Turn a memory on or off (`0 memory set <id> on|off`), load memories with `--import <file>`, or manage triage memories with `--add` and `--remove <id>`.

```text
0 memory set [options] [id] [on|off]
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | No |  |
| `on\|off` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--import <file>` | — | Import memories from a file |
| `--add` | — | Add a triage memory (see findings triage) |
| `--remove` | — | Remove a triage memory |

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
| `--list` | — | List connections |
| `--test` | — | Test a connection |
| `--remove` | — | Remove a connection |

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

## Interactive & setup

### lab

Developer commands that most people never need: `research`, `improve`, `console`, `mcp-server` and `runs`. `lab` is hidden from `0 --help` to keep the main list short.

```text
0 lab
```

Subcommands: [research](#lab-research) · [improve](#lab-improve) · [console](#lab-console) · [mcp-server](#lab-mcp-server) · [runs](#lab-runs).

### lab console

Run chat with the full tool registry: recon, web, source-scan, variant-hunt, verify, and patch-gen.

```text
0 lab console [options]
```

Interactive chat uses `0 web`. `0 lab console --print` and `0 -p` run headlessly; without a prompt they point to the browser. Model credentials, target scope, and managed-service credentials are separate.

Guide: [Read the workflow](/app/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the engine token |
| `--format <format>` | `text` | Output format: text, json, ndjson |
| `--target <url>` | — | Engagement target the tools operate against (optional; can be named in-chat) |
| `--scope <file>` | — | Initial authorization scope. Headless auto approvals require at least one in_scope entry when scope enforcement is active; scope is not OS isolation. |
| `--finding <id>` | — | Focus the chat on one persisted finding |
| `--finding-intent <intent>` | — | Finding workflow: investigate, verify, draft_fix, or impact. These instructions do not independently enforce tool permissions. |
| `--db-path <path>` | — | Persistent findings database (defaults to ZERO_DB_PATH or the local store) |
| `-m, --model <id>` | — | Model selection for headless chat; saved-session model takes precedence when resuming. |
| `--role <role>` | — | Tool set to expose: audit, review, discovery, attack, verify, or report. Defaults to audit; role selection is not authorization or OS isolation. |
| `--approvals <ask\|auto>` | — | ask puts each command or change to you first (headless runs cannot answer, so effectful tools are refused). auto, the default, runs commands without asking. Credential, private-network and sandbox protections apply either way. Overrides the approvals setting. |
| `--max-tool-calls <n>` | — | Optional tool-call round limit per message (unlimited by default) |
| `--allow-scanners` | — | Expose generic-scanner tool wrappers (sqlmap/nikto/…); default off |
| `--resume [id]` | — | With a headless prompt, reopen a saved chat by id or unique prefix; use browser history for a picker. |
| `--continue` | — | With a headless prompt, continue the most recent saved console chat. |
| `-p, --print [prompt]` | — | Non-interactive: run ONE prompt through the engine, print the result, and exit. Reads the prompt from the argument or piped stdin. Combine with --continue/--resume to query a saved session. Also reachable as `0 -p &lt;prompt&gt;`. |
| `--engine <id>` | — | Use a registered remote engine |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--chat <id>` | — | Send to an existing live engine chat |

#### Approvals

See [Browser app](/app/#approvals) for Ask and Auto behavior. Approvals never grant testing authorization.

#### Approval prompts

Tool, network-scope, and directory approvals are distinct gates. Per-action prompts (the Ask before running commands setting) require a wired approval callback, and callback-free headless paths do not fail closed. Headless execution cannot answer an interactive request. Check the [console mode and launcher limitations](/app/) before relying on an approval boundary.

#### Session persistence

Console transcript resume differs from scan journal continuation. See [Browser app](/app/) and [Scan web and APIs](/scan-web/).

#### Console settings

The canonical settings reference is [Configuration](/configuration/).

### web

Open the local browser workspace for threads, scans and findings.

```text
0 web [options]
```

Guide: [Read the workflow](/app/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--port <port>` | `48123` | Port to bind; 0 chooses a free loopback port |
| `--host <host>` | `127.0.0.1` | Loopback host to bind (127.0.0.0/8 or ::1) |
| `--asset-dir <path>` | — | Path to built dashboard assets |
| `--dev-url <url>` | — | Loopback Vite server for authenticated frontend hot reload |
| `--team-config <path>` | — | Enable workspace accounts, roles, and shared conversation controls |
| `--engine-token-env <name>` | — | Environment variable holding the engine bearer credential (32–4096 characters) |
| `--engine-workspace <path>` | — | Engine-owned authorized workspace for persistent workflow calls |
| `--engine-scope <path>` | — | Engine-owned scope JSON for persistent live-target workflows |
| `--engine-target <target>` | — | Restrict persistent workflow calls to this target |
| `--engine-allow-apply` | — | Admit explicitly approved patch application in persistent workflow calls |
| `--engine-time-cap <ms>` | — | Server workflow deadline ceiling (default 600000 ms) |
| `--engine-cost-cap <usd>` | — | Server workflow estimated cost ceiling (default $5) |
| `--server-mode` | — | Serve the console to a network behind a TLS proxy: requires sign-in, an allowed-host list and a single node (off by default) |
| `--allowed-host <host...>` | — | Server mode: accepted Host header names (default: only the bind host); also ZERO_ALLOWED_HOSTS |
| `--trusted-proxy <cidr...>` | — | Server mode: proxy addresses or CIDRs whose X-Forwarded-* headers are trusted; also ZERO_TRUSTED_PROXY |
| `--public-url <url>` | — | Server mode: the public https URL of this console (sign-in cookies, single sign-on); also ZERO_PUBLIC_URL |
| `--access-token-env <name>` | — | Server mode: environment variable holding the access token (32+ characters); default ZERO_ACCESS_TOKEN, else one is generated |
| `--shutdown-timeout <seconds>` | — | Server mode: seconds to finish in-flight requests on SIGTERM (default 20) |
| `--ready-json` | — | Emit the bound dashboard URL as machine-readable JSON |
| `--no-open` | — | Do not auto-open a browser |
| `--headless` | — | Serve the API only: no browser, and no dashboard assets needed (use with `0 threads`) |
| `--engines-config <path>` | — | Trusted engine connection registry JSON (default ~/.0/engines.json) |

### api

Call an admitted HTTP API on a running engine without sending a model prompt.

```text
0 api [options] [path]
```

Guide: [Control a running web backend](/engines/).

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
argument. Existing server authentication, scope and approval checks still apply.

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
starting an assessment. See [CI reports in the browser](/ci/github-action/#review-ci-reports-in-the-browser).

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

Guide: [Read the workflow](/troubleshooting/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--discard-reports` | — | Delete crash reports waiting for review on this computer |

Subcommands: [upgrade](#doctor-upgrade) · [workbench](#doctor-workbench) · [checks](#doctor-checks).

### config

Inspect, export, and import the two-level console configuration

```text
0 config
```

Guide: [Read the workflow](/configuration/).

Subcommands: [get](#config-get) · [set](#config-set) · [doctor](#config-doctor) · [show](#config-show) · [list](#config-list) · [reset](#config-reset) · [export](#config-export) · [import](#config-import) · [audit-log](#config-audit-log) · [team](#config-team) · [db](#config-db) · [github](#config-github).

#### config show

Show each setting's effective value and source: default, global, or project.

```text
0 config show [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON |

#### config list

Same as `config show`. Add `--json` for each key's value and source layer.

```text
0 config list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON |

#### config get

Print one setting's effective value. `--json` adds the layer it comes from.

```text
0 config get [options] <key>
```

| Argument | Required | Description |
| --- | --- | --- |
| `key` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON with the source layer |

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
| `--project` | — | Write the per-project override |
| `--yes` | — | Confirm a security-sensitive setting |
| `--json` | — | Print JSON |

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
| `--project` | — | Import into the per-project override instead of the global config |
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

#### models recommended

Show the recommended model for each role, chosen from your connected providers.

```text
0 models recommended [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print JSON |

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
| `--by <model\|mission>` | — | Group by model (default) or list each thread |
| `--json` | — | Print JSON |

### config audit-log

Show the local log of privileged actions: connection and settings changes, plugin installs and denied attempts. The log is append-only.

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

### doctor workbench

Set up and inspect the online SmolVM security workbench on
Apple Silicon macOS. The local Linux guest contains 0, the security tools and
the browser; Docker is not required to run the workbench.

```text
0 doctor workbench
```

Guide: [Execution profile and grants](/configuration/#execution-profile).

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
Use `0 lab console` or `0 web` to start a chat; do not invoke this transport endpoint
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

Guide: [Update checks](/configuration/#update-checks).

| Option | Registered default | Description |
| --- | --- | --- |
| `--version <tag>` | — | Pin a specific release tag (e.g. v0.10.0) |
| `--install-dir <path>` | — | Override the install directory (default: the folder of this binary, else ~/.0/bin) |
| `--scan-dependencies` | — | Scan the current project before upgrading |
| `--fix-dependencies` | — | Refuse upgrade when vulnerabilities are present; use `0 scan . --module deps-fix --yes` to remediate |

### scan deps

Scan and remediate project dependencies for known vulnerabilities.

```text
0 scan deps
```

Subcommands: [scan](#scan-deps-scan) · [fix](#scan-deps-fix).

#### scan deps scan

Run the native advisory database scanner for the current project.

```text
0 scan deps scan [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--cwd <path>` | — | Project directory |
| `--ecosystem <name>` | — | Override detected ecosystem: npm, pnpm, cargo, pypi |
| `--json` | — | Emit machine-readable output |

#### scan deps fix

Apply the ecosystem package manager's supported vulnerability fixes.

```text
0 scan deps fix [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--cwd <path>` | — | Project directory |
| `--ecosystem <name>` | — | Override detected ecosystem: npm, pnpm, cargo, pypi |
| `--yes` | — | Apply changes; without this flag print the command only |

## Scan & source review

### scan campaign

Run a sequence of objective-driven security-testing threads for an authorized target.
Provide a JSON scope policy with `--scope`; iterations run with automatic approvals and appear in
an attached local engine's console. If no engine is available on the selected
database, the supervisor falls back to headless chat children.

```text
0 scan campaign [options]
```

The supervisor retains iteration state in an atomic journal and stops at the
iteration or wall-clock limits, or when the model declares coverage complete.
`--max-tool-calls` applies to headless fallback children; `--cost-ceiling` applies
to the optional `--with-scan` run, rather than the whole campaign's model usage.
Objective generation and docs triage also use models. `--dry-run` prints the
iteration plan without starting threads or scans. With `--docs-url`, published docs
are fetched for model-assisted severity triage; use `--no-docs-triage` to disable it.

| Option | Registered default | Description |
| --- | --- | --- |
| `--target <url>` **required** | — | Target URL or mcp:// endpoint |
| `--iterations <n>` | `3` | Total objective-driven chat iterations (default 3) |
| `--run-timeout-ms <ms>` | `3600000` | Wall-clock cap per iteration (default 3600000) |
| `--total-timeout-ms <ms>` | `14400000` | Hard cap for the whole campaign (default 14400000 = 4h) |
| `--cost-ceiling <usd>` | `10` | Per-scan-run cost ceiling passed through with --with-scan (default 10) |
| `--max-tool-calls <n>` | `150` | Tool-call cap for headless fallback chat children (default 150) |
| `--model <id>` | `openrouter/z-ai/glm-5.3-flash` | Model id for objective generation and threads |
| `--identities <file>` | — | Passed through to --with-scan and referenced by briefs |
| `--access-control-fixtures <file>` | — | Passed through to --with-scan and referenced by briefs |
| `--scope <file>` **required** | — | REQUIRED: JSON scope policy (chat sessions run with automatic approvals) |
| `--db-path <path>` | — | Findings db (default: &lt;target-sanitized&gt;.db in cwd) |
| `--journal <path>` | — | Campaign journal (default: &lt;db-path&gt;.campaign.json) |
| `--rate-limit <spec>` | `5` | Rate limit passthrough for --with-scan (default 5) |
| `--pause-between-ms <ms>` | `30000` | Cool-off between iterations (default 30000) |
| `--with-scan` | `false` | Prepend one classic breadth-scan iteration before the chat loop |
| `--dry-run` | `false` | Print the planned iteration sequence and exit without spawning anything |
| `--format <format>` | `terminal` | Supervisor output format: terminal\|json |
| `--docs-url <url>` | — | Fetch this published-docs URL once per campaign for docs-grounded severity triage of new findings |
| `--docs-url-2 <url>` | — | Optional second docs URL for triage context |
| `--no-docs-triage` | — | Disable docs-grounded severity triage (default ON when --docs-url is provided) |

### scan

Assess a target with one entry point. `0 scan <target>` picks the module from the
target: a URL or `mcp://` endpoint runs `web`, a path or git URL runs `source`,
and `npm:`, `pypi:` and similar identifiers run `package`. Name a module to force it.

```text
0 scan
```

Examples: `0 scan https://app.example.com`, `0 scan .`, `0 scan npm:express`, `0 scan repair . --test-command "npm test"`.

| Module | Purpose |
| --- | --- |
| `web` | Live web app, API or MCP server (requires authorization and scope) |
| `source` | Source repository review |
| `package` | Package security review |
| `deep` | Seedless deep source review |
| `repair` | Find, reproduce, fix and verify in a repository |
| `campaign` | Long-running self-directed campaign |

Subcommands: [fix](#scan-fix) · [verify](#scan-verify) · [disclose](#scan-disclose) · [web](#scan-web) · [source](#scan-source) · [package](#scan-package) · [deep](#scan-deep) · [repair](#scan-repair) · [campaign](#scan-campaign) · [deps](#scan-deps) · [eval](#scan-eval) · [agent-assure](#scan-agent-assure).

### scan web

Run autonomous pentest against a URL, web app, or MCP server

```text
0 scan web [options]
```

With the optional scope plugin enabled for the project (`0 plugin enable scope`), live HTTP/HTTPS/MCP targets require an engagement policy, including when `--require-scope` is omitted. A policy file or flag alone does not activate the plugin. See [Scope and authorization](/scope/). `--dry-run` previews PR emission; the scan still executes. Use `--race` for benchmark/CTF workflows. An explicit rate can override the conservative profile's fallback rate.

Guide: [Read the workflow](/scan-web/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--target <target>` **required** | — | Target URL or mcp:// endpoint |
| `--depth <depth>` | `default` | Scan depth: quick, default, deep |
| `--format <format>` | `terminal` | Output format: terminal, json, md, html, sarif, pdf |
| `--runtime <runtime>` | `auto` | Model provider: auto, api, claude, codex |
| `--provider <provider>` | — | Explicit provider: openai API or chatgpt-codex subscription (requires --runtime api) |
| `--cyber-access-program <program>` | — | Explicit standard, daybreak_blue, or daybreak_red; requires --runtime api and explicit --provider openai or chatgpt-codex |
| `--mode <mode>` | — | Scan mode: probe, deep, mcp, web, http_audit (http_audit reads ZERO_TARGET_* env config) |
| `--timeout <ms>` | `30000` | Request timeout in milliseconds; also the scan deadline unless a confirmed plan supplies its time cap |
| `--db-path <path>` | — | Path to SQLite database |
| `--api-key <key>` | — | API key for LLM provider |
| `-m, --model <model>` | — | LLM model to use |
| `--task-model <role=model>` | — | Explicit task model: discovery, attack, verify, report (repeatable) |
| `--routing-report <file>` | — | Reviewed model-api task qualification report; opt-in recommendations only |
| `--routing-model <model>` | — | Approve a model candidate for the reviewed routing plan (repeatable) |
| `--routing-review-ref <ref>` | — | Review reference confirming provider/workflow authorization and model evidence limitations |
| `--goal <goal>` | — | Noninteractive routing goal: known-vulnerabilities, unknown-vulnerabilities, misconfigurations |
| `--plan-time-cap <ms>` | — | Overall wall-clock cap required for a noninteractive routing plan |
| `--single-model` | — | Use the selected model for every task, ignoring task assignments |
| `--no-guided` | — | Skip interactive scan planning and use explicit command options |
| `--repo <path>` | — | Source code path for white-box scanning |
| `--access-control-fixtures <file>` | — | JSON file of known private resource ownership fixtures for IDOR verification |
| `--identities <file>` | — | Restricted JSON file with named test identities for access-control replay |
| `--auth <json>` | — | Auth credentials: JSON string or path (bearer, cookie, basic, header) |
| `--scope <path>` | — | Path to a JSON scope policy (enable with `0 skills list scope --enable`) |
| `--allow-scanners` | `false` | Expose generic scanner tools in scope-enforced scans |
| `--require-scope` | `false` | Refuse unscoped scans while the scope plugin is enabled. Does not activate the plugin; ordinary live targets already require policy when it is enabled. |
| `--attribution-header <name=value>` | — | Header to attach to in-scope requests (repeatable); never sent out-of-scope |
| `--attribution-ua <token>` | — | Engagement token to embed in the User-Agent on in-scope traffic |
| `--api-spec <path>` | — | Path to an OpenAPI/Swagger spec for endpoint knowledge |
| `--export <target>` | — | Export findings to issue tracker (e.g. github:owner/repo) |
| `--race` | `false` | Best-of-N strategy racing (benchmark/CTF only) |
| `--egats` | `false` | Evidence-gated attack tree search |
| `--cost-ceiling <usd>` | — | Soft estimated-model-cost ceiling; partial findings are retained when enforcement trips. In-flight work may overshoot. Overrides ZERO_COST_CEILING_USD. |
| `--rate-limit <spec>` | — | Per-host requests/sec cap, e.g. '5' or 'host=5,*=3' (default 5) |
| `--engagement-profile <name>` | — | Engagement posture: standard (default) or conservative (quieter) |
| `--no-waf-evasion` | — | Disable adaptive WAF-evasion retries |
| `--features <list>` | — | Comma-separated feature flags to enable, e.g. 'fp-moat' |
| `--no-decoy-detection` | — | Disable the anti-honeypot flag validator |
| `--dispatch <mode>` | `auto` | Tool-call protocol: json, xml, auto (legacy loop only) |
| `--emit <target>` | — | Emit mode: 'pr' opens a GitHub PR per reproduced finding |
| `--base <branch>` | — | Base branch for `--emit pr` (default: main) |
| `--dry-run` | `false` | For --emit pr only: print proposed git/gh emission commands. The scan itself still executes. |
| `--emit-out-dir <path>` | — | Directory for `--emit pr` rollup files (default: system temp) |
| `--resume <run-id>` | — | Resume a previous run from its on-disk journal |
| `--branch-from <entry-index>` | — | Branch the journal at an entry index before resuming (with --resume) |
| `--verbose` | `false` | Show detailed output |
| `--replay` | `false` | Replay the last scan's results |

#### `--auth` credential formats

`scan --auth` accepts inline JSON or a JSON file. Use a restricted file for real secrets. Choose one shape:

| Type | JSON value |
| --- | --- |
| Bearer | `{"type":"bearer","token":"test-token"}` |
| Cookie | `{"type":"cookie","value":"session=test-session"}` |
| Basic | `{"type":"basic","username":"test-user","password":"test-password"}` |
| Header | `{"type":"header","name":"X-API-Key","value":"test-key"}` |

<span id="--api-spec--openapi--swagger-import"></span>

#### `--api-spec`: OpenAPI / Swagger import

Import endpoint knowledge. Target authorization is still required. See [Scan web and APIs](/scan-web/).

<span id="--race--best-of-n-strategy-racing"></span>

#### `--race`: best-of-N strategy racing

Use strategy racing for benchmark and CTF targets. Keep it off for normal live-target audits.

<span id="--egats--evidence-gated-attack-tree-search"></span>

#### `--egats`: Evidence-Gated Attack Tree Search

Enable hypothesis-tree search. Findings still require verification. See [Finding Triage](/triage/).

<span id="--cost-ceiling--hard-spend-guardrail"></span>

#### `--cost-ceiling`: spend limit

See [Costs and budgets](/budgets/) for spend versus turn limits and partial outcomes.

#### `--export github:owner/repo`

Creates external GitHub issues. Review destination, permissions, and sensitive evidence first; see [Reports and disclosure](/reports/).

### scan package

Audit a package for security vulnerabilities

```text
0 scan package [options] <package>
```

Guide: [Read the workflow](/scan-code/).

| Argument | Required | Description |
| --- | --- | --- |
| `package` | Yes | package name (e.g. lodash, express, requests) |

| Option | Registered default | Description |
| --- | --- | --- |
| `--ecosystem <ecosystem>` | `npm` | Package ecosystem: npm, pypi, cargo, oci |
| `--package-version <version>` | — | Specific package version to audit (default: latest) |
| `--pkg-version <version>` | — | Alias for --package-version |
| `--ver <version>` | — | Alias for --package-version |
| `--depth <depth>` | `default` | Audit depth: quick, default, deep |
| `--format <format>` | `terminal` | Output format: terminal, json, md, html, sarif, pdf |
| `--runtime <runtime>` | `auto` | Runtime: auto, claude, codex, api |
| `--db-path <path>` | — | Path to SQLite database |
| `--api-key <key>` | — | API key for LLM provider |
| `-m, --model <model>` | — | LLM model to use |
| `--static-only` | `false` | Run only the static layer and skip AI analysis on purpose (exit 0). Without it, a scan that cannot reach a model exits 3. |
| `--cost-ceiling <usd>` | — | Soft estimated-model-cost ceiling; partial findings are retained when enforcement trips. In-flight work may overshoot. Overrides ZERO_COST_CEILING_USD. |
| `--resume <run-id>` | — | Resume a previous run from its journal on disk (0#374) |
| `--branch-from <entry-index>` | — | Branch the journal at the given entry index before resuming (requires --resume). |
| `--verbose` | `false` | Show detailed output |
| `--timeout <ms>` | `600000` | AI agent timeout in milliseconds |

### scan source

Deep source code security review of a repository

```text
0 scan source [options] <repo>
```

Static and AI review produce leads that need runtime verification. `--changed-only` controls static leads and prioritization; model filesystem access is unchanged. `review --auth` is unsupported.

Guide: [Read the workflow](/scan-code/).

| Argument | Required | Description |
| --- | --- | --- |
| `repo` | Yes | Local path or git URL to review |

| Option | Registered default | Description |
| --- | --- | --- |
| `--depth <depth>` | `default` | Review depth: quick, default, deep |
| `--format <format>` | `terminal` | Output format: terminal, json, md, html, sarif, pdf |
| `--runtime <runtime>` | `auto` | Runtime: auto, claude, codex, api |
| `--provider <provider>` | — | Explicit provider: openai API or chatgpt-codex subscription (requires --runtime api) |
| `--cyber-access-program <program>` | — | Explicit standard, daybreak_blue, or daybreak_red; requires --runtime api and explicit --provider openai or chatgpt-codex |
| `--db-path <path>` | — | Path to SQLite database |
| `--api-key <key>` | — | API key for LLM provider |
| `-m, --model <model>` | — | LLM model to use |
| `--static-only` | `false` | Run only the static layer and skip AI analysis on purpose (exit 0). Without it, a scan that cannot reach a model exits 3. |
| `--cost-ceiling <usd>` | — | Soft estimated-model-cost ceiling; partial findings are retained when enforcement trips. In-flight work may overshoot. Overrides ZERO_COST_CEILING_USD. |
| `--diff-base <ref>` | — | Git base ref to review against (for diff-aware review) |
| `--changed-only` | `false` | Restrict static scanner leads + prioritization to changed files |
| `--profile <profile>` | `default` | Review profile: default (web/JS/TS/Python), c-library (C/C++ memory safety, tier-1/2/3 harness), linux-kernel (kernel-aware static review), cardano-onchain (Aiken/Plutus validator logic), solana-onchain (Anchor/native Rust account-model authorization), evm-onchain (Solidity/Foundry/Hardhat DeFi/bridge — reentrancy, oracle manipulation, cross-chain replay), cairo-onchain (Cairo/Starknet DeFi — caller-auth gaps, share-rounding, L1↔L2 messages), move-onchain (Sui/Aptos Move — object/capability binding, shared-math overflow, reward-index accounting), cardano-haskell (first-party Cardano Haskell node stack — ledger/plutus/ouroboros/cardano-base), xnu-kernel (Apple XNU macOS/iOS source review), or xnu-re (decompiled Apple kext pseudo-C) |
| `--target <target>` | — | Alias for --profile; accepts the supported review profiles, with app normalized to default. |
| `--ecosystem <ecosystem>` | — | Review the SOURCE of a published package instead of a repo: npm, pypi, cargo, or oci. When set, &lt;repo&gt; is the package NAME — 0 installs it and reviews its extracted source. Omit for a local path or git URL. |
| `--package-version <version>` | — | Pin the package version to review (only with --ecosystem). Defaults to latest. |
| `--seed-findings <path>` | — | Path to ND-JSON leads from an external producer. "-" reads stdin. Schema: gemmaforge.leads/v1. Tracked: 0#368. |
| `--seed-only` | `false` | Skip static scanner prioritisation and rely solely on --seed-findings. Only meaningful when --seed-findings is set. |
| `--emit <target>` | — | Emit target. Default unset → existing terminal/json/etc. `pr` → emit each reproduced finding as a GitHub PR with repro + suggested patch (0#377). Unverified findings roll up into `hypotheses.md`. |
| `--base <branch>` | — | Base branch for `--emit pr` (default: main) |
| `--dry-run` | `false` | For --emit pr only: print proposed git/gh emission commands. The source review itself still executes. |
| `--emit-out-dir <path>` | — | Directory for `--emit pr` rollup files (default: system temp) |
| `--harness-tier <tier>` | `1` | C/C++ harness tier to construct: 1 (single-function libFuzzer, default), 2 (multi-component linker), 3 (Tier-2 build + QEMU sanitizer validation). |
| `--harness-function <name>` | — | Tier-2 only: name of the suspect function the harness should drive. Defaults to a heuristic placeholder. |
| `--harness-header <path>` | — | Tier-2 only: header to #include in the emitted harness. Defaults to the function name with a .h suffix. |
| `--harness-build-system <system>` | `auto` | Tier-2 only: build system to grep-parse for object subset (autotools, cmake, meson, auto). |
| `--harness-sanitizers <list>` | — | Tier-2 only: comma-separated sanitizers to enable (asan, ubsan, msan). Default: asan,ubsan. |
| `--harness-out <dir>` | — | Tier-2 only: output directory for the emitted harness + linker fragment. Defaults to &lt;repo&gt;/.0-out/tier2. |
| `--harness-qemu-kernel <path>` | — | Tier-3 only: pre-built kernel image. Defaults to ZERO_KERNEL_QEMU_KERNEL. |
| `--harness-qemu-disk <path>` | — | Tier-3 only: pre-built rootfs image. Defaults to ZERO_KERNEL_QEMU_DISK. |
| `--harness-wall-clock-ms <ms>` | — | Tier-3 only: wall-clock budget in milliseconds for the full QEMU validation. Default 300000 (5m). |
| `--subsystem <path>` | — | Restrict the review to a specific subsystem directory (e.g. crypto/, net/tcp/). Only meaningful with --profile linux-kernel. |
| `--hypothesis <text>` | — | Operator hypothesis to seed the agent with a specific research direction. Modeled after Xint Code's operator prompt. |
| `--conversation <text>` | — | PR/MR discussion thread to review against (untrusted). The latest message drives this run. |
| `--prior-findings <path>` | — | JSON array of prior findings. Fresh review treats it as untrusted context and investigates variants without repeating the originals. |
| `--fix-commit <sha>` | — | Analyze a security-fix commit and hunt for structurally similar unpatched code paths (variant hunting). Requires a local git repo. Resolves the commit to its full SHA and first-parent preimage. When used alone, feeds candidates as SeedFindings into the review pipeline. Combine with --variants-only to emit candidates as JSON without model/network calls. |
| `--variants-only` | `false` | Emit full variant-hunt result as JSON (candidates, language coverage, errors) and exit. Requires --fix-commit. No model, cloud, or network calls are made. |
| `--npm-dynamic` | `false` | Also run the npm dynamic-discovery detector sweep (SSPP fuzz / validation read-stability / SSRF parser-diff) over the package in a disposable sandbox. Only effective with --ecosystem npm. Confirmed leads flow into the same verify → disclosure path. |
| `--resume <run-id>` | — | Resume a previous run from its journal on disk (0#374) |
| `--branch-from <entry-index>` | — | Branch the journal at the given entry index before resuming (requires --resume). |
| `--verbose` | `false` | Show detailed output |
| `--timeout <ms>` | `600000` | AI agent timeout in milliseconds |

#### Review profiles

Profiles select review behavior and prerequisites. See [Scan code](/scan-code/) and [Research Workflows](/research-workflows/). Static kernel review leaves VM execution and crash reproduction to a separate step.

### scan repair

Investigate a repository, reproduce findings, generate repair candidates, run regression tests, and independently verify repairs before delivery.

```text
0 scan repair [options] <repo>
```

The repository can be a local Git checkout or an HTTPS Git URL. Execution is **host-local in managed checkouts under the state directory, not in a newly provisioned sandbox**. Repository code, the operator-approved setup command, and the required regression command run with the worker's available permissions. Use an appropriately isolated worker for untrusted repositories; a disposable checkout is not a security boundary.

For example, after reviewing the repository's test command:

```bash
0 scan repair ./my-repo --test-command "npm test" --state-dir "$HOME/.0/secure/my-repo"
```

The regression command must pass before and after a repair. Findings that cannot be reproduced or verified must not be treated as fixed. Inspect `repairs`, `repairedFindingIds`, `blockedFindingIds`, and `errors` as well as `status`: the current implementation can return `completed` while other findings remain blocked or errors are retained. Completion is not proof that every finding was fixed or that the repository contains no vulnerabilities.

Reported `costUsd` is not a reliable whole-workflow total: investigation usage is initially added, but a later repair-ledger update replaces it. The repair ceiling also checks that ledger separately from investigation spend. Use provider-side limits and inspect usage independently; do not treat `--cost-ceiling` as a guaranteed end-to-end cap.

`--resume` requires an explicit `--state-dir`. It checks configuration identity and repository revision, can retry blocked or failed work, and does not resume cancelled runs. It does not blindly replay publication.

Publication is opt-in. `--publish` uses authorized repository credentials and `gh` to open PRs for **verified patches only**; it never merges or deploys them. Review retained evidence and proposed patches before enabling publication.

`--timeout` bounds the whole workflow. The investigation phase currently relies on that deadline rather than immediate operator cancellation; the repair phase supports cancellation. The CLI accepts `api` or `auto` runtime selection and JSON output only.

Exit codes: `0` completed, `2` blocked, `3` failed, `130` cancelled.

Guide: [Scope and authorization](/scope/).

| Argument | Required | Description |
| --- | --- | --- |
| `repo` | Yes | Local Git repository or HTTPS Git URL; execution occurs in the current worker, not a newly provisioned sandbox |

| Option | Registered default | Description |
| --- | --- | --- |
| `--test-command <command>` **required** | — | Operator-approved regression command; must pass before and after repair |
| `--source-path <path>` | — | Repository-relative folder to investigate and repair; setup and tests run at the repository root |
| `--setup-command <command>` | — | Operator-approved setup/build command run in each disposable checkout |
| `--state-dir <path>` | — | Persistent run directory; defaults to a stable per-repository path so learnings accumulate |
| `--runtime <runtime>` | `api` | Native repair runtime: auto or api |
| `-m, --model <model>` | — | Model for investigation and repair; inherits configured provider when omitted |
| `--timeout <ms>` | `3600000` | Whole scan deadline in milliseconds |
| `--cost-ceiling <usd>` | — | Requested model-cost limit. Current accounting checks the repair ledger separately from investigation usage; this is not a guaranteed whole-workflow spend cap. |
| `--max-findings <n>` | `10` | Maximum findings selected for repair. Inspect blockedFindingIds separately from the overall run status. |
| `--max-attempts <n>` | `3` | Maximum repair candidates per finding |
| `--max-turns <n>` | `30` | Maximum model turns per repair phase |
| `--resume` | `false` | Resume the compatible persisted run for this repository; never blindly replays publication |
| `--publish` | `false` | Publish verified patches as PRs using authorized repository credentials; never merge or deploy |
| `--rules <text>` | — | Plain-English team repair standards (e.g. "minimal diffs, no new dependencies") |
| `--format <format>` | `json` | Output format: json |

### scan deep

Run a seedless DEPTH review: enumerate source files, apply profile-specific finder lenses, and check candidates with a multi-lens verification quorum. Results are leads requiring further verification. Exit 0: sweep completed, with or without leads. Exit 2: skipped because no files qualified or the review cap was exceeded. Exit 3: bad flags, unreadable target, or all finders failed.

```text
0 scan deep [options] <target>
```

Guide: [Read the workflow](/research-workflows/).

| Argument | Required | Description |
| --- | --- | --- |
| `target` | Yes | Source tree to review (a local path or a git URL) |

| Option | Registered default | Description |
| --- | --- | --- |
| `--profile <p>` | — | Lens profile: evm-onchain \| solana-onchain \| cardano-onchain \| cairo-onchain \| move-onchain (else a generic default lens set) |
| `--subsystem <path>` | — | Narrow the review scope to a subdirectory (respects the 5000-file review cap) |
| `--evolution-config <path>` | — | Use the active source finder with private local execution receipts |
| `--models <a,b>` | — | Comma-separated finder models for diversity (default: single provider model, or $ZERO_DEEP_REVIEW_MODELS) |
| `--attempts <N>` | — | Finder attempts per candidate×lens×model, best-of-N (default 1, or $ZERO_DEEP_REVIEW_ATTEMPTS) |
| `--concurrency <N>` | — | Max finders in flight (default 8) |
| `--cost-ceiling <usd>` | — | Shared estimated-model-cost ceiling for planner and finder work. Checks can stop further work after recorded usage reaches the threshold; in-flight calls can overshoot. |
| `--max-candidates <N>` | — | Cap candidate files hunted, largest-first (default 8, or $ZERO_DEEP_REVIEW_MAX_CANDIDATES) |
| `--threat-model` | — | Enable pre-selection threat-model planner pass (trust-boundary lanes); default OFF |
| `--quorum <N>` | — | Multi-lens verify quorum (default: majority of the verify-lens count) |
| `--output <path>` | — | Write the result JSON to this path instead of stdout |
| `--runtime <mode>` | — | Engine runtime (default api) |
| `--timeout <ms>` | `600000` | Cloud agent timeout budget in milliseconds |

### scan fix

Generate, source-retest, and optionally apply a scoped fix for one reproduced source finding

```text
0 scan fix [options] <repo>
```

Guide: [Read the workflow](/verify-and-fix/).

| Argument | Required | Description |
| --- | --- | --- |
| `repo` | Yes | Clean local Git worktree containing the affected source file |

| Option | Registered default | Description |
| --- | --- | --- |
| `--finding <path>` | — | Path to an external finding JSON with verificationSpec |
| `--finding-id <id>` | — | Persisted finding ID (full ID or unique prefix) |
| `--db-path <path>` | — | Database containing --finding-id |
| `--verification-result <path>` | — | Optional verification_result JSON from `0 scan verify`; required when the finding does not already carry one |
| `--test-command <command>` **required** | — | Explicit regression command to run in the isolated candidate worktree |
| `--runtime <runtime>` | `auto` | Fix runtime: auto or api |
| `-m, --model <model>` | — | Model identifier for the selected runtime |
| `--api-key <key>` | — | API key for the selected runtime |
| `--timeout <ms>` | `600000` | Per-model-call timeout in milliseconds |
| `--test-timeout <ms>` | `300000` | Regression-command timeout in milliseconds |
| `--max-attempts <n>` | `3` | Maximum candidate patches; capped at 3 |
| `--apply` | `false` | Apply only a patch that passed isolated source recheck and regression command |
| `--output <path>` | — | Write the validated apply_patch DSL to this path |

## Findings & evidence

### findings

Browse and manage persisted findings

```text
0 findings [options]
```

Human triage (`new`, `accepted`, `suppressed`) and verification have independent states. Accepting a finding records the operator's decision; reproduction and fix verification remain separate steps.

Guide: [Read the workflow](/findings/).

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

### findings triage

Triage findings and manage learned FP memories

```text
0 findings triage
```

Guide: [Read the workflow](/triage/).

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
| `--scope <scope>` | — | Filter by scope: global \| target \| package |
| `--category <category>` | — | Filter by vulnerability category |
| `--db-path <path>` | — | Path to SQLite database |

#### findings triage memory remove

Delete a memory by id

```text
0 findings triage memory remove [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes | Memory ID |

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

### scan verify

Deterministically replay a finding's PoC steps and emit a verification_result JSON.

```text
0 scan verify [options] [finding]
```

Fixture, structured-step, kernel, and bundle verification use different status schemas and exit codes. Read the verdict for the chosen path in [Verification Results](/verification-result/) and [Verify and fix](/verify-and-fix/).

Guide: [Read the workflow](/verification-result/).

| Argument | Required | Description |
| --- | --- | --- |
| `finding` | No | Path to a finding.json (0#193 deterministic-replay path). Equivalent to --finding when --runner is supplied. |

| Option | Registered default | Description |
| --- | --- | --- |
| `--runner <kind>` | — | Deterministic replay runner: local\|smolvm\|docker\|qemu (default smolvm in an admitted workbench, local outside). |
| `--docker-network <name>` | — | Docker network for --runner docker. Defaults to none; bridge/custom networks require --scope and only permit HTTP steps. |
| `--scope <path>` | — | Engagement scope JSON required for HTTP replay; SmolVM also refuses private/loopback destinations. |
| `--qemu-binary <path>` | — | QEMU emulator for --runner qemu. |
| `--qemu-kernel <path>` | — | Guest kernel image for --runner qemu. |
| `--qemu-busybox <path>` | — | Static BusyBox binary used to build the offline QEMU guest. |
| `--out <dir>` | — | 0#193 run directory (artifacts go under &lt;out&gt;/artifacts/). Defaults to a fresh tmpdir. |
| `--finding <path>` | — | Path to a finding.json. |
| `--bundle <path>` | — | Path to a reproduction bundle directory; requires --runner local\|smolvm\|docker outside an admitted workbench. Replays the bundle's vulnerable and patched snapshots through the configured runner and emits an aggregate ReproductionBundleResult. |
| `--create-bundle <plan.json>` | — | Path to a BundlePlan JSON. Creates a reproduction bundle without executing any PoC steps. Requires --out &lt;bundle-dir&gt;. |
| `--target <path>` | — | Path to a target.json (PocExecutionTarget: baseUrl, env, cwd, timeoutMs, personas). |
| `--fixture <name>` | — | Run a built-in deterministic replay fixture. Supported: cli-path-traversal. |
| `--fixture-command <json>` | — | JSON argv array for the CLI under test. Supports {{apiUrl}}, {{exportDir}}, and {{fixtureMode}} placeholders. |
| `--fixture-mode <mode>` | — | Fixture behavior for --fixture: vulnerable or patched. |
| `--retain-artifacts` | `false` | Keep the fixture sandbox, harness metadata, and stdout/stderr logs. |
| `--artifact-dir <path>` | — | Use this directory as the fixture sandbox root. |
| `--format <fmt>` | `json` | Output format. Only 'json' is supported. |
| `--output <path>` | — | Write the verification_result JSON to this path instead of stdout. |
| `--kernel-finding <path>` | — | Path to a kernel-review finding.json. Runs the Tier 2 agent loop to produce a reproducer and promote the finding via the kernel oracle. Requires ZERO_KERNEL_VERIFY=1. |
| `--kernel-tree <path>` | — | Linux source tree used by --kernel-finding for Tier 1 kernel build. |
| `--kernel-config <profile>` | `kasan` | Kernel build config profile for --kernel-finding (only 'kasan' supported). |
| `--attempts <N>` | — | Max reproducer attempts for --kernel-finding (default 5). |
| `--wall-clock <duration>` | — | Wall-clock budget for --kernel-finding (e.g. 30m, 90s; default 30m). |

### scan disclose

Assemble GHSA-ready advisory drafts from persisted findings

```text
0 scan disclose [options] [findingId]
```

Guide: [Read the workflow](/reports/).

| Argument | Required | Description |
| --- | --- | --- |
| `findingId` | No | Finding ID (or prefix). Omit to batch every finding at or above --severity-floor. |

Subcommands: [evidence-pack](#scan-disclose-evidence-pack) · [track](#scan-disclose-track) · [review](#scan-disclose-review).

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--scan <scanId>` | — | Restrict to findings from this scan |
| `--output-dir <path>` | — | Directory to write advisories into (default ~/0/disclosures/scan-&lt;id&gt;) |
| `--severity-floor <severity>` | `medium` | In batch mode, only draft findings at or above this severity |
| `--no-screenshots` | — | Skip terminal-screenshot rendering even when freeze is available |
| `--repo <path>` | — | Local git checkout of the target repo to re-verify findings against |
| `--ref <tag>` | — | Git ref (tag/sha/branch) to check out before verifying — defaults to the repo's current HEAD |
| `--drop-fixed` | `false` | Move findings whose status is 'fixed' or 'file-removed' into _dropped/ with a reason file instead of drafting an advisory for them |
| `--reverify` | `false` | Behaviourally re-verify each finding's PoC step graph against a live target. Requires --target-url. |
| `--target-url <url>` | — | Base URL the behavioural re-verify runtime dispatches http actions against (e.g. http://localhost:3108) |
| `--target-env <kv...>` | — | Repeated KEY=VALUE pairs added to the shell-action environment for behavioural re-verify |
| `--target-timeout-ms <ms>` | — | Per-step timeout for behavioural re-verify, in milliseconds (default 30000) |
| `--keep-unrun` | `false` | Route `could_not_run` behavioural verdicts to needs-review instead of dropping them. Default-off because unverified PoCs should never auto-file. |
| `--reverify-rps <n>` | — | Per-host requests-per-second cap for behavioural reverify (default 2). Honours 429 Retry-After. |
| `--scope-allowlist <hosts>` | — | Comma-separated host allowlist for reverify. Supports `*.domain.com` wildcard (matches subdomains, NOT the apex). Out-of-scope http/shell steps fail closed. |
| `--dry-run` | `false` | Show what would be written without writing files |

#### scan disclose evidence-pack

Create a vendor-notification draft from one finding JSON: issue, location, impact, reproduction, and remediation. Includes the mandatory 'DRAFT — NOT SENT' banner and sends nothing. #928

```text
0 scan disclose evidence-pack [options] <finding.json>
```

| Argument | Required | Description |
| --- | --- | --- |
| `finding.json` | Yes | Path to a Finding JSON file |

| Option | Registered default | Description |
| --- | --- | --- |
| `--target <label>` | — | Affected target/package label for the 'where' line, e.g. lodash@4.17.21 |
| `--affected-ref <ref>` | — | Git ref / version range string for the 'where' line |
| `--allow-unreproduced` | `false` | Stage an internal draft even when the finding's PoC did not reproduce (default off — unreproduced findings are a low-signal disclosure trip-wire) |
| `--out <file>` | — | Write the DRAFT markdown to a file instead of stdout |

#### scan disclose track

Create a disclosure record, or apply one legal transition with `--record` and `--to`. Records intent and sends nothing.

```text
0 scan disclose track [options] <findingId>
```

| Argument | Required | Description |
| --- | --- | --- |
| `findingId` | Yes | Finding ID the disclosure record is for |

| Option | Registered default | Description |
| --- | --- | --- |
| `--record <file>` | — | Existing disclosure-record JSON to transition (omit to open a fresh draft) |
| `--to <status>` | — | Target status for the transition (requires --record) |
| `--actor <actor>` | — | Actor recorded on the timeline event (default 'operator') |
| `--message <text>` | — | Free-text note recorded on the timeline event |
| `--disclosed-to <vendor>` | — | Vendor/contact stamped when transitioning into 'sent' |
| `--cve-id <cve>` | — | CVE id stamped when transitioning into 'cve_assigned' |
| `--out <file>` | — | Write the record JSON to a file instead of stdout |

#### scan disclose review

Render a deterministic, redacted local reproducibility manifest for human inspection. Sends and publishes nothing.

```text
0 scan disclose review [options] <finding.json>
```

| Argument | Required | Description |
| --- | --- | --- |
| `finding.json` | Yes | Path to a Finding JSON file |

| Option | Registered default | Description |
| --- | --- | --- |
| `--timestamp <iso>` | — | Override generation timestamp for deterministic output |
| `--tool-version <ver>` | — | Override tool version string |
| `--model-config <str>` | — | Provider/model config, e.g. anthropic/claude-sonnet-4 |
| `--target <id>` | — | Override the finding target identifier |
| `--out <file>` | — | Write manifest to a file instead of stdout |

### lab research ingest

Import kernel crash reports (KASAN, UBSAN, oops, syzkaller) into 0 findings.

```text
0 lab research ingest [options] [path]
```

Guide: [Read the workflow](/kernel-vm/).

| Argument | Required | Description |
| --- | --- | --- |
| `path` | No | Path to a crash report file or directory of reports |

| Option | Registered default | Description |
| --- | --- | --- |
| `--format <format>` | `auto` | Input format: auto \| kasan \| ubsan \| oops \| syzkaller \| generic |
| `-o, --output <format>` | `terminal` | Output format: terminal \| json \| sarif |
| `--verify` | — | Run kernel oracle verification for each report/reproducer |
| `--syz <path>` | — | Run a standalone syzkaller .syz program through the kernel VM oracle |
| `--reproducer <path>` | — | Run a standalone C reproducer through the kernel VM oracle |
| `--kernel-tree <path>` | — | Linux source tree for Tier 1 kernel build/cache resolution |
| `--kernel-config <name>` | — | Kernel build config name for --kernel-tree (e.g. kasan, defconfig+kasan) |
| `--config <profile>` | — | [deprecated] alias for --kernel-config |
| `--kernel-cache-dir <path>` | — | Kernel build cache directory (default: ~/.0/kernel-cache) |
| `--force-kernel-build` | — | Rebuild kernel VM artifacts even when a cache entry exists |
| `--review-subsystem` | — | After ingest, run linux-kernel review against the crash subsystem for sibling bugs |
| `--tree <path>` | — | Linux source tree used by --review-subsystem |
| `--runtime <runtime>` | `auto` | Review runtime for --review-subsystem: auto, claude, codex, api |
| `--api-key <key>` | — | API key for --review-subsystem API runtime |
| `-m, --model <model>` | — | Model for --review-subsystem |
| `--timeout <ms>` | `600000` | AI review timeout for --review-subsystem |
| `--cost-ceiling <usd>` | — | Estimated model-cost ceiling for subsystem review, not a guaranteed whole-job billing cap. |
| `--review-subsystem-fixture <path>` | — |  |
| `-v, --verbose` | — | Verbose output |
| `--persist` | — | Write ingested findings to an isolated 0 run database (default: classify only) |
| `--db-path <path>` | — | Explicit SQLite path for --persist (default: a new ~/.0/runs/&lt;run-id&gt;/state.db) |

#### Real kernel VM verification

Imported crash logs record a prior run. For a new reproduction, follow [Kernel VM Verification](/kernel-vm/) and its execution and evidence requirements.

### config db

Manage the local findings database.

```text
0 config db
```

Guide: [Read the workflow](/troubleshooting/).

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

## Runs

### lab runs

Inspect retained workflow execution history.

```text
0 lab runs
```

Subcommands: [resume](#lab-runs-resume) · [list](#lab-runs-list) · [show](#lab-runs-show) · [cancel](#lab-runs-cancel) · [history](#lab-runs-history) · [replay](#lab-runs-replay) · [relaunch](#lab-runs-relaunch) · [timeline](#lab-runs-timeline) · [orchestrate](#lab-runs-orchestrate).

#### lab runs list

List retained runs in the selected control database.

```text
0 lab runs list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--all` | — | List unified work records with automation, scan and thread references |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

#### lab runs show

Read one run and its retained results.

```text
0 lab runs show [options] <id>
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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

#### lab runs cancel

Request cancellation from the selected or discovered owning engine. This controls
the same run visible in the browser. Ctrl-C also requests cancellation for a
foreground workflow run; disconnecting an attached transport leaves the engine
running. Stored history alone does not restart or stop execution.

```text
0 lab runs cancel [options] <id>
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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

#### lab runs resume

Resume a persisted assessment scan in an existing engine session. The selected engine supplies the stored target, model, and current scope; optional branch and budget limits narrow the request. This resumes scan work rather than restarting a workflow graph.

```text
0 lab runs resume [options] <scan-id>
```

```bash
0 lab runs resume SCAN_ID --chat SESSION_ID --engine production
```

| Argument | Required | Description |
| --- | --- | --- |
| `scan-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--branch-from-entry <index>` | — | Nonnegative retained history entry index |
| `--time-cap <ms>` | — | Resume time ceiling in milliseconds |
| `--cost-cap <usd>` | — | Resume cost ceiling in USD |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--chat <id>` **required** | — | Existing engine thread |
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

### lab runs history

Show past scan history from run-local SQLite databases

```text
0 lab runs history [options]
```

Guide: [Read the workflow](/findings/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to one SQLite database |
| `--limit <n>` | `10` | Number of scans to show |

### lab runs relaunch

Resume a previous scan from persisted state

```text
0 lab runs relaunch [options] <scanId>
```

Resume requires the original persisted state, supported target routing, and valid authorization and credentials. See [Verify and fix](/verify-and-fix/) before resuming a live target.

Guide: [Read the workflow](/verify-and-fix/).

| Argument | Required | Description |
| --- | --- | --- |
| `scanId` | Yes | Scan ID to resume |

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--format <format>` | — | Output format override: terminal, json, md, html, sarif, pdf |
| `--runtime <runtime>` | — | Runtime override: auto, claude, codex, api |
| `--timeout <ms>` | — | AI agent timeout override in milliseconds |
| `--api-key <key>` | — | API key for LLM provider |
| `-m, --model <model>` | — | LLM model to use |
| `--branch-from <entry-index>` | — | Branch the journal at the given entry index before resuming. Copies entries 0..N into a new run and resumes from there. |

### lab runs replay

Replay the last scan's attack chain as an animated terminal sequence

```text
0 lab runs replay [options]
```

Guide: [Read the workflow](/verify-and-fix/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--scan <scanId>` | — | Replay a specific scan by ID (default: last scan) |

### lab runs timeline

Export an immutable scan timeline with UTC ISO-8601 timestamps, action summaries, and MITRE ATT&CK/ATLAS tags for SOC cross-referencing.

```text
0 lab runs timeline [options] <scanId>
```

The scan ID is resolved only in the selected database. For run-local storage, pass `--db-path ~/.0/runs/<scan-id>/state.db`, adjusted for your state directory.

Guide: [Read the workflow](/scope/#authorized-scope).

| Argument | Required | Description |
| --- | --- | --- |
| `scanId` | Yes | Scan id to export (see `0 lab runs history`) |

| Option | Registered default | Description |
| --- | --- | --- |
| `--format <format>` | `markdown` | Output format: json, csv, markdown |
| `--since <iso>` | — | Only include events at or after this timestamp (ISO-8601, e.g. 2026-07-28T09:00:00Z) |
| `--until <iso>` | — | Only include events at or before this timestamp (ISO-8601) |
| `--attack-only` | — | Only include events that map to a MITRE ATT&CK or ATLAS technique, dropping pipeline lifecycle noise |
| `--db-path <path>` | — | Path to SQLite database |

### lab runs orchestrate

Run the autonomous verification worker against persisted queued case work

```text
0 lab runs orchestrate [options]
```

Runs queued cases from the selected database. Review their credentials and side-effect permissions first. For multi-target scans, use the scan workflows.

Guide: [Read the workflow](/automations/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--db-path <path>` | — | Path to SQLite database |
| `--limit <n>` | `1` | Maximum queued cases to claim per pass |
| `--runtime <runtime>` | — | Runtime override: auto, claude, codex, api |
| `--timeout <ms>` | `30000` | Request timeout in milliseconds |
| `--api-key <key>` | — | API key for LLM provider |
| `-m, --model <model>` | — | LLM model to use |
| `--watch` | `false` | Run as a persistent daemon loop |
| `--poll-interval <ms>` | `5000` | Idle poll interval for watch mode |
| `--label <name>` | — | Operator-facing worker label |

## Improve

### lab improve

Benchmark, evolve and qualify 0's own detection and routing. These commands
improve the tool itself; they do not assess a target.

```text
0 lab improve
```

Subcommands: [bench](#lab-improve-bench) · [routing-qualify](#lab-improve-routing-qualify) · [evolve](#lab-improve-evolve) · [learning](#lab-improve-learning).

### lab improve routing-qualify

Run a finite offline panel for discovery, source analysis, verification and
reporting. Fixture mode uses deterministic local responses and makes no provider
calls. A model-api plan additionally requires `--allow-provider-calls`; every
candidate shares the declared call, wall-clock and estimated-spend limits.
Reports retain positive/negative controls, tool roundtrips, scope/evidence state,
usage and inconclusive outcomes. Catalog estimates are not actual invoices.
A `local-model` plan uses only an already-installed pinned loopback Ollama model
and reserves context/output tokens before dispatch. It downloads nothing; zero
external API fee does not imply free compute or a passing task-quality result.

```text
0 lab improve routing-qualify [options]
```

A synthetic panel does not establish broad model superiority. Review provider
workload authorization, floating model identity and report limitations before
opting into `scan --routing-report`. Fixture reports cannot enable recommendations;
manual task pins and `--single-model` remain available.

| Option | Registered default | Description |
| --- | --- | --- |
| `--plan <file>` **required** | — | Reviewed qualification plan JSON with models and shared limits |
| `--out <file>` **required** | — | Report JSON destination |
| `--allow-provider-calls` | `false` | Authorize API calls only for a model-api plan and its declared limits |
| `--regress-model <model>` | — | Fixture-only negative control: corrupt this model's validation state |

### lab improve bench

Run A/B variant tournaments and a CI regression gate over the labeled corpus (#656).

```text
0 lab improve bench
```

Guide: [Read the workflow](/research-workflows/).

Subcommands: [improvement-project](#lab-improve-bench-improvement-project) · [improvement-assess](#lab-improve-bench-improvement-assess) · [calibrate](#lab-improve-bench-calibrate) · [run](#lab-improve-bench-run) · [diff](#lab-improve-bench-diff) · [scoreboard](#lab-improve-bench-scoreboard).

#### lab improve bench improvement-project

Offline projection of sealed tournaments into the v1 result + v3 execution contract

```text
0 lab improve bench improvement-project [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--candidate <path>` **required** | — | schema-v1 ImprovementCandidate JSON |
| `--champion-variant <id>` **required** | — | champion variant id present in every tournament |
| `--challenger-variant <id>` **required** | — | challenger variant id present in every tournament |
| `--development <path>` **required** | — | JSON pair: {manifest, tournament} |
| `--development-ref <ref>` **required** | — | immutable development tournament artifact ref |
| `--held-out <path>` **required** | — | JSON pair: {manifest, tournament} |
| `--held-out-ref <ref>` **required** | — | immutable held-out tournament artifact ref |
| `--negative-controls <path>` **required** | — | JSON pair: {manifest, tournament} |
| `--negative-controls-ref <ref>` **required** | — | immutable negative-control artifact ref |
| `--evaluation-manifest <path>` **required** | — | precommitted evaluation manifest JSON |
| `--manifest-ref <ref>` **required** | — | immutable evaluation manifest artifact ref |
| `--evaluator-bundle <path>` **required** | — | evaluator bundle JSON |
| `--evaluator-bundle-ref <ref>` **required** | — | immutable evaluator bundle artifact ref |
| `--evaluator-code <path>` **required** | — | exact evaluator implementation artifact |
| `--evaluator-code-ref <ref>` **required** | — | immutable evaluator code artifact ref |
| `--evaluator-config <path>` **required** | — | exact evaluator configuration artifact |
| `--evaluator-config-ref <ref>` **required** | — | immutable evaluator config artifact ref |
| `--ci-evidence <path>` **required** | — | retained GitHub Actions receipt with identity, required checks, pass result, and evidenceRefs |
| `--output-dir <path>` **required** | — | create-once result + execution-evidence directory |
| `--calibration` | `false` | rejection-only projection of three trusted calibration lanes |
| `--evidence-ref <ref>` | `[]` | additional immutable evidence reference (repeatable) |

#### lab improve bench improvement-assess

Evaluate a sealed improvement result and publish an immutable promotion-decision ledger snapshot; generic artifacts always require human approval

```text
0 lab improve bench improvement-assess [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--result <path>` **required** | — | sealed result.json from bench improvement-project |
| `--base-artifact <path>` **required** | — | immutable champion artifact to bind into the decision |
| `--candidate-artifact <path>` **required** | — | immutable challenger artifact to bind into the decision |
| `--output-dir <path>` **required** | — | create-once promotion decision + ledger snapshot directory |
| `--ledger <path>` | — | prior immutable ledger.json snapshot to extend |

#### lab improve bench calibrate

Emit a sealed, provider-free no-uplift tournament for 0research calibration

```text
0 lab improve bench calibrate [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--manifest <path>` **required** | — | corpus manifest path |
| `--case-id <id>` | `[]` | exact pre-registered case id (repeatable) |
| `--manifest-id <id>` **required** | — | sealed calibration slice id |
| `--tournament-output <path>` **required** | — | create-once sealed calibration evidence |
| `--evaluator-output-dir <path>` | — | create-once exact evaluator code/config/bundle |

#### lab improve bench run

Run a variant tournament over the corpus and update the benchmark ledger

```text
0 lab improve bench run [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--integration <id>` | `core` | Target-suite integration: core, xbow, cybergym |
| `--manifest <path>` | — | Corpus manifest path; optional for xbow/cybergym integration defaults |
| `--xbow-path <dir>` | — | XBOW checkout used by the xbow integration |
| `--white-box` | `false` | Expose XBOW source paths to the selected agent |
| `--cybergym-harness <dir>` | — | CyberGym checkout used by the cybergym integration |
| `--cybergym-subset <path>` | — | Pre-registered CyberGym task-id file |
| `--cybergym-difficulty <level>` | `level1` | CyberGym task difficulty |
| `--cybergym-best-of-n <n>` | `1` | CyberGym trajectory count; default strict pass@1 |
| `--cybergym-max-submits <n>` | `1` | Official CyberGym submits per task; default strict pass@1 |
| `--case-id <id>` | `[]` | exact case id in a pre-registered manifest slice (repeatable) |
| `--manifest-id <id>` | — | sealed slice id (required with --case-id) |
| `--variants <json\|path>` | — | JSON array of variant descriptors, or a path to one |
| `--variant-id <id>` | `champion` | Id for the implicit single variant |
| `--harness <id>` | — | Harness identity for the implicit single variant |
| `-m, --model <model>` | — | Model override for the implicit single variant |
| `--runtime <runtime>` | — | Runtime override (api/claude/codex/…) |
| `--depth <depth>` | — | Scan/audit depth override (quick/deep/…) |
| `--pass-at-k <n>` | `1` | Attempts per case (pass@k or independent repeats) |
| `--attempt-policy <policy>` | `pass-at-k` | pass-at-k or independent-repeat |
| `--schedule <schedule>` | `variant-major` | variant-major or case-major |
| `--max-turns <n>` | `40` | Hard attack-turn budget per attempt |
| `--cost-ceiling <usd>` | — | Per-attempt cost ceiling (USD) |
| `--ci-subset` | `false` | Run only the fast CI subset (cases flagged ci:true) |
| `--ledger <path>` | `benchmark-ledger.json` | Benchmark ledger path |
| `--tournament-output <path>` | — | create-once canonical {manifest,tournament} evidence |
| `--run-id <id>` | — | Run id recorded in the ledger (default: ISO timestamp) |
| `--gate` | `false` | Evaluate the regression gate and exit non-zero on a regression |
| `--max-success-drop <f>` | `0.05` | Max success-rate drop vs last green |
| `--max-fp-rise <f>` | `0.05` | Max FP-rate rise vs last green |
| `--format <format>` | `terminal` | Output format: terminal, json |

#### lab improve bench diff

Compare two recorded runs in a benchmark ledger

```text
0 lab improve bench diff [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--a <runId>` **required** | — | Baseline run id |
| `--b <runId>` **required** | — | Comparison run id |
| `--ledger <path>` | `benchmark-ledger.json` | Benchmark ledger path |
| `--format <format>` | `terminal` | Output format: terminal, json |

#### lab improve bench scoreboard

Render an existing benchmark ledger as Markdown and dashboard JSON. This command
does not run a benchmark or invoke a model. It creates the output directory and
overwrites `scoreboard.md` and `scoreboard.json` there. Review the reports before
publishing them.

```text
0 lab improve bench scoreboard [options]
```

```sh
0 lab improve bench scoreboard --ledger ./benchmark-ledger.json --out ./reports --title "Local benchmark"
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--ledger <path>` | `benchmark-ledger.json` | Benchmark ledger path |
| `--out <dir>` | `.` | Directory to write scoreboard.md + scoreboard.json |
| `--title <title>` | — | Report title/header |
| `--keep-runs <n>` | `10` | Trailing ledger entries shown in the trend table |

### lab improve evolve

Autonomous self-improvement: source-candidate proposal, lens evaluation, and automatic promotion

```text
0 lab improve evolve
```

Guide: [Read the workflow](/self-improvement/).

Subcommands: [run](#lab-improve-evolve-run) · [status](#lab-improve-evolve-status) · [reconcile](#lab-improve-evolve-reconcile) · [promote](#lab-improve-evolve-promote) · [rollback](#lab-improve-evolve-rollback) · [exec](#lab-improve-evolve-exec) · [feedback](#lab-improve-evolve-feedback).

#### lab improve evolve run

Propose, independently evaluate, and optionally promote future workers

```text
0 lab improve evolve run [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--config <path>` **required** | — | Path to evolution config JSON file |
| `--watch` | — | Repeat until stable, budget exhausted, a failure, or interruption |
| `--json` | — | Output JSON (one result per line in watch mode) |
| `--auto-promote` | — | Enable automatic promotion |
| `--no-auto-promote` | — | Disable automatic promotion |
| `--allow-source-access` | — | Allow sending selected source to the model |
| `--no-allow-source-access` | — | Deny model source access |
| `--max-passes <number>` | — | Maximum watch passes (default: budget-limited) |

#### lab improve evolve status

Show active and canary versions, snapshot identities, and registry events

```text
0 lab improve evolve status [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--store <path>` | — | Required path to evolution store directory |
| `--json` | — | Output structured JSON |

#### lab improve evolve reconcile

Record an observed charge for an interrupted durable dispatch. Supply the
reservation ID and immutable cost-receipt digest shown by the campaign status.
This resolves cost uncertainty once; it does not bypass provenance or promotion.
See [durable campaign accounting](/self-improvement/#evolve-a-detection-worker).

```text
0 lab improve evolve reconcile [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--store <path>` **required** | — | Path to evolution store directory |
| `--dispatch <id>` **required** | — | Unresolved dispatch reservation ID |
| `--cost-usd <amount>` **required** | — | Actual provider/execution charge |
| `--receipt-digest <sha256>` **required** | — | Immutable observed cost receipt digest |
| `--json` | — | Output structured campaign ledger |

#### lab improve evolve promote

Approve an exact staged candidate after independent canary evaluation

```text
0 lab improve evolve promote [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--store <path>` **required** | — | Path to evolution store directory |
| `--version <id>` **required** | — | Evaluated candidate ID to approve |
| `--json` | — | Output structured JSON |

#### lab improve evolve rollback

Retire an active or canary evolution version and restore its parent

```text
0 lab improve evolve rollback [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--store <path>` **required** | — | Path to evolution store directory |
| `--version <id>` **required** | — | Active or canary version ID to retire |
| `--reason <text>` | `operator rollback` | Reason for rollback |

#### lab improve evolve exec

Execute a pinned evolution version snapshot against an input

```text
0 lab improve evolve exec [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--config <path>` **required** | — | Path to evolution config JSON file (to determine store) |
| `--run-id <id>` **required** | — | Evolution run ID to pin and execute the active snapshot from |
| `--input <json>` **required** | — | JSON input to pass to the snapshot execution |
| `--json` | — | Output structured JSON instead of human-readable text |

#### lab improve evolve feedback

Capture, approve, and inspect evolution feedback candidates

```text
0 lab improve evolve feedback
```

Subcommands: [capture](#lab-improve-evolve-feedback-capture) · [approve](#lab-improve-evolve-feedback-approve) · [release](#lab-improve-evolve-feedback-release) · [status](#lab-improve-evolve-feedback-status).

#### lab improve evolve feedback capture

Capture an evidence-backed observation from JSON. Finding verification remains unchanged.

```text
0 lab improve evolve feedback capture [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--input <path>` **required** | — | Observation JSON file with source revision and evidence references |
| `--store <path>` | — | Feedback queue JSON file |
| `--allow-source-access` | — | Explicitly consent to source use for this observation |

#### lab improve evolve feedback approve

Approve independent positive, held-out, and negative fixtures for an observation

```text
0 lab improve evolve feedback approve [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--id <feedback-id>` **required** | — | Full observation ID |
| `--fixtures <path>` **required** | — | Curation JSON containing positives, heldOut, and negativeControls |
| `--store <path>` | — | Feedback queue JSON file |
| `--allow-source-access` | — | Explicitly consent to source use for synthesis |

#### lab improve evolve feedback release

Release a stale processing claim after its worker has stopped

```text
0 lab improve evolve feedback release [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--id <feedback-id>` **required** | — | Full observation ID |
| `--claim-token <token>` **required** | — | Exact claim token shown by feedback status --json |
| `--store <path>` | — | Feedback queue JSON file |

#### lab improve evolve feedback status

Show retained observations and their approval/processing status

```text
0 lab improve evolve feedback status [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--store <path>` | — | Feedback queue JSON file |
| `--json` | — | Output structured JSON |

### lab improve learning

```text
0 lab improve learning
```

Inspect tenant-local learning activity and evaluation provenance. See [Learning](/self-improvement/#memory) for trust boundaries and workflow version restoration.

Subcommands: [status](#lab-improve-learning-status) · [process](#lab-improve-learning-process) · [evolve](#lab-improve-learning-evolve).

#### lab improve learning status

```text
0 lab improve learning status [options]
```

Read recorded activity, retained knowledge, improvement states and queue status. Project filters accept a local source path or project identity. This command makes no model calls.

| Option | Registered default | Description |
| --- | --- | --- |
| `--project <id>` | — | Filter by project |
| `--json` | — | Output structured JSON |

#### lab improve learning process

```text
0 lab improve learning process [options]
```

Process bounded queued observations. For an explicitly selected local source project, import existing current opted-in source notes. The default worker does not invent lessons from completion metadata or call a model.

| Option | Registered default | Description |
| --- | --- | --- |
| `--project <id>` | — | Filter by project |
| `--limit <number>` | — | Maximum observations to process |
| `--json` | — | Output structured JSON |

#### lab improve learning evolve

```text
0 lab improve learning evolve [options]
```

Run the existing evolution controller with an explicit configuration and retain integrity-checked registry receipts. This can invoke configured models and incur their costs. Its output-fixture evaluation is not proof of improved security discovery. Promotion authority remains with the evolution registry and its configured gates.

| Option | Registered default | Description |
| --- | --- | --- |
| `--config <path>` **required** | — | Evolution config JSON file |
| `--project <id>` **required** | — | Project associated with the evolution artifacts |
| `--json` | — | Output structured JSON |

## Research & verification

### lab research

Run target-specific engines through the shared evidence research plane

```text
0 lab research
```

Guide: [Read the workflow](/research-workflows/).

Subcommands: [pipeline](#lab-research-pipeline) · [counterexample](#lab-research-counterexample) · [mobile](#lab-research-mobile) · [linux-matrix](#lab-research-linux-matrix) · [linux](#lab-research-linux) · [hunt](#lab-research-hunt) · [recency-hunt](#lab-research-recency-hunt) · [assumption-hunt](#lab-research-assumption-hunt) · [memsafety](#lab-research-memsafety) · [lens-synth](#lab-research-lens-synth) · [specdrift](#lab-research-specdrift) · [protocol-check](#lab-research-protocol-check) · [npm-discovery](#lab-research-npm-discovery) · [js-recon](#lab-research-js-recon) · [xnu-fuzz](#lab-research-xnu-fuzz) · [kernel](#lab-research-kernel) · [cve](#lab-research-cve) · [intel](#lab-research-intel) · [recon](#lab-research-recon) · [binary](#lab-research-binary) · [ingest](#lab-research-ingest) · [exploit](#lab-research-exploit) · [identity](#lab-research-identity) · [adgraph](#lab-research-adgraph) · [entragraph](#lab-research-entragraph) · [cloud](#lab-research-cloud) · [h1](#lab-research-h1).

#### lab research pipeline

Run the existing web/AI/source/package pipeline through the shared evidence plane

```text
0 lab research pipeline [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--target <target>` **required** | — | URL, local path, repository, package, or image |
| `--target-type <type>` | — | url, web-app, source-code, npm-package, pypi-package, cargo-package, or oci-image |
| `--profile <profile>` | — | Source review profile |
| `--depth <depth>` | `default` | quick, default, or deep |
| `--runtime <runtime>` | `auto` | auto, api, claude, or codex |
| `--artifact-root <path>` | `.0-research` | Research artifact root |

#### lab research mobile

Run passive mobile intake; indicators remain hypotheses and only scoped adapters may hand off targets

```text
0 lab research mobile [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--target <path>` **required** | — | Extracted APK/IPA directory or metadata file |
| `--artifact-root <path>` | `.0-research` | Research artifact root |

#### lab research linux-matrix

Validate and hash vulnerable-vs-patched boot logs from externally executed runs. This command performs no boots.

```text
0 lab research linux-matrix [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--matrix <path>` **required** | — | Versioned external boot-matrix manifest JSON |
| `--finding <path>` **required** | — | Existing Finding JSON to bind the proof to |
| `--artifact-root <path>` | `.0-research` | Research artifact root |

#### lab research linux

Run a supplied Linux kernel reproducer through the shared N-boot evidence gate

```text
0 lab research linux [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--kernel-tree <path>` **required** | — | Linux source tree |
| `--reproducer <path>` **required** | — | C reproducer or syzkaller .syz program |
| `--finding <path>` **required** | — | Existing Finding JSON to bind the proof to |
| `--expected-signature <literal>` **required** | — | Literal crash signature that every counted boot must contain |
| `--boots <n>` | `3` | Fresh boots |
| `--min-hits <n>` | `2` | Required reproducing boots |
| `--artifact-root <path>` | `.0-research` | Research artifact root |

#### lab research counterexample

Build a sanitizer-backed harness for a suspect C/C++ function, search for failing
inputs, and retain evidence under the artifact root. Supply the source tree,
header, function name and C declaration. Optional witness inputs replay proposed
failures; mitigation sources let the same inputs be replayed against a reference
fix. Review the recorded build, replay and sanitizer results before treating a
candidate as a confirmed finding.

```text
0 lab research counterexample [options]
```

Guide: [Read the workflow](/research-workflows/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--source <dir>` **required** | — | C/C++ source tree root |
| `--fn <name>` **required** | — | Suspect function name |
| `--header <path>` **required** | — | Header declaring the suspect function |
| `--declaration <decl>` **required** | — | C declaration of the suspect function |
| `--input-shape <shape>` | `bytesAndLen` | bytesAndLen, bytesPtr, or bytesAndLenOut |
| `--build-system <system>` | `auto` | auto, autotools, cmake, or meson |
| `--timeout <sec>` | — | Fuzz wall-clock budget in seconds |
| `--mitigation-source <files...>` | — | Reference-mitigation source file(s) for replay |
| `--mitigation-include <dirs...>` | — | Extra include directories for the mitigation build |
| `--witness <files...>` | — | Finding-proposed witness input file(s) to replay through the sanitizer build |
| `--artifact-root <path>` | `.0-research` | Research artifact root |

### lab research hunt

Hunt variants of a bug class using a proven fix. Generate candidate sites, run finders, and check their leads with an adversarial skeptic. Leads require verification before a 0-day claim. Exit 0: leads found; 1: none found; 2: no candidates; 3: error.

```text
0 lab research hunt [options]
```

Guide: [Read the workflow](/research-workflows/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--source <path>` **required** | — | Source tree to hunt in (e.g. a linux checkout) |
| `--seed <path>` **required** | — | Fix diff / .patch whose bug class to hunt variants of |
| `--ref <name>` | — | Provenance label for the seed (e.g. the CVE / commit) |
| `--concurrency <N>` | — | Max finders in flight (default 4) |
| `--max-candidates <N>` | — | Cap candidate sites hunted (default 40) |
| `--skip-candidates <N>` | — | Skip the first N ranked candidate sites before hunting (default 0) |
| `--models <a,b>` | — | Comma-separated finder models for diversity (default: provider default) |
| `--reachable-only` | — | Restrict candidates to paths built + zero-cap reachable on the kernelCTF COS target (default: HUNT_REACHABLE_ONLY env) |
| `--reachable-prefer` | — | Sort kernelCTF-reachable candidates first, without dropping any (default: HUNT_REACHABLE_PREFER env) |
| `--no-verify` | — | Skip the skeptic gate (emit all raw findings — triage only, never disclosure) |
| `--novelty` | — | Require lore.kernel.org duplicate suppression; abort before discovery when evidence is unavailable |
| `--novelty-root <path>` | — | Lore mirror root (default: ZERO_LORE_MIRROR_ROOT or /root/lore-mirror) |
| `--novelty-lists <a,b>` | — | Comma-separated lore lists to search (default: ZERO_LORE_LISTS or linux-media) |
| `--novelty-recent-epochs <N>` | — | Newest public-inbox epochs to sync per list when --novelty-sync is set (default 1) |
| `--novelty-sync` | — | Clone/fetch lore mirrors before running the novelty gate |
| `--novelty-model <model>` | — | Optional model override for the lore duplicate judge |
| `--novelty-required` | — | Legacy alias; --novelty already aborts when evidence is unavailable |
| `--methodology` | — | Use the kernel-LPE methodology preset: lifecycle/provenance lenses, best-of-4, top-2 skeptic gate, reachable-first |
| `--invariant` | — | Engine A: build (or load) the seed-touched subsystem's stored invariant model and inject its rules + deterministic violation hypotheses into every finder prompt |
| `--graph-slice` | — | Load the seed-touched subsystem's pre-exported Joern CPG and inject a compact interprocedural reachability slice around the fix site into every finder prompt (needs scripts/provision-cpg.sh; fail-open to flat-text) |
| `--cpg <path>` | — | Explicit CPG graphson JSON path for --graph-slice (default: &lt;source&gt;/.0/cpg/&lt;subsystem&gt;.json) |
| `--ops-harvest <paths>` | — | [--graph-slice] Comma-separated repo-relative C files to harvest static ops-struct initializers from; overrides a precomputed .ops.json |
| `--graph-slice-hops <N>` | — | [--graph-slice] Call-graph radius around the seed functions (default 3; use 8 for the exp527 known answer) |
| `--exploitability` | — | PROVE stage: after the skeptic+prover gate, run the execution-verified exploitability oracle on each confirmed finding (GREBE diversify + SCAVY differential). BOOTS REAL QEMU VMs — requires staged kernel-VM artifacts and is ignored under --no-verify. Never rejects a finding; it stamps a proven verdict and gates the weaponize budget. |
| `--prove-min-ceiling <ceiling>` | — | [--exploitability] Minimum assessed impact ceiling worth a VM slot: dos-only\|info-leak\|oob-write\|uaf-control (default info-leak — filters out dos-only before QEMU is touched) |
| `--output <path>` | — | Write the hunt result JSON to this path instead of stdout |
| `--runtime <mode>` | — | Engine runtime (default api) |
| `--timeout <ms>` | `600000` | Accepted cloud agent timeout budget in milliseconds |

### lab research recency-hunt

Hunt the kernelCTF freshness window in a linux-next diff. Exclude files unreachable by unprivileged users, classify changes as semantic (lifetime, refcount, locking) or cosmetic, then run the invariant engine and adversarial verification on semantic changes. The ranked leads require novelty and reachability checks before disclosure. Exit 0: survivors; 1: none; 2: empty window; 3: error.

```text
0 lab research recency-hunt [options]
```

Guide: [Read the workflow](/research-workflows/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--tree <path>` **required** | — | Kernel source tree to hunt (e.g. /root/linux-next) |
| `--since <gitrange>` | — | Explicit git range (e.g. HEAD~20..HEAD or &lt;sha&gt;..HEAD); overrides --hours |
| `--hours <N>` | — | Hunt commits from the last N hours (default 24) |
| `-m, --model <model>` | — | Model-build / finder model override |
| `--classifier-model <model>` | — | Semantic-vs-cosmetic classifier model (default gpt-5.5) |
| `--runtime <mode>` | — | Engine runtime (default api) |
| `--model-dir <path>` | — | Where per-file invariant models are stored (default &lt;tree&gt;/.recency-models) |
| `--max-hunt-files <N>` | — | Cap files run through the engine (default 25) |
| `--max-classify-files <N>` | — | Cap in-scope files sent to the LLM classifier (default 80; snapshot merge-window cost control) |
| `--detectors <list>` | — | Comma-separated detectors per semantic file: dataflow,refcount,race,dual-view (default the three static; dual-view is opt-in) |
| `--dynamic-witness` | — | Run the full machine: assumption-mining dual-view enumerator → KASAN synthesize→boot→witness oracle. Implies dual-view. VM boots are expensive — bounded by the budget below. |
| `--witness-candidates <N>` | — | Dynamic-witness RUN budget: total dual-view candidates booted through the KASAN oracle per run (default 10) |
| `--witness-candidates-per-file <N>` | — | Per-file cap on witnessed candidates, clamped to the run budget (default 6) |
| `--witness-rounds <N>` | — | Bounded PoC-repair rounds per candidate — each is one VM boot (default 2) |
| `--witness-mode <mode>` | — | PoC shape for the oracle: single (sequential), race (concurrent multi-thread), auto (race for race-shaped seams; default) |
| `--witness-race-threads <N>` | — | Race-mode worker threads driving entryA vs entryB (default 4) |
| `--witness-race-iters <N>` | — | Race-mode per-thread hammer iterations to widen the race window (default 200000) |
| `--remine-assumptions` | — | Force a fresh assumption mine for dual-view each run (default: reuse a stored per-file model if present) |
| `--output <path>` | — | Write the report JSON here instead of stdout |
| `--md <path>` | — | Also write the markdown report here |
| `--report-dir <dir>` | — | Scheduler mode: write &lt;dir&gt;/YYYY-MM-DD.{json,md} + log a one-line summary |

### lab research assumption-hunt

Mine implicit function preconditions without a seed. Compare relied-on and enforced conditions without an LLM, then find reachable callers that omit a required precondition. Output contains candidates to disprove. Exit 0: completed, with or without candidates; 3: error.

```text
0 lab research assumption-hunt [options] <source-root>
```

Guide: [Read the workflow](/research-workflows/).

| Argument | Required | Description |
| --- | --- | --- |
| `source-root` | Yes | Local source tree the subsystem files live under (e.g. a kernel checkout) |

| Option | Registered default | Description |
| --- | --- | --- |
| `--files <a.c,b.c>` **required** | — | Comma-separated subsystem source files, repo-relative to &lt;source-root&gt; |
| `--subsystem <label>` | — | Subsystem label for the stored model (e.g. net/unix) |
| `--model-path <path>` | — | Where the durable assumption model JSON lives (default under &lt;source-root&gt;/.0) |
| `--remine` | — | Force a fresh LLM mine even if the stored model exists |
| `--skip-hunt` | — | Stop after the deterministic caller-scan (no LLM finder/skeptic gate) |
| `--no-verify` | — | Run the finder fan-out but skip the skeptic gate |
| `--models <a,b>` | — | Comma-separated finder/mine models for diversity |
| `--max-contexts <N>` | — | Cap the violating contexts fed to the hunt |
| `--no-wrapper-resolution` | — | Disable v1 establisher-wrapper resolution (reproduces the v0 direct-token scan — FP ablation) |
| `--no-finder-targeting` | — | Feed the finder the whole subsystem file instead of focused per-function excerpts |
| `--no-dual-view` | — | Disable the v2 dual-api/cross-phase enumerator (caller-scan only — the v1 behavior) |
| `--dynamic-witness` | — | v3: route dual-view candidates to the KASAN synthesize→boot→witness oracle (bypasses the static skeptic). Needs a KASAN VM env (ZERO_KERNEL_QEMU_*). |
| `--witness-rounds <N>` | — | Bounded PoC-repair rounds per dual-view candidate (default 3) |
| `--witness-candidates <N>` | — | Cap dual-view candidates run through the dynamic oracle (default 10) |
| `--witness-model <name>` | — | Model for PoC synthesis (default: runtime default) |
| `--witness-mode <mode>` | — | PoC shape: single (sequential), race (concurrent multi-thread), auto (race for race-shaped seams; default) |
| `--witness-race-threads <N>` | — | Race-mode worker threads driving entryA vs entryB (default 4) |
| `--witness-race-iters <N>` | — | Race-mode per-thread hammer iterations to widen the race window (default 200000) |
| `--excerpt-dir <path>` | — | Where finder-targeting excerpts are written (default: os tmpdir) |
| `--runtime <mode>` | — | Engine runtime (default api) |
| `--output <path>` | — | Write the result JSON to this path instead of stdout |

### lab research memsafety

Scan userspace or Rust code for memory-safety faults in Monty mode. Clone the source, build a fuzz/sanitizer harness, run the fuzz loop, and report reproduced memory corruption. Exit 0: loop completed, with or without crashes; 2: skipped because the build system or execution prerequisite is unavailable; 3: bad flags or unreadable target.

```text
0 lab research memsafety [options] <source>
```

Guide: [Read the workflow](/research-workflows/).

| Argument | Required | Description |
| --- | --- | --- |
| `source` | Yes | Source tree to fuzz (a local path or a git URL) |

| Option | Registered default | Description |
| --- | --- | --- |
| `--subsystem <path>` | — | Narrow the scanned root to a subdirectory |
| `--language <lang>` | — | Force the language: c \| cpp \| rust (else auto-detected) |
| `--build-system <sys>` | — | Force the build system: cargo \| cmake \| autotools \| meson \| make (else auto-detected) |
| `--artifact-dir <path>` | — | Persist bounded crash evidence outside the source tree |
| `--artifact-max-bytes <bytes>` | — | Aggregate byte ceiling for retained crash evidence (default 4194304) |
| `--harness <name>` | — | libFuzzer / cargo-fuzz harness target name |
| `--fuzz-dir <path>` | — | Non-standard cargo-fuzz directory (relative to source root) |
| `--miri` | `false` | Additionally run `cargo +nightly miri` for UB detection (Rust) |
| `--fuzz-timeout <sec>` | — | Fuzz wall-clock budget in seconds (default 60) |
| `--output <path>` | — | Write the result JSON to this path instead of stdout |
| `--runtime <mode>` | — | Engine runtime (default api) |
| `--timeout <ms>` | `600000` | Clone/prepare timeout budget in milliseconds |

### lab research kernel

Kernel security workflows

```text
0 lab research kernel
```

Guide: [Read the workflow](/research-workflows/).

Subcommands: [syzbot-mine](#lab-research-kernel-syzbot-mine) · [weights](#lab-research-kernel-weights) · [variant-hunt](#lab-research-kernel-variant-hunt).

#### lab research kernel syzbot-mine

Mine and LPE-rank syzbot's invalid/auto-closed queue

```text
0 lab research kernel syzbot-mine [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--subsystems <csv>` | `net,net/sched,net/tls,xfrm,crypto,vsock,nfc` | Subsystem labels to keep |
| `--limit <n>` | `30` | Maximum ranked candidates |
| `--details <n>` | `15` | Top candidate detail pages to enrich |
| `--detail-delay <ms>` | `750` | Delay between syzbot detail/repro requests |

#### lab research kernel weights

Generate an LLM-derived syzkaller choice_weights.json for a kernelCTF target

```text
0 lab research kernel weights [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--target <version>` **required** | — | Target kernel version, e.g. 6.12.101 |
| `--crash-summary <path>` | — | File with recent crash descriptions to inform weighting |
| `--enabled-syscalls <path>` | — | JSON array file of manager-enabled syscall names to constrain the plan |
| `--from-file <path>` | — | Validate/normalize a raw model JSON plan instead of calling the API |
| `-m, --model <model>` | — | Override model (default: env/auto-detected) |
| `--max-entries <n>` | `48` | Maximum weighted syscalls |
| `--dry-run` | — | Print the weights file instead of writing |
| `-o, --out <path>` | — | Output path for choice_weights.json |

#### lab research kernel variant-hunt

Run foxguard-backed kernel advisory variant hunting

```text
0 lab research kernel variant-hunt [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--tree <path>` **required** | — | Path to a Linux source tree |
| `--advisory <url-or-file>` | — | Advisory URL or local advisory path for provenance |
| `--rules <path>` | — | Foxguard rule directory, e.g. rules/kernel/dirty-frag-class |
| `--foxguard <path>` | — | Foxguard binary path |
| `--sarif-input <path>` | — | Use an existing foxguard SARIF file instead of invoking foxguard |
| `--timeout <ms>` | `120000` | Foxguard timeout in milliseconds |
| `-o, --output <format>` | `terminal` | Output format: terminal \| json \| sarif |
| `-v, --verbose` | — | Verbose terminal output |

### lab research exploit

Run the kernel-VM escalation ladder for a confirmed memory-safety finding (ADR-055 Phase 1). Missing VM artifacts produce exit 2 with no execution. With `--climb`, run the verification and weaponization chain through repeated boots until the deterministic oracle observes root.

```text
0 lab research exploit [options]
```

Guide: [Read the workflow](/research-workflows/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--finding <path>` | — | Path to a confirmed kernel finding.json (required except with --autoclimb/--agent) |
| `--reproducer <path>` | — | Path to the proven memory-safety reproducer (C source), embedded for provenance. |
| `--max-strategies <N>` | — | Cap the number of applicable strategies attempted (bounds VM boots). |
| `--output <path>` | — | Write the weaponization result JSON to this path instead of stdout. |
| `--climb` | — | Engine-driven root-climb mode: drive the REAL verify→weaponization chain runner (real QEMU runner + real oracle, no overrides), looping boots until the oracle credits root. Requires staged kernel-VM artifacts. |
| `--loop-boots <N>` | — | [--climb] Max genuine QEMU boots to loop (root race is ~1/6-8). Default 8. |
| `--vmlinux <path>` | — | [--climb] Resolved vmlinux for the root-tail planner's symbol resolution. |
| `--kernel-config <path>` | — | [--climb] Kernel .config text for exploit-config introspection. |
| `--freed-struct <name>` | — | [--climb] Freed object's C struct name (e.g. snd_rawmidi_runtime). |
| `--proof-out <path>` | — | [--climb] Where to write the read-only root proof (default: temp dir). |
| `--autoclimb` | — | Autonomous LLM-composed weaponization climb: the engine's OWN codegen loop composes each C body from the technique library + bug trigger + last verdict. |
| `--bug-spec <path>` | — | [--autoclimb] JSON AutonomousClimbBug (trigger C, config-off, slab, ceiling). |
| `--boot-script <path>` | — | [--autoclimb] Generic boot script ($1=composed .c, stdout=guest stdout, &lt;c&gt;.serial=dmesg). Or set ZERO_AUTOCLIMB_BOOT_SCRIPT. |
| `--model <id>` | — | [--autoclimb] Engine model id for the composer (default: engine runtime default). |
| `--agent` | — | Agentic weaponization loop: the model gets a shell in an already-provisioned target and iterates recon → weaponize → build → run against real crash output, gated by the mechanical trigger→reclaim→leak→write→root stage gate. |
| `--task <path>` | — | [--agent] Task/vuln description file (vuln doc + PoV + build). |
| `--container <id>` | — | [--agent] Run exploit commands in this container via `docker exec` (cwd /workspace). |
| `--exec-script <path>` | — | [--agent] Run exploit commands through this script ($1=command) — the E2B/SSH/console seam. Mutually exclusive with --container; one of the two is REQUIRED (no local execution). |
| `--flag-path <path>` | — | [--agent] Where the captured flag must land in the target (default /tmp/flag). |
| `--flag-pattern <ere>` | — | [--agent] ERE the flag content must match. Without it a capture rests on a non-empty flag file only, which a status line the agent echoes there will FALSE-PASS. |
| `--max-steps <N>` | — | [--agent] Agent step budget (default 90). |
| `--runtime <mode>` | — | [--agent] Engine runtime (default api). |

### lab research xnu-fuzz

Model each IOKit user client's `IOExternalMethodDispatch2022` gate, generate gate-passing structured inputs, and plan a disposable macOS-VM fuzzing run. Complements the `xnu-re` review profile.

```text
0 lab research xnu-fuzz
```

Guide: [Read the workflow](/research-workflows/).

Subcommands: [enumerate](#lab-research-xnu-fuzz-enumerate) · [gen](#lab-research-xnu-fuzz-gen) · [harness-plan](#lab-research-xnu-fuzz-harness-plan).

#### lab research xnu-fuzz enumerate

§1: kext → target-model.json (dispatch-table → valid-input model)

```text
0 lab research xnu-fuzz enumerate [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--kext <path>` **required** | — | Path to the extracted kext Mach-O (from xnu-re-extract.sh). |
| `--bundle <id>` | — | Kext bundle id recorded in the model (e.g. com.apple.iokit.IOSurface). |
| `--out <file>` | — | Write the full target-model.json to this path. |
| `--json` | — | Emit the model as JSON on stdout instead of a summary. |

#### lab research xnu-fuzz gen

§2: target-model.json → gate-passing + structure-aware inputs

```text
0 lab research xnu-fuzz gen [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--model <file>` **required** | — | Path to a target-model.json from `enumerate`. |
| `--class <name>` | — | User-client class to generate for (default: largest). |
| `--selector <N>` | — | Only generate for this selector index. |
| `--seed <N>` | — | PRNG seed for reproducible generation (default 1). |
| `--json` | — | Emit the generation summary as JSON. |

#### lab research xnu-fuzz harness-plan

Print the execution requirements for one macOS-VM shard.

```text
0 lab research xnu-fuzz harness-plan [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--golden <image>` | — | Golden tart VM image name. |
| `--build <build>` | — | macOS build the golden image + kernelcache match. |
| `--shared <dir>` | — | Host-shared folder for the program/result/panic channel. |
| `--oracle <kind>` | — | Crash oracle: release \| kasan \| kfence (default release). |

### lab research binary

Analyze a compiled binary by delegating to the in-repo 0verse engine (uv run --frozen 0verse)

```text
0 lab research binary [options] <target> [passthrough...]
```

Guide: [Read the workflow](/research-workflows/).

| Argument | Required | Description |
| --- | --- | --- |
| `target` | Yes | Path to the target artifact (e.g. an ELF) to analyze |
| `passthrough` | No | Extra positional args forwarded verbatim to 0verse |

| Option | Registered default | Description |
| --- | --- | --- |
| `--mode <mode>` | `triage` | 0verse subcommand: triage\|run\|scan |
| `--format <format>` | — | Forward --format to 0verse (e.g. ndjson) |
| `--backend <backend>` | — | Forward --backend to 0verse (e.g. rizin, ghidra, angr) |
| `--llm <llm>` | — | Forward --llm to 0verse (e.g. codex, claude) |

### lab research protocol-check

Check Tier-1 HTTP conformance against a spec excerpt (issue #972). The LLM proposes mismatches, exercises run against the real target, and a deterministic oracle confirms MUST-level violations.

```text
0 lab research protocol-check [options]
```

Guide: [Read the workflow](/research-workflows/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--spec <file>` **required** | — | Path to the authoritative specification excerpt (RFC/ABNF prose, text). |
| `--impl <file>` **required** | — | Path to the implementation source excerpt the divergence is hypothesized in. |
| `--target <url>` **required** | — | Base URL of the live target to exercise (e.g. http://127.0.0.1:8080). |
| `--json` | — | Emit the full result (findings + attempts) as JSON on stdout. |
| `--max-exercises <N>` | — | Cap how many ranked hypotheses to exercise against the target (default 8). |
| `--runtime <runtime>` | `auto` | LLM runtime: auto/api (codex login or API key), claude, codex. |
| `--protocol <name>` | — | Protocol name for the report/finding (default HTTP/1.1). |
| `--spec-version <version>` | — | Spec edition for the report (default RFC 9110). |
| `--spec-ref <ref>` | — | Auditable spec citation (e.g. 'RFC 9110 §9.3.6'). |

### lab research specdrift

Protocol/spec differential-hunting research commands.

```text
0 lab research specdrift
```

See [Research Workflows](/research-workflows/) for prerequisites and evidence limits.

Guide: [Read the workflow](/research-workflows/).

Subcommands: [extract](#lab-research-specdrift-extract) · [scan](#lab-research-specdrift-scan) · [plan](#lab-research-specdrift-plan).

#### lab research specdrift extract

Extract cited protocol invariants from an arbitrary spec text file

```text
0 lab research specdrift extract [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--spec <path>` **required** | — | Spec/RFC/protocol text file to analyze |
| `--spec-name <name>` | — | Display name stored in citations |
| `--max-invariants <N>` | `40` | Maximum invariant candidates to emit |
| `--output <path>` | — | Write JSON result to a file instead of stdout |

#### lab research specdrift scan

Extract spec invariants and map them to candidate implementation code

```text
0 lab research specdrift scan [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--spec <path>` **required** | — | Spec/RFC/protocol text file to analyze |
| `--source <path-or-git-url>` **required** | — | Implementation source tree to map against |
| `--spec-name <name>` | — | Display name stored in citations |
| `--max-invariants <N>` | `40` | Maximum invariant candidates to extract |
| `--max-files <N>` | `400` | Maximum source files to inspect |
| `--max-candidates-per-invariant <N>` | `5` | Maximum implementation candidates per invariant |
| `--timeout <ms>` | `600000` | Source preparation timeout |
| `--output <path>` | — | Write JSON result to a file instead of stdout |

#### lab research specdrift plan

Extract invariants, map implementation candidates, and emit drift hypotheses to verify

```text
0 lab research specdrift plan [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--spec <path>` **required** | — | Spec/RFC/protocol text file to analyze |
| `--source <path-or-git-url>` **required** | — | Implementation source tree to map against |
| `--spec-name <name>` | — | Display name stored in citations |
| `--max-invariants <N>` | `40` | Maximum invariant candidates to extract |
| `--max-files <N>` | `400` | Maximum source files to inspect |
| `--max-candidates-per-invariant <N>` | `5` | Maximum implementation candidates per invariant |
| `--max-hypotheses <N>` | `20` | Maximum drift hypotheses to emit |
| `--timeout <ms>` | `600000` | Source preparation timeout |
| `--output <path>` | — | Write JSON result to a file instead of stdout |

### scan agent-assure

Test whether untrusted MCP content causes a prohibited action in an authorized agent environment

```text
0 scan agent-assure [options]
```

Guide: [Read the workflow](/research-workflows/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--agent-endpoint <url>` **required** | — | Customer-owned agent test adapter endpoint (HTTP JSON contract) |
| `--mcp-endpoint <url>` **required** | — | Authorized MCP tools/list endpoint |
| `--oracle-endpoint <url>` **required** | — | Customer-owned state-observer endpoint |
| `--scenario <path>` **required** | — | Scenario JSON: id, title, injection_vector, benign_task, payload, prohibited_action |
| `--scope <path>` | — | Engagement scope JSON; required only while the scope plugin is enabled |
| `--target-version <version>` **required** | — | Version or build digest of the tested agent deployment |
| `--policy-version <version>` **required** | — | Version or digest of the agent prompt and authorization policy |
| `--model-version <version>` **required** | — | Model deployment/version identifier |
| `--tool-version <name=version>` | `[]` | Version of an MCP tool; repeatable |
| `--environment <name>` | `staging` | local, test, or staging |
| `-m, --model <name>` | — | Optional model identifier passed to the customer agent adapter |
| `--agent-headers <path>` | — | JSON file of headers for the agent adapter; never written to evidence |
| `--mcp-headers <path>` | — | JSON file of headers for the MCP endpoint; never written to evidence |
| `--oracle-headers <path>` | — | JSON file of headers for the state observer; never written to evidence |
| `--timeout <ms>` | `30000` | Per-request timeout in milliseconds |
| `--oracle-timeout <ms>` | `10000` | Maximum state-observer wait in milliseconds |
| `--baseline <manifest>` | — | Prior manifest to bind as a retest parent |
| `--output <directory>` | — | Evidence bundle directory; defaults to agent-assurance-&lt;run-id&gt; |

### scan eval

Run adversarial safety eval against an AI/LLM endpoint and produce a scorecard

```text
0 scan eval [options]
```

Guide: [Read the workflow](/research-workflows/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--target <url>` **required** | — | Target AI/LLM endpoint URL |
| `--format <format>` | `terminal` | Output format: terminal, json |
| `--timeout <ms>` | `30000` | Request timeout in milliseconds |
| `--api-key <key>` | — | API key for LLM provider |
| `-m, --model <model>` | — | LLM model to use for evaluation |
| `--auth <json>` | — | Auth credentials for the target (JSON string or path) |
| `--categories <list>` | — | Comma-separated category IDs to run (default: all). Use --list-categories to see available. |
| `--list-categories` | `false` | List available eval categories and exit |
| `--verbose` | `false` | Show detailed output |

### lab research lens-synth

Evolve appsec finder coverage from curated misses; promotion is corpus-gated and active reviews stay pinned

```text
0 lab research lens-synth [options]
```

Guide: [Read the workflow](/self-improvement/#finder-lenses).

| Option | Registered default | Description |
| --- | --- | --- |
| `--miss-input <path>` | — | curated miss-input JSON ({ misses, corpus }) |
| `--registry <path>` | — | durable overlay path (default: ~/.0/lenses/appsec-archetypes.json) |
| `--max-register <n>` | — | cap promoted champions per input revision |
| `-m, --model <id>` | — | synthesis model override |
| `--promote` | `false` | persist a validated champion to the durable overlay |
| `--trials <n>` | — | repeated validation trials (2–10; default 2) |
| `--from-bench <ledger>` | — | harvest the champion's false-negatives from a benchmark ledger into the curated misses (requires --manifest) |
| `--manifest <path>` | — | bench manifest path (ground-truth vuln class + sink); required with --from-bench |
| `--watch` | `false` | poll the miss-input and process each new content revision |
| `--poll-interval <ms>` | `2000` | watch polling interval (minimum 100ms) |
| `--status` | `false` | show the active durable overlay and promotion ledger |
| `--rollback <lens-id>` | — | retire one previously promoted overlay lens |
| `--json` | `false` | print machine-readable output |

## Discovery & identity

### lab research recon

Enumerate subdomains through passive CT/DNS, endpoints, OpenAPI/Swagger docs, and MCP servers. `--active` adds DNS brute force. Emit a deduplicated inventory for `discovered_assets`. Partial #769.

```text
0 lab research recon [options] <domain>
```

Guide: [Read the workflow](/research-workflows/).

| Argument | Required | Description |
| --- | --- | --- |
| `domain` | Yes | Target domain or origin, e.g. example.com or https://api.example.com |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Emit the asset inventory as machine-readable JSON |
| `--timeout <ms>` | `10000` | Per-request probe timeout in milliseconds |
| `--active` | — | Enable active DNS subdomain brute-force; the optional scope plugin enforces candidate authorization. |
| `--scope <file>` | — | JSON engagement policy; required for --active only while the scope plugin is enabled. |

### lab research js-recon

Fetch a site's JavaScript bundles and extract endpoints, API base URLs, and redacted embedded secrets. Requires scope; access is denied by default. #927

```text
0 lab research js-recon [options] <url>
```

Guide: [Read the workflow](/research-workflows/).

| Argument | Required | Description |
| --- | --- | --- |
| `url` | Yes | Target page URL whose &lt;script&gt; bundles are mined, e.g. https://app.example.com |

| Option | Registered default | Description |
| --- | --- | --- |
| `--scope <file>` | — | JSON engagement policy; required only while the scope plugin is enabled. |
| `--timeout <ms>` | `10000` | Per-request fetch timeout in milliseconds |
| `--max-files <n>` | — | Maximum JS files to fetch (clamped to [0,100]) |
| `--json` | — | Emit the result as machine-readable JSON |

### lab research npm-discovery

Run registered npm-package detectors for SSPP fuzzing, validation read-stability TOCTOU, and SSRF parser differences. Confirmation requires an observed runtime consequence.

```text
0 lab research npm-discovery
```

Guide: [Read the workflow](/research-workflows/).

Subcommands: [list](#lab-research-npm-discovery-list) · [run](#lab-research-npm-discovery-run).

#### lab research npm-discovery list

List the registered detectors and their classes.

```text
0 lab research npm-discovery list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Emit as JSON |

#### lab research npm-discovery run

Sweep a package worklist with the detectors and print confirmed findings.

```text
0 lab research npm-discovery run [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--install-dir <dir>` **required** | — | Base dir the packages are installed under (prepare with `npm install --ignore-scripts`). |
| `--packages <list>` | — | Comma-separated package names to sweep, e.g. es-toolkit,radash |
| `--detectors <ids>` | — | Restrict to these detector ids (comma-separated). Default: all. |
| `--downloads-floor <n>` | — | Skip packages below this weekly-download floor (needs registry metadata). |
| `--max-age-days <n>` | — | Skip packages whose last publish is older than this (needs registry metadata). |
| `--i-understand-untrusted-exec` | — | Acknowledge that `run` executes untrusted package code in-process on this host. |
| `--offline-dedup` | — | Skip the live OSV advisory lookup (air-gapped/hermetic runs). Confirmed findings then dedup only against fork-twin/prior-report hints; live-unknown ones are marked source=unknown, not novel. |
| `--json` | — | Emit the result as machine-readable JSON |

### lab research identity

Assess an Entra ID (Azure AD) tenant's privileged roles, conditional-access coverage, app registrations, service principals, and federated-domain trust. Read-only. Supply the Graph token through `ZERO_GRAPH_ACCESS_TOKEN`; command-line tokens are refused.

```text
0 lab research identity [options]
```

Guide: [Read the workflow](/scope/#authorized-scope).

| Option | Registered default | Description |
| --- | --- | --- |
| `--tenant <tenantId>` **required** | — | Entra tenant id (GUID) the supplied token is expected to belong to |
| `--json` | — | Emit the assessment result as machine-readable JSON |
| `--timeout <ms>` | `300000` | Wall-clock bound on the whole assessment in milliseconds |
| `--scope <file>` | — | Path to a JSON scope file ({in_scope, out_of_scope}). When supplied, graph.microsoft.com must be explicitly in scope or no request goes out. |

### lab research adgraph

Analyze existing BloodHound CE / SharpHound JSON for paths to Domain Admin, kerberoastable principals, unconstrained delegation, DCSync rights, ACL abuse chains, and ADCS escalation. Reads local files only, with no collection, authentication, or network access.

```text
0 lab research adgraph [options]
```

Guide: [Read the workflow](/scope/#authorized-scope).

| Option | Registered default | Description |
| --- | --- | --- |
| `--input <path>` **required** | — | A single BloodHound CE JSON file, or a directory of collector JSON files (non-recursive, *.json) |
| `--json` | — | Emit the analysis as machine-readable JSON |
| `--timeout <ms>` | `120000` | Wall-clock bound on ingest + analysis in milliseconds |
| `--domain <fqdn>` | — | Restrict the analysis to objects belonging to this AD domain, e.g. corp.example.com |

### lab research entragraph

Analyze an existing AzureHound export for paths to Global Administrator, service-principal escalation, consent-grant abuse, owner chains, and guest escalation. Reads local files only, with no collection, authentication, or network access.

```text
0 lab research entragraph [options]
```

Guide: [Read the workflow](/scope/#authorized-scope).

| Option | Registered default | Description |
| --- | --- | --- |
| `--input <path>` **required** | — | A single AzureHound JSON file, or a directory of AzureHound JSON files (non-recursive, *.json) |
| `--json` | — | Emit the analysis as machine-readable JSON |
| `--timeout <ms>` | `120000` | Wall-clock bound on ingest + analysis in milliseconds |
| `--max-depth <n>` | — | Hop ceiling for path traversal |
| `--owned <ids>` | — | Comma-separated object ids already under operator control. These become the path sources; omit to treat every enabled non-privileged principal as a candidate. |

### lab research cloud

Probe S3 public access and takeover risks, or validate AWS credentials. Read-only; requires `ZERO_FEATURE_CLOUD_SURFACE` and an engagement scope. Access is denied by default. #925

```text
0 lab research cloud
```

These commands inspect authorized cloud infrastructure. For managed testing,
contact the service operator; `0 lab research cloud` is local AWS/S3 reconnaissance, not
managed-service account setup.

Guide: [Read the workflow](/research-workflows/).

Subcommands: [s3-probe](#lab-research-cloud-s3-probe) · [validate-creds](#lab-research-cloud-validate-creds).

#### lab research cloud s3-probe

Probe S3 buckets anonymously for public listing and orphaned-bucket takeover. Read-only; sends no credentials.

```text
0 lab research cloud s3-probe [options] <bucket...>
```

| Argument | Required | Description |
| --- | --- | --- |
| `bucket` | Yes | Bucket name(s) to probe, e.g. acme-assets |

| Option | Registered default | Description |
| --- | --- | --- |
| `--scope <file>` | — | JSON engagement policy; required only while the scope plugin is enabled. |
| `--region <region>` | — | Bucket home region (default us-east-1 / global endpoint) |
| `--max-keys <n>` | — | Max object keys to sample from a public listing (1-100, default 10) |
| `--json` | — | Emit results as machine-readable JSON |

#### lab research cloud validate-creds

Validate an AWS credential with `sts:GetCallerIdentity` and read-only over-privilege probes. Makes no changes.

```text
0 lab research cloud validate-creds [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--scope <file>` | — | JSON engagement policy; required only while the scope plugin is enabled. |
| `--access-key-id <id>` | — | AWS access key id (defaults to $AWS_ACCESS_KEY_ID) |
| `--secret-access-key <key>` | — | AWS secret access key (defaults to $AWS_SECRET_ACCESS_KEY) |
| `--session-token <token>` | — | AWS session token (defaults to $AWS_SESSION_TOKEN) |
| `--region <region>` | — | AWS region for the STS call (default us-east-1) |
| `--json` | — | Emit the result as machine-readable JSON |

### lab research intel

Live vulnerability intelligence lookup helpers

```text
0 lab research intel
```

Guide: [Read the workflow](/research-workflows/).

Subcommands: [dossier](#lab-research-intel-dossier) · [target-history](#lab-research-intel-target-history) · [search](#lab-research-intel-search) · [cve](#lab-research-intel-cve) · [similar](#lab-research-intel-similar).

#### lab research intel dossier

Build a package-level intel dossier with risk summary, prior-vuln playbooks, and variant leads

```text
0 lab research intel dossier [options] <package>
```

| Argument | Required | Description |
| --- | --- | --- |
| `package` | Yes | Package name |

| Option | Registered default | Description |
| --- | --- | --- |
| `--ecosystem <ecosystem>` | `npm` | Package ecosystem: npm, pypi, cargo, Go, Maven |
| `--package-version <version>` | — | Resolved package version |
| `--ver <version>` | — | Alias for --package-version |
| `--keywords <list>` | — | Comma-separated variant-hunt keywords |
| `--similar-limit <n>` | `10` | Maximum similar advisory leads |
| `--no-similar` | — | Skip similar-advisory search |
| `--offline` | — | Use cache only |
| `--cache-dir <path>` | — | Override intel cache directory |
| `--json` | — | Emit machine-readable JSON |

#### lab research intel target-history

Search prior CVEs/GHSAs already reported against this target, repo, package, or product

```text
0 lab research intel target-history [options] [target]
```

| Argument | Required | Description |
| --- | --- | --- |
| `target` | No | Target URL/name or GitHub repository |

| Option | Registered default | Description |
| --- | --- | --- |
| `--repo-path <path>` | — | Infer target hints from a local repository/package path |
| `--repository <owner/repo-or-url>` | — | GitHub repository hint, e.g. expressjs/express |
| `--ecosystem <ecosystem>` | — | Optional package ecosystem: npm, pypi, cargo, Go, Maven |
| `--package <package>` | — | Optional package name |
| `--product <product>` | — | Optional product/project name |
| `--vendor <vendor>` | — | Optional vendor/organization name |
| `--keywords <list>` | — | Comma-separated target aliases or extra search terms |
| `--limit <n>` | `20` | Maximum results per live source query |
| `--offline` | — | Use cache only |
| `--cache-dir <path>` | — | Override intel cache directory |
| `--json` | — | Emit machine-readable JSON |

#### lab research intel search

Search advisories for a package/version

```text
0 lab research intel search [options] <package>
```

| Argument | Required | Description |
| --- | --- | --- |
| `package` | Yes | Package name |

| Option | Registered default | Description |
| --- | --- | --- |
| `--ecosystem <ecosystem>` | `npm` | Package ecosystem: npm, pypi, cargo, Go, Maven |
| `--package-version <version>` | — | Resolved package version |
| `--ver <version>` | — | Alias for --package-version |
| `--no-enrich` | — | Skip CVE enrichment via NVD/CISA KEV |
| `--offline` | — | Use cache only |
| `--cache-dir <path>` | — | Override intel cache directory |
| `--json` | — | Emit machine-readable JSON |

#### lab research intel cve

Look up a CVE from NVD and CISA KEV

```text
0 lab research intel cve [options] <cve-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `cve-id` | Yes | CVE identifier, e.g. CVE-2024-1086 |

| Option | Registered default | Description |
| --- | --- | --- |
| `--offline` | — | Use cache only |
| `--cache-dir <path>` | — | Override intel cache directory |
| `--json` | — | Emit machine-readable JSON |
| `--allow-missing` | — | Exit 0 when no intel is found (default: exit 1) |

When no intel is found the command exits 1, in text mode (message on stderr) and with `--json` (stdout still prints `null`). Pass `--allow-missing` to exit 0 instead (text mode then prints the yellow "No CVE intel found" line to stdout). Lookup errors such as network failures or a malformed ID exit 1 either way. A newly published CVE that NVD does not list yet, or an `--offline` cache miss, therefore fails CI unless `--allow-missing` is set.

#### lab research intel similar

Search related CVEs/advisories by CWE and keywords

```text
0 lab research intel similar [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--cwe <cwe>` | — | CWE id, e.g. CWE-22 |
| `--ecosystem <ecosystem>` | — | Optional ecosystem hint |
| `--keywords <list>` | — | Comma-separated keywords |
| `--limit <n>` | `10` | Maximum results |
| `--offline` | — | Use cache only |
| `--cache-dir <path>` | — | Override intel cache directory |
| `--json` | — | Emit machine-readable JSON |

### lab research cve

CVE workflows: artifact lookup (`find`) and autonomous PoC adaptation (`adapt`).

```text
0 lab research cve
```

Guide: [Read the workflow](/research-workflows/).

Subcommands: [find](#lab-research-cve-find) · [adapt](#lab-research-cve-adapt).

#### lab research cve find

Find public PoC + write-up artifacts for a CVE id

```text
0 lab research cve find [options] <cve-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `cve-id` | Yes | CVE identifier, e.g. CVE-2024-1086 |

| Option | Registered default | Description |
| --- | --- | --- |
| `--format <fmt>` | `json` | Output format: json \| table |
| `--cache-dir <path>` | — | Override cache directory (default ~/.0/cve-cache) |
| `--no-cache` | — | Bypass on-disk cache and re-fetch every source |
| `--timeout <ms>` | `10000` | Per-source timeout in milliseconds |
| `--retries <n>` | `2` | Retry count per source on 5xx |
| `--skip-github-poc-search` | — | Skip the GitHub repository / code search step |

#### lab research cve adapt

Adapt a public PoC for <cve-id> until it reproduces on the target kernel.

```text
0 lab research cve adapt [options] <cve-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `cve-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--kernel-tree <path>` **required** | — | Linux source tree to build against |
| `--kernel-config <profile>` | — | Kernel build profile (default: kasan) |
| `--attempts <n>` | `5` | Max verify-run attempts across all candidates |
| `--wall-clock <duration>` | `30m` | Total wall-clock budget (e.g. 30m, 90s, 500ms) |
| `--artifacts <path>` | — | Path to a CveArtifacts JSON file (temporary; replaced by the scraper once it merges). |
| `--format <fmt>` | `json` | Output format: json \| table |

## Automation & integration

### computers

Add and manage remote computers. A computer is a remote 0 engine that runs
threads and automations on its host; select it in the browser's computer menu
to work there. `worker` still works as an older name.

```text
0 computers
```

Subcommands: [list](#computers-list) · [add](#computers-add) · [stop](#computers-stop) · [repair](#computers-repair) · [hosts](#computers-hosts).

Aliases: `worker`.

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
| `--target-git <url>` | — | Repository the remote server clones into the engine workspace instead of the bundled demo target |
| `--ssh-config <path>` | — | OpenSSH config file for the SSH target (e.g. a Lima instance's ssh.config) |
| `--engine-port <port>` | — | Engine port on the remote server (default: stable port derived from host) |
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
0 computers repair <backend-id>
```

The result is JSON with the backend ID, reconnection status, and whether the
engine was started.

| Argument | Required | Description |
| --- | --- | --- |
| `backend-id` | Yes |  |

Aliases: `reconnect`.

#### computers stop

Stop a worker engine that Zero deployed and disconnect its owned local tunnel.
The command verifies the saved deployment metadata, remote working directory,
PID and process command before sending a termination signal. It retains the
remote workspace and the saved backend registration so the worker can be
redeployed later.

```text
0 computers stop <backend-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `backend-id` | Yes |  |

#### computers hosts

List SSH host aliases discovered from `~/.ssh/config`, with their resolved host
and user when present. This lists configuration entries rather than checking
connectivity or whether each host supports a Linux engine.

```text
0 computers hosts
```

### lab mcp-server

Expose selected target tools or managed workflows over MCP stdio.

```text
0 lab mcp-server [options]
```

Use `--automations --workspace /absolute/path/to/repo` for template discovery and source workflow execution. Live workflow targets require `--scope` and the enabled scope plugin. Workflow assessments use 0's configured provider; individual target tools use the external agent's reasoning model. Disconnect cancels this host's active runs.

Local-target MCP stdio requires operator-selected host-local execution. The SmolVM batch CLI bridge cannot forward this transport and refuses startup without changing the configured sandbox profile. Use `0 automation` commands for isolated execution. Explicit `--automations --engine <id>` runs a network client for a registered remote engine; the engine owns execution and remote runs survive client disconnect.

Guide: [Read the workflow](/mcp/).

| Option | Registered default | Description |
| --- | --- | --- |
| `--target <target>` | — | Target URL for this MCP chat |
| `--scan-id <scanId>` | — | Scan ID to associate persisted findings and target updates with |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--allow-apply` | `false` | Permit explicit automation apply requests inside the authorized workspace |
| `--workspace <path>` | — | Absolute authorized local root for automation source scans |
| `--db-path <path>` | — | Path to SQLite database |
| `--timeout <ms>` | `30000` | Default tool timeout in milliseconds |
| `--scope <path>` | — | Path to a 0 scope JSON file. Out-of-scope URLs are refused by every target tool. |
| `--tools <names>` | — | Comma-separated 0 MCP tools to expose (default: live tools, or automation tools with --automations). |
| `--rate-limit <spec>` | — | Per-host request rate-limit spec. Defaults to 5 rps when unset. An active --engagement-profile caps this: the effective rate is the minimum of the two, so the profile can only lower it. |
| `--allow-scanners` | `false` | Disable generic-scanner suppression for scoped engagements. |
| `--engagement-profile <name>` | — | Engagement hardening posture for authorized enterprise work. 'standard' (default) is the existing behaviour. 'conservative' applies the quiet posture to this MCP chat: no adaptive WAF-evasion ladder, full jitter on the per-host token bucket, and a 1 rps/host ceiling. The profile can only ever make the session quieter — the effective rate is the minimum of the profile and --rate-limit. The applied posture is recorded as an `engagement_posture_applied` event on the scan so it can be handed to the client as evidence. Lower precedence than the scope file's `engagement` block and ZERO_ENGAGEMENT_PROFILE. |
| `--no-waf-evasion` | — | Disable the adaptive WAF-evasion ladder (default: on). When a response classifies as blocked, the engine normally retries with encoding/casing/whitespace-mutated payload variants, which escalates a routine WAF block into a SOC incident. Detection and reporting of the block are unaffected. Independent of --engagement-profile; env form: ZERO_WAF_EVASION=0. |
| `--engine <id>` | — | Use a registered remote engine; no local execution fallback |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--chat <id>` | — | Attach automation runs to an existing chat on the selected engine |
| `--automations` | `false` | Expose automation discovery and run lifecycle tools instead of live tools |

### plugin

Find, install, enable, inspect, run, and author plugins from the plugin registry. A plugin is the only installable unit in 0; `init`, `validate`, and `submit` are for plugin authors, who publish by opening a pull request against the registry at [github.com/0sec-labs/hackstore](https://github.com/0sec-labs/hackstore). See [Build a plugin](/plugins/) and, for the model-authored origin, [Integrations](/plugins/).

```text
0 plugin
```

Installation, project enablement, and invocation are separate steps. Treat plugin code as untrusted and provide OS isolation separately from capability declarations.

Guide: [Read the workflow](/plugins/).

Subcommands: [list](#plugin-list) · [search](#plugin-search) · [browse](#plugin-browse) · [install](#plugin-install) · [enable](#plugin-enable) · [disable](#plugin-disable) · [info](#plugin-info) · [run](#plugin-run) · [init](#plugin-init) · [validate](#plugin-validate) · [submit](#plugin-submit) · [connectors](#plugin-connectors) · [connect](#plugin-connect) · [disconnect](#plugin-disconnect) · [mcp](#plugin-mcp).

#### plugin list

List installed plugins and their per-project enabled/stale state

```text
0 plugin list
```

#### plugin search

Search the configured registry for plugins

```text
0 plugin search [options] <query>
```

| Argument | Required | Description |
| --- | --- | --- |
| `query` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--registry <url>` | — | plugin registry index URL (https) |

#### plugin browse

List everything in the configured registry

```text
0 plugin browse [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--registry <url>` | — | plugin registry index URL (https) |

#### plugin install

Download, validate, and write plugin files. Installation leaves the plugin disabled and executes no code.

```text
0 plugin install [options] <id-or-path>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id-or-path` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--registry <url>` | — | plugin registry index URL (https) |
| `--local` | — | Install a local directory containing manifest.json and plugin.js (no network) |
| `--ref <ref>` | — | Branch, tag or commit for github:owner/repo |
| `--replace` | — | Replace an installed plugin when installing from GitHub |
| `--yes` | — | Install the reviewed GitHub commit |
| `--json` | — | Print machine-readable JSON for github:owner/repo |
| `--db-path <path>` | — | Engine database for github:owner/repo |

#### plugin enable

Enable an installed plugin for this project and grant its capabilities.

```text
0 plugin enable <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

#### plugin disable

Disable a plugin for this project (files stay installed)

```text
0 plugin disable <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

#### plugin info

Show an installed plugin's manifest, capabilities, and enablement state

```text
0 plugin info <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

#### plugin run

Spawn an enabled plugin and invoke its tool. Effectful tools require `--yes`. Pass arguments as `key=value` pairs, `--json '<obj>'`, or both.

```text
0 plugin run [options] <id> [tool] [pairs...]
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `tool` | No |  |
| `pairs` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json <json>` | — | JSON object of tool arguments |
| `--yes` | — | Authorize an effectful (non read-only) tool to run |
| `--timeout <ms>` | — | Per-call timeout in milliseconds |

#### plugin init

Scaffold a new plugin directory ready to edit, validate, and submit

```text
0 plugin init [options] <name>
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--dir <path>` | — | Parent directory to create the plugin in (default: cwd) |
| `--force` | — | Write into a non-empty target directory |

#### plugin validate

Validate a manifest.json (or a directory containing one) against the plugin manifest contract

```text
0 plugin validate [options] <path>
```

| Argument | Required | Description |
| --- | --- | --- |
| `path` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Emit machine-readable JSON |

#### plugin submit

Prepare the files to submit a plugin to the plugin registry; does not publish (you open the pull request yourself)

```text
0 plugin submit [options] <path>
```

| Argument | Required | Description |
| --- | --- | --- |
| `path` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--out <directory>` | — | New output directory (default: &lt;id&gt;-submission) |

#### plugin connectors

List service connectors (Linear, Slack and others) and whether they are connected

```text
0 plugin connectors [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

#### plugin connect

Connect a service connector; secrets come from environment variables, never argv

```text
0 plugin connect [options] <service>
```

```bash
0 plugin connect linear --secret-env token=LINEAR_API_KEY --yes
```

| Argument | Required | Description |
| --- | --- | --- |
| `service` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--set <key=value>` | — | A non-secret field (repeatable) |
| `--secret-env <key=ENVVAR>` | — | Read a secret field from this environment variable (repeatable) |
| `--yes` | — | Approve connecting this service |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

#### plugin disconnect

Forget a connector's credentials

```text
0 plugin disconnect [options] <service>
```

| Argument | Required | Description |
| --- | --- | --- |
| `service` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

#### plugin mcp

Manage custom MCP servers that threads can use

```text
0 plugin mcp
```

```bash
0 plugin mcp add docs -- npx some-mcp-server
0 plugin mcp add docs --yes -- npx some-mcp-server
```

Guide: [Read the workflow](/mcp/).

Subcommands: [list](#plugin-mcp-list) · [add](#plugin-mcp-add) · [test](#plugin-mcp-test) · [remove](#plugin-mcp-remove).

#### plugin mcp list

List custom MCP servers

```text
0 plugin mcp list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

#### plugin mcp add

Add an MCP server: `add <name> -- <cmd> [args...]` for a local one or --url for a remote one; shows a review first

```text
0 plugin mcp add [options] <name> [command...]
```

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes |  |
| `command` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--url <url>` | — | Remote server URL (https) instead of a local command |
| `--transport <kind>` | — | stdio, http or sse (default: stdio, or http with --url) |
| `--cwd <path>` | — | Relative directory inside the workspace to run in |
| `--env <KEY=VALUE>` | — | Environment variable for a local server (repeatable) |
| `--env-from <KEY=ENVVAR>` | — | Take an environment value from this variable (repeatable) |
| `--header <NAME=VALUE>` | — | Header for a remote server (repeatable) |
| `--header-from <NAME=ENVVAR>` | — | Take a header value from this variable (repeatable) |
| `--enable` | — | Enable it for threads once added |
| `--allow-dangerous-env` | — | Also approve environment variables that change which code loads |
| `--yes` | — | Approve the reviewed command and settings |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

#### plugin mcp test

Start the server and list its tools

```text
0 plugin mcp test [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

#### plugin mcp remove

Remove a custom MCP server

```text
0 plugin mcp remove [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm the removal |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

### lab research h1

HackerOne hacker-API helpers (read-only)

```text
0 lab research h1
```

Guide: [Read the workflow](/research-workflows/).

Subcommands: [auth](#lab-research-h1-auth) · [programs](#lab-research-h1-programs) · [scope](#lab-research-h1-scope).

#### lab research h1 auth

Verify HackerOne API credentials

```text
0 lab research h1 auth
```

#### lab research h1 programs

List or inspect HackerOne programs

```text
0 lab research h1 programs
```

Subcommands: [list](#lab-research-h1-programs-list) · [show](#lab-research-h1-programs-show).

#### lab research h1 programs list

List visible programs

```text
0 lab research h1 programs list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--bounty` | — | Only programs that pay bounties |
| `--vdp` | — | Only non-bounty (VDP) programs |
| `--state <state>` | — | Filter by program state (e.g. public_mode, soft_launched) |
| `--limit <n>` | — | Max programs to return (default 100, max 1000) |
| `--json` | — | Emit machine-readable JSON instead of a table |

#### lab research h1 programs show

Show details for a single program

```text
0 lab research h1 programs show <handle>
```

| Argument | Required | Description |
| --- | --- | --- |
| `handle` | Yes | Program handle (e.g. flutteruki) |

#### lab research h1 scope

Export HackerOne scope into the scope-file format used by 0.

```text
0 lab research h1 scope
```

Subcommands: [dump](#lab-research-h1-scope-dump).

#### lab research h1 scope dump

Write a program's structured_scopes to ~/.0/scopes/<handle>.json

```text
0 lab research h1 scope dump [options] <handle>
```

| Argument | Required | Description |
| --- | --- | --- |
| `handle` | Yes | Program handle |

| Option | Registered default | Description |
| --- | --- | --- |
| `--out <path>` | — | Override the output path |

## Private local review checks

These commands store operator-approved criteria for a real local project root,
not cloud enrollment or repository-controlled configuration. See the
[review-check workflow](/scan-code/).

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

Guide: [Read the workflow](/skills/).

Subcommands: [list](#skills-list) · [add](#skills-add) · [run](#skills-run) · [show](#skills-show) · [new](#skills-new) · [edit](#skills-edit) · [copy](#skills-copy) · [delete](#skills-delete) · [import](#skills-import) · [export](#skills-export) · [link](#skills-link) · [unlink](#skills-unlink) · [catalog](#skills-catalog) · [remove](#skills-remove).

#### skills list

List installed skills and linked folders

```text
0 skills list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

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

#### skills add

Add a skill from the catalog or GitHub (owner/repo[/path]); shows a review first

```text
0 skills add [options] <catalog-id-or-repo>
```

| Argument | Required | Description |
| --- | --- | --- |
| `catalog-id-or-repo` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--preview` | — | Only show the review |
| `--yes` | — | Install the reviewed commit |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

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

### memory

List, disable, export and import what 0 remembers across threads

```text
0 memory
```

Memory is what 0 remembers across threads. False-positive and evaluation memories live under [findings triage memory](#findings-triage-memory).

```bash
0 memory list
0 memory export -o memory.json
0 memory import memory.json --preview
```

Guide: [Read the workflow](/self-improvement/).

Subcommands: [list](#memory-list) · [set](#memory-set) · [export](#memory-export) · [disable](#memory-disable) · [enable](#memory-enable) · [import](#memory-import).

#### memory list

List memories

```text
0 memory list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--folder <id>` | — | Only memories for this folder id |
| `--limit <n>` | `100` | At most this many (1-200) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

#### memory disable

Stop using a memory in future threads

```text
0 memory disable [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

#### memory enable

Use a disabled memory again

```text
0 memory enable [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

#### memory export

Export memories as a portable archive

```text
0 memory export [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--folder <id>` | — | Only memories for this folder id |
| `-o, --output <file>` | — | Write to a file instead of stdout |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

#### memory import

Import a memory archive; imported memories start disabled

```text
0 memory import [options] <file>
```

| Argument | Required | Description |
| --- | --- | --- |
| `file` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--preview` | — | Only show what would be imported |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Use this engine database instead of the default |

## Private local review checks

These commands store operator-approved criteria for a real local project root,
not cloud enrollment or repository-controlled configuration. See the
[review-check workflow](/scan-code/).

### doctor checks

Manage private project checks and explicit revision approvals.

```text
0 doctor checks
```

Subcommands: [propose](#doctor-checks-propose) · [add](#doctor-checks-add) · [list](#doctor-checks-list) · [enable](#doctor-checks-enable) · [disable](#doctor-checks-disable) · [set](#doctor-checks-set) · [remove](#doctor-checks-remove).

#### doctor checks propose

Save a literal draft without enabling it. Creating a draft grants no authority
to execute it in future reviews.

```text
0 doctor checks propose [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--name <name>` **required** | — | Short check name (1–120 characters) |
| `--prompt <text>` **required** | — | Literal review criterion (1–2000 characters) |
| `--project <path>` | — | Local project directory (defaults to this checkout's root) |
| `--json` | — | Machine-readable result |

#### doctor checks add

Create and enable an explicitly approved literal check. At most eight checks
can be active in one local project.

```text
0 doctor checks add [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--name <name>` **required** | — | Short check name (1–120 characters) |
| `--prompt <text>` **required** | — | Literal review criterion (1–2000 characters) |
| `--yes` **required** | — | Approve this prompt for future local reviews |
| `--project <path>` | — | Local project directory (defaults to this checkout's root) |
| `--json` | — | Machine-readable result |

#### doctor checks list

List current prompts, revisions, and enabled or inactive status for the project.

```text
0 doctor checks list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--project <path>` | — | Local project directory (defaults to this checkout's root) |
| `--json` | — | Machine-readable result |

#### doctor checks enable

Approve the current revision. Use an expected revision when approval must refer
to the exact draft inspected by the operator.

```text
0 doctor checks enable [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` **required** | — | Confirm developer approval |
| `--expected-revision <n>` | — | Refuse if the inspected revision changed |
| `--project <path>` | — | Local project directory (defaults to this checkout's root) |
| `--json` | — | Machine-readable result |

#### doctor checks disable

Stop future evaluation without deleting prompt history.

```text
0 doctor checks disable [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--project <path>` | — | Local project directory (defaults to this checkout's root) |
| `--json` | — | Machine-readable result |

#### doctor checks set

Revise the literal prompt. Changing an enabled check requires fresh explicit
approval; stale expected revisions leave the previous state unchanged.

```text
0 doctor checks set [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--prompt <text>` **required** | — | Replacement literal prompt (1–2000 characters) |
| `--yes` | — | Approve the new revision if the check is enabled |
| `--expected-revision <n>` | — | Refuse if the inspected revision changed |
| `--project <path>` | — | Local project directory (defaults to this checkout's root) |
| `--json` | — | Machine-readable result |

#### doctor checks remove

Delete a local check and its revisions from the selected project.

```text
0 doctor checks remove [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--project <path>` | — | Local project directory (defaults to this checkout's root) |
| `--json` | — | Machine-readable result |

## XBOW benchmark runner

The XBOW runner lives in the benchmark workspace. See [Benchmarks](/benchmark/) and [Methodology](/benchmark/) for current commands, prerequisites, and measured-result interpretation. **The specialized runner does not implement a help-only `--help` path; passing it can start benchmark execution.** Inspect the documented arguments or `packages/bench/src/xbow-runner.ts` instead. Execution requires dedicated target environments and a benchmark budget.

## Workflow execution

See [Workflow CLI](/automations/) for templates, foreground execution, scope, and host lifetime.

### automation

Discover reusable definitions and execute them through the shared workflow runtime.

```text
0 automation
```

Subcommands: [list](#automation-list) · [show](#automation-show) · [run](#automation-run) · [create](#automation-create) · [edit](#automation-edit) · [duplicate](#automation-duplicate) · [versions](#automation-versions) · [rollback](#automation-rollback) · [delete](#automation-delete) · [triggers](#automation-triggers).

Aliases: `automations`.

#### automation list

List saved workflows and templates without starting an assessment.

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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

#### automation show

Inspect one saved workflow or select a template with `--template`.

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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

#### automation run

Execute one saved revision or template in the foreground. Ctrl-C cancels the run.
Completed execution can contain findings; consumers must inspect the results.

```text
0 automation run [options] [id]
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | No |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--template <id>` | — | Execute a template without saving a copy |
| `--revision <revision>` | — | Require this automation or template revision |
| `--target <target>` | — | Bind the authorized target |
| `--workspace <path>` | — | Workspace for local execution |
| `--scope <path>` | — | Scope JSON file |
| `--model <model>` | — | Configured 0 assessment model |
| `--inputs <path>` | — | Automation artifact inputs as a JSON object (32 KiB values; 256 KiB file read limit) |
| `--allow-apply` | — | Explicitly authorize supported patch application steps for this engine and run |
| `--time-cap <ms>` | — | Automation-wide time cap in milliseconds |
| `--cost-cap <usd>` | — | Automation-wide cost ceiling in USD |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--chat <id>` | — | Attach the run to an existing thread on the selected engine |
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

#### automation create

Create an automation from a template or a JSON definition.

```text
0 automation create [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--template <id>` | — | Start from a template (see `0 agents list --automation --templates`) |
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
| `--revision <n>` **required** | — | Revision to restore (see `0 agents set --automation versions`) |
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

#### automation triggers

Inspect and control an automation's schedules (needs a running engine).

```text
0 automation triggers
```

Subcommands: [list](#automation-triggers-list) · [enable](#automation-triggers-enable) · [disable](#automation-triggers-disable) · [remove](#automation-triggers-remove).

#### automation triggers list

List schedules for an automation.

```text
0 automation triggers list [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### automation triggers enable

Enable a schedule after reviewing it; it then runs unattended.

```text
0 automation triggers enable [options] <trigger-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `trigger-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm that this schedule was reviewed |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### automation triggers disable

Pause a schedule.

```text
0 automation triggers disable [options] <trigger-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `trigger-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### automation triggers remove

Delete a schedule.

```text
0 automation triggers remove [options] <trigger-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `trigger-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
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

Subcommands: [list](#threads-list) · [send](#threads-send) · [stop](#threads-stop) · [show](#threads-show) · [create](#threads-create) · [continue](#threads-continue) · [cancel](#threads-cancel) · [force-stop](#threads-force-stop) · [events](#threads-events) · [resume](#threads-resume) · [decide](#threads-decide) · [start](#threads-start) · [retry](#threads-retry) · [set](#threads-set) · [rename](#threads-rename) · [clear](#threads-clear) · [close](#threads-close) · [archive](#threads-archive) · [delete](#threads-delete) · [export](#threads-export).

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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

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
| `--json` | — | Print JSON (the default) |
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

#### threads create

Create a session within the engine's authorized workspace, scope, and model configuration. --config reads a bounded JSON object; it cannot expand engine grants.

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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

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
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

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
| `--engine-url <url>` | — | Attach directly to a running trusted engine |
| `--engine-token-env <name>` | — | Environment variable holding the attached engine token |
| `--engine <id>` | — | Use a registered remote engine; targets and inputs are interpreted there |
| `--engines-config <path>` | — | Operator engine connection registry JSON file |
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

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
| `--db-path <path>` | — | Control database with saved automations and run history |
| `--format <format>` | `json` | Output format: json or text |

## Reference sources

Registration entry point: `packages/cli/src/index.ts`. Command implementations
are exported through `packages/cli/src/commands/index.ts`. Workflow guides explain
handler behavior and prerequisites beyond the registered flags.

## Team workspace setup

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
| `--target <target>` | — | Authorized target |
| `--scope <path>` | — | Scope policy JSON file |
| `--title <title>` | — | Thread title |
| `--wait` | — | Wait for the turn to finish and print the reply |
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

### agents

Create, inspect and control Agents.

```text
0 agents
```

Subcommands: [list](#agents-list) · [run](#agents-run) · [set](#agents-set) · [show](#agents-show) · [presets](#agents-presets) · [create](#agents-create) · [pause](#agents-pause) · [resume](#agents-resume) · [acknowledge](#agents-acknowledge) · [archive](#agents-archive) · [delete](#agents-delete) · [activations](#agents-activations) · [budget](#agents-budget) · [files](#agents-files) · [triggers](#agents-triggers) · [webhook](#agents-webhook).

#### agents list

List Agents.

```text
0 agents list [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--status <status>` | — | Only active, paused, archived |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents show

Show a Agent (full or prefix ID).

```text
0 agents show [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents presets

List Agent presets.

```text
0 agents presets [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents create

Create a Agent from a preset or a JSON definition.

```text
0 agents create [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--preset <id>` | — | Start from a preset (see `0 agents list --presets`) |
| `--name <name>` | — | Name |
| `--file <path>` | — | Agent JSON object (overrides preset fields) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents set

Change a Agent's settings.

```text
0 agents set [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--name <name>` | — | Name |
| `--mission <text>` | — | One-line purpose |
| `--daily-usd <usd>` | — | Daily budget in USD |
| `--max-runs <n>` | — | Maximum runs per day |
| `--file <path>` | — | Patch JSON object |
| `--version <n>` | — | Reviewed version (default: the current one) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents pause

Pause a Agent.

```text
0 agents pause [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents resume

Resume a paused Agent.

```text
0 agents resume [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--acknowledge` | — | Also acknowledge review of changed scope, model or tools |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents acknowledge

Mark changed scope, model or tools as reviewed.

```text
0 agents acknowledge [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents archive

Archive a Agent; its history stays.

```text
0 agents archive [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents delete

Delete a Agent; its automations are detached, not deleted.

```text
0 agents delete [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm deletion |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents run

Run a Agent now; starts a thread (needs a running engine).

```text
0 agents run [options] <id>
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

#### agents activations

List a Agent's recent runs.

```text
0 agents activations [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--limit <n>` | `50` | Maximum rows (1-200) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents budget

Show a Agent's budget and the last 24 hours of spend.

```text
0 agents budget [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents files

Read and edit a Agent's instructions and memory files.

```text
0 agents files
```

Subcommands: [list](#agents-files-list) · [get](#agents-files-get) · [put](#agents-files-put) · [rm](#agents-files-rm).

#### agents files list

List files.

```text
0 agents files list [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents files get

Print a file's content.

```text
0 agents files get [options] <id> <path>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `path` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents files put

Create or replace a file from --file or --content.

```text
0 agents files put [options] <id> <path>
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

#### agents files rm

Delete a file.

```text
0 agents files rm [options] <id> <path>
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

#### agents triggers

Control what starts a Agent's automations.

```text
0 agents triggers
```

Subcommands: [list](#agents-triggers-list) · [add](#agents-triggers-add) · [enable](#agents-triggers-enable) · [disable](#agents-triggers-disable) · [check](#agents-triggers-check) · [rm](#agents-triggers-rm).

#### agents triggers list

List triggers.

```text
0 agents triggers list [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents triggers add

Add a trigger for an automation the Agent owns; disabled unless --enable --yes.

```text
0 agents triggers add [options] <id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--automation <id>` | — | Owned automation to start |
| `--kind <kind>` | — | schedule \| manual \| github-pr |
| `--file <path>` | — | Trigger JSON object with schedule or github settings |
| `--enable` | — | Enable immediately |
| `--yes` | — | Confirm that an enabled trigger was reviewed |
| `--repo <owner/name>` | — | github-pr: repository to watch |
| `--base-branch <branch>` | — | github-pr: only pull requests into this branch |
| `--comment` | — | github-pr: comment on each pull request with one short summary, edited in place on later pushes (default: off) |
| `--include-forks` | — | github-pr: also review pull requests from forks, marked untrusted (default: skipped) |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents triggers enable

Enable a trigger after reviewing it.

```text
0 agents triggers enable [options] <id> <trigger-id>
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

#### agents triggers disable

Pause a trigger.

```text
0 agents triggers disable [options] <id> <trigger-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `trigger-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents triggers check

Poll a pull request trigger now instead of waiting for its next poll.

```text
0 agents triggers check [options] <id> <trigger-id>
```

| Argument | Required | Description |
| --- | --- | --- |
| `id` | Yes |  |
| `trigger-id` | Yes |  |

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents triggers rm

Delete a trigger.

```text
0 agents triggers rm [options] <id> <trigger-id>
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

#### agents webhook

GitHub webhook for pull request Agents (server mode). Hidden: most installs poll. See [Agents](/agents/#faster-with-a-github-webhook-server-mode).

```text
0 agents webhook
```

Subcommands: [status](#agents-webhook-status) · [secret](#agents-webhook-secret).

#### agents webhook status

Show whether the webhook is set up and the last deliveries.

```text
0 agents webhook status [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

#### agents webhook secret

Manage the webhook secret.

```text
0 agents webhook secret
```

Subcommands: [rotate](#agents-webhook-secret-rotate).

#### agents webhook secret rotate

Create the secret, or replace it; the old one keeps working for 5 minutes. Printed once.

```text
0 agents webhook secret rotate [options]
```

| Option | Registered default | Description |
| --- | --- | --- |
| `--yes` | — | Confirm; update the secret on GitHub afterwards |
| `--json` | — | Print machine-readable JSON |
| `--db-path <path>` | — | Control database (default: the user database) |

## Reference sources

Registration entry point: `packages/cli/src/index.ts`. Command implementations
are exported through `packages/cli/src/commands/index.ts`. Workflow guides explain
handler behavior and prerequisites beyond the registered flags.

## Team workspace setup

### config team

```text
0 config team
```

Provision opt-in accounts for a customer-controlled team engine. Account-free local
use remains the default. Creating a config does not activate it on a running host.
See [Team workspaces](/engines/#team-workspaces) for roles and deployment boundaries.

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
