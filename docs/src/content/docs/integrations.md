---
title: Integrations
description: Connect coding agents and MCP tools, configure workers, extend 0, and export results.
---

Choose the integration direction first:

| Goal | Interface | What runs where |
|---|---|---|
| Let a coding agent run a complete review or scan | [Direct CLI](#coding-agent-workflows) | The agent launches the local CLI with your configured model runtime |
| Give an external agent selected live-target tools | [MCP server](#mcp-server) | The client owns reasoning; a local stdio process executes the exposed tools |
| Give 0 tools from another MCP server | [MCP client configuration](#connect-external-mcp-tools-to-0) | 0 launches operator-configured stdio servers |
| Install a third-party tool | [Hackstore plugins](#cli-managed-operator-plugins) | Enabled JavaScript runs as a local child process, not in a sandbox |
| Let the model author executable tools | [Self-extension](#model-authored-executable-plugins-self-extension) | Generated TypeScript runs in disposable Docker or smolvm guests |
| Connect organization credentials | [Cloud auth](#cloud-auth) | Authentication and hosted model transport are separate from managed execution |

Local tools and BYOK workflows do not require a cloud account. Selecting hosted
models does not move your tool execution to a managed worker. The
[website](https://0.security/harness/) describes the product organization;
the command and runtime sources linked below define these integration contracts.

## Coding-agent workflows

A coding agent with shell access can invoke the CLI directly, without an MCP
adapter. Install 0 where that agent runs, configure a supported
[model provider](/api-keys/), and set the working directory explicitly:

```bash
0 review /absolute/path/to/repo --format json > review.json
0 scan --target https://target.example.com --scope /absolute/path/to/scope.json --format json > scan.json
```

The CLI's inference is separate from the coding agent's own model session; an
agent subscription is not automatically a credential for every runtime. Inspect
the command's exit status and saved report, not just the last line of stdout.
Findings can be leads or unconfirmed results: use the reported evidence and
[verification workflow](/verification-result/) rather than treating a successful
CLI invocation as proof of exploitability. Keep fix application a separate,
operator-reviewed step; see [Scan Workflows](/scan-workflows/).

For CI, use [GitHub CI](/ci/github-action/). For fine-grained interaction with a
live target rather than a complete pipeline, use the MCP server below. It is
not a remote API for arbitrary CLI commands, source review, or automatic
find/verify/fix orchestration.

## MCP Server

The MCP server (`0 mcp-server`) exposes a fixed subset of 0's live-target tools
through the [Model Context Protocol](https://modelcontextprotocol.io) over stdio.
Use an MCP client that supports launching local stdio servers. Client-specific
configuration formats differ; the example below uses the common `mcpServers`
shape, not a claim of qualification for every named client.

**Source:** [`mcp-server.ts`](https://github.com/0sec-labs/0sec/blob/main/packages/cli/src/commands/mcp-server.ts)

### Usage

```bash
0 mcp-server \
  --target https://target.example.com \
  --scan-id my-scan-001 \
  --scope /absolute/path/to/scope.json \
  --tools http_request,crawl,query_findings
```

### Required options

| Option | Description |
|--------|-------------|
| `--target <url>` | Target URL for this MCP session (required) |
| `--scan-id <id>` | Scan ID to associate findings and target updates with (required) |

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--db-path <path>` | — | Path to SQLite database for persistence |
| `--timeout <ms>` | `30000` | Per-tool timeout in milliseconds (minimum 1000) |
| `--scope <path>` | — | Path to a 0 scope JSON file. Out-of-scope URLs are refused by target tools; the initial target is checked before opening storage |
| `--tools <names>` | all tools | Comma-separated subset of MCP tools to expose |
| `--rate-limit <spec>` | `5` rps | Per-host request rate limit. An active `--engagement-profile` caps this |
| `--allow-scanners` | `false` | Disable generic-scanner suppression for scoped engagements |
| `--engagement-profile <name>` | `standard` | Hardening posture: `standard` (default behaviour) or `conservative` (1 rps/host ceiling, full jitter, no WAF evasion) |
| `--no-waf-evasion` | enabled | Disable the adaptive WAF-evasion ladder (encoding/casing/whitespace mutation on block) |

### Exposed tools

Use `--tools` to select from these live-attack tools:

| Tool | Purpose |
|------|---------|
| `http_request` | Send an HTTP request to the target |
| `crawl` | Crawl the target application for endpoints |
| `submit_form` | Submit a form on the target |
| `send_prompt` | Send an LLM prompt to the target |
| `save_finding` | Persist a discovered finding |
| `update_target` | Update the target definition mid-session |
| `query_findings` | Query persisted findings |
| `update_finding` | Update an existing finding's status/metadata |
| `done` | Signal session completion |
| `payload_lookup` | Look up a known payload |
| `wp_fingerprint` | Fingerprint WordPress instances |
| `mongo_objectid` | Generate/extract MongoDB ObjectIds |

### Auth configuration

Target authentication is provided via the `ZERO_MCP_AUTH_JSON` environment
variable. Set it to a JSON object with one of these shapes:

```json
// Bearer token
{"type":"bearer","token":"eyj..."}

// Cookie
{"type":"cookie","value":"session=abc123"}

// Basic auth
{"type":"basic","username":"admin","password":"pass"}

// Custom header
{"type":"header","name":"X-API-Key","value":"sk-..."}
```

See [Configuration](/configuration/) for the full `--auth` flag details used by
`0 scan` and `0 review`.

### Rate limiting and engagement posture

The MCP server supports the same engagement hardening as the scan path. When
`--engagement-profile conservative` is active:

- WAF-evasion ladder is disabled (regardless of `--no-waf-evasion`)
- Per-host rate is capped at 1 rps (config override can only lower it further)
- Full request jitter is applied to all rate-limit buckets

An explicit `--rate-limit` value is clamped to the posture's ceiling. The
posture clamps, never increases, the configured rate.

When a posture is active, the server attempts to record an
`engagement_posture_applied` event. If the scan is absent from the database,
that foreign-key-bound event may not persist; a warning and effective-posture
summary go to stderr. `--scan-id` associates tool state with an ID; it does not
create a complete scan pipeline or run an independent verifier.

### Attribution headers

MCP supports attribution headers for authorized engagements:

- `ZERO_MCP_ATTRIBUTION_HEADERS_JSON` — JSON array of `"Header-Name: value"`
  strings
- `ZERO_MCP_ATTRIBUTION_UA_TOKEN` — free-form User-Agent token appended to the
  default UA string

### Client setup

For a client accepting `mcpServers` (for example Claude Desktop), add:

```json
{
  "mcpServers": {
    "0": {
      "command": "0",
      "args": [
        "mcp-server",
        "--target", "https://target.example.com",
        "--scan-id", "agent-session",
        "--scope", "/absolute/path/to/scope.json",
        "--tools", "http_request,crawl,query_findings"
      ]
    }
  }
}
```

Use an absolute path for `command` if a GUI-launched client cannot find `0` on
its `PATH`. This server does not need an `ANTHROPIC_API_KEY` to expose tools:
the MCP client supplies the reasoning model. If the target needs authentication,
provide `ZERO_MCP_AUTH_JSON` through that client's secret/environment mechanism.
`send_prompt` sends a prompt to the **target under test**, not a provider model.

The MCP transport is stdio-only; stdout is reserved for protocol frames and
diagnostics go to stderr. The client manages the process lifetime. Limit the
tool list and provide scope explicitly; there is no interactive console
approval callback in this server. Enabling a tool is not authorization to test
systems you do not own or have permission to assess.

## Connect external MCP tools to 0

This is the reverse direction: `0 console` and the OpenTUI connect external
stdio servers from the **JSON array** in `ZERO_MCP`. It is not a
`{"mcpServers": ...}` object or a config-file path:

```bash
env 'ZERO_MCP=[{"id":"workspace","command":"node","args":["/absolute/path/to/mcp-server.js"],"cwd":"/absolute/path/to/workspace"}]' \
  0 console
```

Replace the command with an installed MCP server you trust; the same environment
works with `0 tui`. Each entry accepts `id`, `command`, and optional `args`,
`env` (string values), and `cwd`. For a Python stdio server, use `command:
"python3"` and its script path in `args`; no Python-specific 0 plugin API is
required. Provision server dependencies yourself.

Tools become `mcp__<server-id>__<tool-name>`. Results are untrusted data and
tools default to network-capable for authorization purposes. These gates do
not sandbox the server process: starting a configured server already executes
its code under your account. Give it only the credentials and filesystem
access its workflow needs.

Malformed entries and failed connections are skipped rather than preventing
console startup. If no tools appear, check the JSON array, executable path,
server arguments and stdio handshake; do not assume an empty roster means the
server connected successfully. The CLI configuration here supports stdio,
not an HTTP/SSE URL. An SDK caller can supply its own transport to
`McpHost.register`; that does not create a remote-transport CLI option.

**Sources:** [`mcp-host.ts`](https://github.com/0sec-labs/0sec/blob/main/packages/core/src/agent/mcp-host.ts),
[`console.ts`](https://github.com/0sec-labs/0sec/blob/main/packages/cli/src/commands/console.ts),
[`tui/run.tsx`](https://github.com/0sec-labs/0sec/blob/main/packages/cli/src/tui/run.tsx).

## Native workers and multiple models

Native sessions can use `spawn_agent` for one focused task or `spawn_agents`
for a batch of up to eight. Batches default to four concurrent children;
`env ZERO_SUBAGENT_CONCURRENCY=2 0 tui` lowers that concurrency. Each task
gets fresh context and its own turn budget, while scope, rate limits and the
parent's shared cost ceiling remain in force. Children do not receive recursive
spawn tools. Findings merge back through the parent; a child failure is not
silently a successful empty result.

Use the [role model picker](/configuration/#multi-model-role-routing) to assign
worker models. A tool request's `role` is a routing label, not a permission
role. Explicit model choices must be the parent model or an operator-approved
role pin. Unmapped roles inherit the parent. Single-model mode overrides child
selections with the parent model.

Embedded `LlmApiRuntime` callers can additionally opt into `RuntimeConfig.autoRoute`
or an `agentModels` role value of `"auto"` to widen the model-selection guard.
This is not a stock CLI `--auto-route` flag. Crucially, forked children still
inherit the parent's **provider, endpoint and account**, with no cross-account
fallback chain. Use model IDs that account or gateway actually serves; the
presence of another provider's ambient credentials does not reroute a fork to
it. Hosted children must pass the hosted model catalog check. Model selection
does not change tool permissions or establish that a model is better at
verification. Ordinary worker consensus is not independent reproduction.

**Sources:** [`tools.ts`](https://github.com/0sec-labs/0sec/blob/main/packages/core/src/agent/tools.ts),
[`runtime/types.ts`](https://github.com/0sec-labs/0sec/blob/main/packages/core/src/runtime/types.ts),
[`llm-api.ts`](https://github.com/0sec-labs/0sec/blob/main/packages/core/src/runtime/llm-api.ts).

## HackerOne integration

`0 h1` provides read-only access to the HackerOne hacker API for program
discovery and scope enumeration.

**Source:** `packages/cli/src/commands/h1.ts`

### Subcommands

| Subcommand | Description |
|------------|-------------|
| `0 h1 auth` | Verify H1 credentials against the API |
| `0 h1 programs list` | Paginate/filter the program list |
| `0 h1 programs show <handle>` | Program detail + scope summary |
| `0 h1 scope dump <handle>` | Export structured scopes as scope JSON |

### Credentials

Set `H1_API_IDENTIFIER` and `H1_API_TOKEN` in the environment, or save the same
unquoted `KEY=VALUE` pairs in `~/.0/h1.env` with mode `0600`. A complete
environment pair takes precedence. The identifier is the name entered at token
creation, **not your HackerOne handle**. The API uses Basic authentication;
`0 h1 auth` verifies existing credentials and does not perform a login flow.

```text
H1_API_IDENTIFIER=my-security-integration
H1_API_TOKEN=your-api-token
```

Do not add `export` prefixes, shell quoting, or multiline values to this file.
See [`h1/credentials.ts`](https://github.com/0sec-labs/0sec/blob/main/packages/core/src/h1/credentials.ts).

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | User/data error (bad input, parse failure, missing handle) |
| `2` | Auth failure (missing creds or HTTP 401/403 from H1) |
| `3` | Rate-limit or network error |

### Example

```bash
# Verify credentials
0 h1 auth

# List programs
0 h1 programs list --limit 20

# Show program detail
0 h1 programs show my-program-handle

# Export scope for use as a 0 scope file
0 h1 scope dump my-program-handle --out my-scope.json
```

Review the program's current policy and automation restrictions before using
an exported scope. Scope enumeration is not permission to automate testing.
This integration does not submit HackerOne reports, rank program fit, or ingest
hacktivity; disclosure drafts below are a separate local workflow.

## Cloud auth

`0 auth` manages scoped organization credentials. For 0cloud availability and operator-host setup, see [Getting started](/getting-started/#hosted-models-draft). Local API-key and subscription use require no 0cloud account.

**Source:** `packages/cli/src/commands/auth.ts`

### Subcommands

| Subcommand | Description |
|------------|-------------|
| `0 auth login` | Open browser at the cloud host's `/cli-auth` page, poll for a scoped token |
| `0 auth login --token <value>` | Manual credential path — persist a token directly |
| `0 auth login --host <url>` | Point at a self-hosted cloud host |
| `0 auth logout` | Delete `~/.0/cloud.env` and `~/.0cloud/credentials.json` |
| `0 auth status` | Verify cloud credentials against the authenticated inference-account endpoint |

### Credential storage

Credentials persist to `~/.0/cloud.env` (mode `0600`) with the format:

```text
# DO NOT commit this file or share its contents.
ZERO_CLOUD_HOST=https://cloud.0.security
ZERO_CLOUD_TOKEN=scoped-token-here
```

Normal login also best-effort writes compatible credentials to
`~/.0cloud/credentials.json`; normal logout removes both files. Development-state
login/logout keeps production-compatible credentials separate. Cloud auth uses
Bearer tokens. Successful login or status verifies credentials, not the
availability of every model or a managed execution environment.

### Manual token path

For self-hosted or recovery use, pass a token directly:

```bash
0 auth login --token "your-token" --host "https://your-host.example.com"
```

This skips the browser flow entirely and persists the token immediately.
Run `0 auth status` afterward to verify it; manual persistence does not validate
the token with the server. Avoid putting real tokens in shared shell history.

## Report formats

`scan`, `review`, and `audit` accept `--format` and default to terminal output. Supported formats and aliases vary by command.

**Source:** `packages/cli/src/formatters/`

| Format | Flag | Description |
|--------|------|-------------|
| **JSON** | `--format json` | Structured JSON with findings, summary, and metadata |
| **SARIF** | `--format sarif` | Static Analysis Results Interchange Format — upload to GitHub Code Scanning or other SARIF consumers |
| **HTML** | `--format html` | Self-contained HTML report with severity bars, finding cards, collapsed evidence |
| **PDF** | `--format pdf` | PDF report via pdfkit (US Letter). Tables, severity bars, finding details |
| **Markdown** | `--format markdown` | Markdown report |
| **Terminal** | `--format terminal` | Terminal-formatted output with ANSI colors |

### SARIF for GitHub Code Scanning

The SARIF output is compatible with `github/codeql-action/upload-sarif@v4`.
See [GitHub CI](/ci/github-action/) for a full workflow example.

```bash
0 review . --format sarif > results.sarif
```

### PDF report

```bash
0 scan --target http://127.0.0.1:8080 --scope ./scope.json --format pdf
```

The PDF formatter lazily loads pdfkit so the bun-compiled binary never bundles
it. Output is US Letter format with severity-colored sections.

### HTML report

```bash
0 scan --target http://127.0.0.1:8080 --scope ./scope.json --format html
```

The HTML formatter produces a standalone page with severity bars, finding cards,
collapsed request/response evidence, and meta tags.

## Docker image

The Docker publishing workflow builds a **Linux amd64** image on GitHub
Container Registry. The Dockerfile contains some architecture-aware dependency
provisioning, but the current publisher is not multi-architecture:

```
ghcr.io/0sec-labs/0sec:latest
ghcr.io/0sec-labs/0sec:<sha>
ghcr.io/0sec-labs/0sec:main
```

**Sources:** [`Dockerfile`](https://github.com/0sec-labs/0sec/blob/main/Dockerfile),
[`docker-publish.yml`](https://github.com/0sec-labs/0sec/blob/main/.github/workflows/docker-publish.yml).
Use a digest or the published short-SHA tag when repeatability matters;
`latest` follows eligible main builds, not a promise of a stable release.

### Image contents

The runtime image (based on `ubuntu:24.04`) includes:

| Category | Tools |
|----------|-------|
| **Node.js runtime** | Node 24 (copied from builder stage), npm, npx |
| **Static analysis** | FoxGuard (pre-provisioned, checksum-pinned) |
| **Web pentesting** | sqlmap, nmap, nikto, gobuster, hydra, ffuf, wfuzz, whatweb, wafw00f, dirb |
| **Active Directory** | impacket (0.13.1), certipy-ad (5.1.0), bloodhound-ce (1.9.1), ldap-utils, krb5-user |
| **Cloud identity** | AzureHound (v3.0.0, checksum-pinned) |
| **Source analysis** | ripgrep (for fast source-tree searches in audit/scan), jq, git |
| **Container analysis** | skopeo |
| **Scripting** | python3, python3-requests, python3-bs4 |
| **Optional** | SecLists wordlists (`INSTALL_SECLISTS=1` build arg, ~1GB extra) |

### Usage

```bash
docker run --rm \
  -e ANTHROPIC_API_KEY=$KEY \
  -v "$PWD:/work" -w /work \
  ghcr.io/0sec-labs/0sec:latest review .

# Scan a web target
docker run --rm \
  -e OPENAI_API_KEY=$KEY \
  -v "$PWD:/work:ro" -w /work \
  ghcr.io/0sec-labs/0sec:latest scan \
    --target https://example.com \
    --scope /work/scope.json
```

The container runs as the `ubuntu` user (uid 1000). Mount your working directory
at `/work` if you need the container to read source code or write reports.

### Security model

- The image drops privileges to the `ubuntu` user before executing commands
- `INSTALL_SECLISTS=1` adds optional wordlists. AzureHound is included by default;
  changing `AZUREHOUND_VERSION` also requires matching recorded checksums
- Ubuntu packages follow the configured apt repositories; the Dockerfile pins
  the listed AD Python package versions and verifies AzureHound/FoxGuard downloads
- The AD tools venv is deliberately not on `PATH` to avoid shadowing system
  Python packages

### Build your own

```bash
docker build -t 0sec:local .
docker build --build-arg INSTALL_SECLISTS=1 -t 0sec:full .
```

## Plugin system

0 supports two plugin mechanisms:

- **Model-authored executable plugins** — TypeScript code submitted by the
  model at runtime, executed in isolated Docker containers or smolvm microVMs.
  This is the primary self-extension path, enabled by default for non-verifier
  agents (operator can opt out via `allowModelSelfExtension: false`).
- **Third-party operator plugins**: tools installed from Hackstore and enabled
  for a project. These run as local child processes, not in the self-extension sandbox.

### Model-authored executable plugins (self-extension)

The model can submit TypeScript source files as an executable plugin during a
session. Each plugin declares a manifest with tool names, descriptions, JSON
parameter property schemas, and **capabilities** that gate broker access:

| Capability | Description |
|------------|-------------|
| `compute` | Guest-local computation, including scratch files; no host filesystem or provider access |
| `model-call` | May call the configured model provider through a controller-owned broker |
| `network` | Requests to authorized host network tools, subject to the parent's scope |
| `filesystem-read` / `filesystem-write` | Requests to authorized host filesystem tools, subject to local scope |
| `process-exec` / `findings-write` | Applicable host execution or finding-publication gates; explicitly denied broker tools remain unavailable |

A plugin's entry source file exports an `async run(toolName, args, sdk)`
function. The `sdk` object provides three broker methods:

- **`sdk.callTool(name, args)`** — calls another registered executable tool
  or an available host tool through the parent's authorization gates. Returns output or throws.
- **`sdk.callSkill(name, args)`** — calls another registered executable skill
  by name. Throws if not found.
- **`sdk.callModel({system?, messages, tools?})`** — delegates a model
  request through the parent's authorized provider. Requires `model-call`;
  `messages` is required and nonempty. It accepts no model, account, credential,
  or provider override. Use native worker routing for separately selected models.

Guest code runs in an isolated guest (Docker backend by default) with no
network, read-only root, and bounded resources. The guest SDK **cannot**
invoke host execution tools (`bash`, `run_command`, `python_exec`),
delegation tools (`spawn_agent`, `spawn_agents`), or control tools
(`self_extend`, `apply_patch`, `write_file`). Nested invocations share a
single broker call budget and are limited to depth 4.

Manifest `parameters` contains property schemas, such as
`{"value":{"type":"number"}}`; declare `required` beside it.
Node 24 strips erasable TypeScript syntax. Provision dependencies in the toolbox.

#### Lifecycle

1. **Submit** — `submit({manifest, files, entry, kind?}, context)` saves an
   immutable versioned snapshot, validates the source in a guest container
   (admission), and activates it.
2. **Execute** — `execute(toolName, args, context)` runs the active version's
   entry function with the supplied arguments. Failed executions increment
   the version's `failureCount` and record `lastError`.
3. **Replace** — submitting the same plugin id creates a new active version.
   Prior versions are retained for rollback. At 32 versions, submission fails
   rather than silently evicting an old version.
4. **List** — `list()` returns every retained version with its
   `evidenceStatus` (`structural` for direct submits, `measured` for evolved
   versions), `active` flag, `failureCount`, and `lastError`.
5. **Rollback** — `rollback(pluginId, versionId, context)` reactivates a
   prior version. Retains the rolled-back version for further rollback.
6. **Evolve** — `evolve(pluginId, profile, deps, context)` runs the
   improvement loop over the active version's snapshot, producing a new
   `measured` version on promotion.
7. **Close** — releases the manager and aborts pending operations.

For the model-facing lifecycle, use `self_extend` with `action` set to `submit`,
`list`, `evolve`, or `rollback`. Point `ZERO_PLUGIN_EVOLUTION_CONFIG` at an
operator-owned [source-evolution config](/improvement-plane/#config-shape) to
expose the `default` evaluation profile. It must use the same backend and pinned
image as the executable. Creation and replacement work without a profile;
measured evolution requires one.

YOLO removes per-action prompts within the configured scope; it does not let
generated code replace its evaluator, inherit provider credentials, or expand
host authorization. Direct submissions are structurally admitted; measured
evolution requires the improvement loop.

To provision the default guest and start a session:

```bash
docker build --target toolbox -t 0sec-toolbox:local .
env ZERO_PLUGIN_BACKEND=docker ZERO_PLUGIN_IMAGE=0sec-toolbox:local 0 tui
```

Self-extension is enabled by default for non-verifier sessions; an explicit
`allowModelSelfExtension: false` disables it. Provisioning is still required:
enablement does not install Docker or pull the guest image. Ask the agent to
submit an executable through `self_extend`, inspect `list` for the retained
version, and call its declared tool by name. There is no `0 plugin submit`
command for this path. For measured evolution, start the session with
`env ZERO_PLUGIN_EVOLUTION_CONFIG=/absolute/path/to/evolution.json 0 tui`
and use the `default` profile. Source-access consent and promotion settings in
that operator-owned config are separate from self-extension enablement.

**Sources:** [`agent/executable-plugins.ts`](https://github.com/0sec-labs/0sec/blob/main/packages/core/src/agent/executable-plugins.ts),
[`plugins/executable.ts`](https://github.com/0sec-labs/0sec/blob/main/packages/core/src/plugins/executable.ts).

#### Storage

The default store is `~/.0/executable-plugins/`, separate from Hackstore's
`~/.0/plugins/`. `registry.json` retains snapshot UUIDs under `snapshots/<uuid>`,
content digests, immutable image identity, manifest digests and evolved-version
receipt digests. Registry provenance is checked on read; snapshot contents are
verified at refresh/admission/execution boundaries. These are local integrity
checks, not registry signatures or an external attestation.

#### Backend

| Backend | Requirement | Isolation |
|---------|------------|-----------|
| `docker` (default) | Local Docker daemon; configured Node 24 toolbox image | `--network none`, read-only root, cap-drop all, no-new-privs, PIDs limit, bounded memory/CPU |
| `smolvm` | KVM, smolvm **1.14.6**, Node 24 toolbox archive | MicroVM with dedicated kernel; bounded resources and no guest network |

Default image for agent-created submissions is `0sec-toolbox:local`, overridable
with `ZERO_PLUGIN_IMAGE`; the smoke script defaults to `0sec-toolbox:qualification`.
For smolvm, configure `ZERO_SMOLVM_IMAGE_ARCHIVE`. The image is resolved to an immutable digest
on first use; resumed/promoted versions retain that digest, not a retagged
reference.

The backend isolates executable plugins and evolution workers. The controller
and authorized host tools execute outside it. Every invocation starts a fresh
guest; smolvm incurs VM startup overhead.

Plugin validation imports and invocations share the controller's
[worker admission budgets](/improvement-plane/#worker-admission-and-scale)
with source evolution. Root calls use a bounded FIFO queue; nested calls
reserve additional resources immediately or fail rather than deadlock.
Timeouts include queue wait, and uncertain guest cleanup stops new admissions.
Listing versions and changing rollback metadata do not start guests.

#### Version lifecycle diagram

```
submit        ┌──────────┐     execute ──► success
  │           │ Version 1 │                 └── failureCount++
  ├──►active  │(structural)│
  │           └────┬──────┘
submit v2         │
  │           ┌────▼──────┐
  ├──►active  │ Version 2 │     rollback ──► Version 1 active again
  │           │(structural)│
  │           └────┬──────┘
evolve            │
  │           ┌────▼──────┐
  └──►active  │ Version 3 │
              │(measured) │
              └───────────┘
```

### CLI-managed operator plugins

**Source:** `packages/cli/src/commands/plugin.ts`

Hackstore is the default community registry. Override it with `ZERO_REGISTRY_URL`
or `--registry` on browse, search, and install. An explicit empty setting disables
fetching. Entries use the unconfigured signature verifier and are marked
`unverified`.

The [author guide](/hackstore/)
covers executable scaffolding, the manifest, and a local two-file installation
in an isolated home. The installer writes `plugin.js` and `plugin.json` only.
Use 0 0.17.0 or newer for direct plugin calls. The 0.16.3 binary has a
tool-registry bug in `plugin run`.

#### Subcommands

| Subcommand | Description |
|------------|-------------|
| `0 plugin list` | List installed plugins |
| `0 plugin browse` | List the configured registry |
| `0 plugin search <query>` | Search the configured registry |
| `0 plugin install <id>` | Write plugin files to disk (does not execute) |
| `0 plugin enable <id>` | Record operator decision to permit the plugin |
| `0 plugin disable <id>` | Revoke enablement |
| `0 plugin info <id>` | Show plugin manifest and capabilities |
| `0 plugin run <id> <tool> [pairs...]` | Invoke a tool; name it explicitly before `key=value` arguments. Effectful calls require `--yes`. |

#### Security model

CLI-managed plugins have three distinct states:

| State | Description |
|-------|-------------|
| **Installed** | Files on disk. `install` writes bytes; runs nothing |
| **Enabled** | Per-project operator decision recorded by the enablement store |
| **Loaded** | The enabled plugin starts executing in a child process, before any tool call |

Declared capabilities are `compute`, `model-call`, `network`, `filesystem-read`,
`filesystem-write`, `process-exec`, and `findings-write`. They inform host-side
approval decisions; they do not enforce operating-system restrictions. A plugin
runs under the operator's account. Review code before enabling it. Omitting
`--yes` for an effectful call prevents the call, not the preceding plugin load.

Use `0 plugin enable <id>` from the intended project, then launch `0 tui`
there for agent access. The OpenTUI pins the approved plugin host for each chat;
marketplace changes prepare future chats rather than replacing a live chat's
tools. Start a new chat after changing enablement. Disabling a plugin is not a
kill switch for already leased hosts: end their sessions to stop that code.
Direct `plugin run` reloads and checks the current approval on each invocation.
Do not assume every batch command or the readline console auto-loads Hackstore
plugins merely because the core supports a `PluginHost`.

**Source:** [`session-plugin-host.ts`](https://github.com/0sec-labs/0sec/blob/main/packages/cli/src/tui/session-plugin-host.ts).

## Disclose and evidence

`0 disclose` provides structured vulnerability disclosure tooling for
findings generated during a scan.

**Source:** `packages/cli/src/commands/disclose.ts`

### Subcommands

| Subcommand | Description |
|------------|-------------|
| `0 disclose [findingId]` | Assemble advisory drafts for an ID/prefix, or batch persisted findings when omitted |
| `0 disclose evidence-pack <finding.json>` | Assemble a DRAFT vendor notification markdown (never sends) |
| `0 disclose track <findingId>` | Drive the disclosure tracking state machine |
| `0 disclose review <finding.json>` | Render a deterministic reproducibility manifest |

Start with `0 disclose <finding-id> --db-path ./scans.db --dry-run` to inspect
the advisory output plan. Drafting and recording a transition to `sent` do not
send a vendor notification or file a HackerOne report. The separate
`--reverify` mode executes PoC steps against a supplied target; it is not just
report formatting and needs its own authorization and scope allowlist.

### Evidence pack

The `evidence-pack` subcommand produces a draft vendor notification containing
what/where/impact/repro/remediation sections. It emits a mandatory
`DRAFT — NOT SENT` banner.

```bash
0 disclose evidence-pack finding.json --target "lodash@4.17.21" --out notification.md
```

Options:
- `--target <label>` — affected target/package label
- `--affected-ref <ref>` — git ref or version range
- `--allow-unreproduced` — stage a draft even without PoC reproduction
- `--out <file>` — write to file instead of stdout

### Disclosure tracking

The `track` subcommand drives a state machine through statuses defined in
`@0/core`:

```bash
# Open a fresh draft record
0 disclose track finding-001 --out record.json

# Transition to "sent" with vendor info
0 disclose track finding-001 \
  --record record.json \
  --to sent \
  --disclosed-to "Vendor Security Team" \
  --message "Initial notification" \
  --out record.json

# Record CVE assignment
0 disclose track finding-001 \
  --record record.json \
  --to cve_assigned \
  --cve-id CVE-2025-12345 \
  --out record.json
```

### Reproducibility manifest

The `review` subcommand requires verified findings with sufficient reproducibility
evidence; it fails rather than manufacturing missing proof. It renders a
redacted manifest and never sends or publishes anything. Supply `--timestamp`
when you need reproducible serialized output across invocations.

```bash
0 disclose review finding.json --target "lodash@4.17.21" --out manifest.json
```

## Orchestrate

`0 orchestrate` runs an autonomous work queue over a shared SQLite database.

**Source:** `packages/cli/src/commands/orchestrate.ts`

### Modes

| Mode | Flag | Description |
|------|------|-------------|
| Worker | `0 orchestrate --db-path ./scans.db` | Claim and execute one batch of runnable work items, then exit |
| Watcher | `0 orchestrate --db-path ./scans.db --watch` | Poll for new work items continuously |

`--limit` defaults to `1` claimed item per pass, and work in a pass executes
sequentially. `--watch --poll-interval 5000` polls continuously (minimum 1000 ms).
Use the database containing the queued cases; this command has no target or
queue-creation argument and an empty database produces no work. It is a
persisted case worker, not a crash-safe self-improvement campaign controller.

### Work item types

The orchestrator processes these work item kinds in order of priority:

| Kind | Priority | Description |
|------|----------|-------------|
| `surface_map` | 0 (highest) | Map the target surface |
| `hypothesis` | 1 | Generate attack hypotheses |
| `poc_build` | 2 | Build proof-of-concept |
| `blind_verify` | 3 | Blind verification |
| `consensus` | 4 | Consensus across findings |

A work item is runnable when its status is `todo`, its dependency is `done`,
and no sibling for the same case is `in_progress`.

### Stale worker recovery

Each pass calls `recoverStaleWorkers` automatically. Workers whose heartbeat is
older than 30 seconds can have in-progress items returned to `todo`; no manual
`require('./dist/...')` command is needed. Recovery permits another execution,
so do not treat it as exactly-once delivery of external effects. Stop an old
worker before intentionally replacing it; stable `--label` values identify
superseded workers.

### Target format

The orchestrator supports these target URL schemes:

| Format | Target type | Scan mode |
|--------|-------------|-----------|
| `https://example.com` | URL | `deep` (default) |
| `web:https://example.com` | Web app | `web` |
| `mcp://host/path` | MCP endpoint | `mcp` |
| `scan:<value>` | Strips the `scan:` prefix and treats the remaining value as a URL target | Stored mode, otherwise `deep` |

The `scan:` parser does not look up a prior scan ID. Execution resumes the
persisted scan associated with the queued case; it does not resolve an arbitrary
`scan:<id>` reference to that scan's target.

## Verification engine

`0 verify` exposes deterministic replay and kernel reproducer workflows.
The selected mode controls prerequisites, result shape, and exit-code meanings.

**Source:** `packages/cli/src/commands/verify.ts`

### Results, exit codes, and runners

Exit codes, results, and runners are mode-specific. Follow
[Scan Workflows](/scan-workflows/) for choosing the mode,
[Verification Results](/verification-result/) for deterministic replay statuses,
and [Kernel VM Verification](/kernel-vm/) for QEMU prerequisites.

Local, Docker, and kernel execution have distinct safety boundaries.
Use only the runner and fixture options registered by the selected command. An
SDK runner type is not automatically a CLI option.

## Report export

```bash
# SARIF for code scanning
0 review . --format sarif > results.sarif

# HTML report
0 scan --target http://127.0.0.1:8080 --scope ./scope.json --format html

# PDF report
0 scan --target http://127.0.0.1:8080 --scope ./scope.json --format pdf
```

### Report summary output

JSON, Markdown, and SARIF are emitted as formatted output. HTML and PDF reports
are written to timestamped files under the system temporary directory; the CLI
prints the generated path. `scan` has no `--report-path` flag.
Copy the emitted HTML/PDF file to your desired destination before temporary
files are cleaned up. Redirecting stdout does not relocate that report.

## See also

- [GitHub CI](/ci/github-action/) — running 0 in CI pipelines
- [Configuration](/configuration/) — runtime modes, scan modes, env vars
- [API Keys](/api-keys/) — provider setup
- [Scope & Authorization](/scope/) — scope JSON files and access control
- [Commands](/commands/) — full command reference