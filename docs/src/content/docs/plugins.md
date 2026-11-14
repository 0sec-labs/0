---
title: Plugins
description: Install plugins from the hackstore registry, build your own, and let the agent write sandboxed ones.
---

A plugin adds something to the agent: usually a tool it can call, or a [skill](/skills/). Installed plugins run as local child processes after you approve them. Model-authored plugins run in a disposable sandbox. Read [Plugin security](/plugin-trust/) before enabling third-party code.

## Install and use a plugin

```sh
0 plugin browse
0 plugin search foxguard
0 plugin install foxguard.scanner
0 plugin info foxguard.scanner
0 plugin enable foxguard.scanner
0 plugin run foxguard.scanner foxguard_scan --yes path=/absolute/path/to/project
```

In the browser app, open **Plugins**. **Explore the marketplace** lists the registry, and **Add** offers **From marketplace**, **From GitHub repository** and **MCP server**. See [MCP](/mcp/) for MCP servers and service connections.

The registry is [hackstore](https://github.com/0sec-labs/hackstore), a community-curated index. `0 plugin browse`, `search` and `install` read its [`index.json`](https://raw.githubusercontent.com/0sec-labs/hackstore/main/index.json) over HTTPS. Set `ZERO_REGISTRY_URL` or pass `--registry URL` to use another index. An explicitly empty value disables fetching. Entries are marked `unverified`, because no signature verifier is configured. A listing or a review is not a signature.

| Command | What it does |
| --- | --- |
| `0 plugin list` | List installed plugins and each one's state for this project. |
| `0 plugin browse` | List everything in the registry. |
| `0 plugin search <query>` | Search the registry. |
| `0 plugin install <id>` | Fetch, validate and write the plugin. Runs nothing. |
| `0 plugin install <path> --local` | Install from a local directory, offline. |
| `0 plugin enable <id>` | Approve the plugin for this project. |
| `0 plugin disable <id>` | Revoke project approval. Files stay. |
| `0 plugin info <id>` | Show the manifest, capabilities and state. |
| `0 plugin run <id> [tool] [pairs...]` | Call a tool. Effectful tools need `--yes`. |
| `0 plugin init <name>` | Scaffold a plugin. |
| `0 plugin validate <path>` | Check a manifest. Runs no code. |
| `0 plugin submit <path> --out <dir>` | Prepare files for a registry pull request. |

### States

A plugin is **installed** (files on disk), **enabled** (your approval for the current project) and **loaded** (its process is running). Installing runs nothing. Enabling starts nothing. Loading happens on `plugin run` or when a chat that has the plugin starts.

Installed files live under `~/.0/plugins/<id>/`. Approvals live under `~/.0/plugin-enablement/`, keyed by the resolved project path. Changed capabilities need approval again. A version change with the same capabilities does not. Run `enable` from the project where you will use the plugin.

### Use a plugin in a chat

Enable the plugin in your project, then run `0` from that directory. Each chat pins the plugins approved when it started. Ask the agent for the tool name (`foxguard_scan`), not the registry ID (`foxguard.scanner`). After you install, enable, disable or replace a plugin, start a new chat. Disabling does not stop a chat that already loaded the code, so close old chats when revocation must take effect now. Direct `plugin run` checks the current approval each time.

With SmolVM execution, new chats copy approved plugins into private guest storage and load them inside the VM. The controller never runs their code. External programs a plugin calls must exist in the workbench image. The standard image includes FoxGuard.

### Update

There is no `plugin update` or `plugin uninstall`. Running `0 plugin install <id>` again writes whatever your registry now serves, over the existing copy. Read the code and `0 plugin info <id>` first. Approval covers capabilities, not exact source bytes. Local updates use `0 plugin install ./my-plugin --local`. Running chats keep the old tools.

The FoxGuard adapter needs the standalone `foxguard` executable on your machine. The registry does not install it. The adapter takes an absolute `path` and an optional `severity`, and bounds scans to 25 seconds and 8 MiB of scanner output. Results can omit findings to fit the plugin limit, so check `omittedFindings` and truncation. See the [adapter source](https://github.com/0sec-labs/hackstore/blob/main/extensions/foxguard/plugin.js).

## Build a plugin

A tool plugin is a manifest plus one self-contained JavaScript program. The sources are [`plugin-author.ts`](https://github.com/0sec-labs/0/blob/main/packages/cli/src/commands/plugin-author.ts), [`plugin.ts`](https://github.com/0sec-labs/0/blob/main/packages/cli/src/commands/plugin.ts) and [`loader.ts`](https://github.com/0sec-labs/0/blob/main/packages/engine/src/plugins/loader.ts).

### Create and validate

```sh
0 plugin init my-plugin
0 plugin validate ./my-plugin
```

The scaffold writes `manifest.json`, `plugin.js` and `README.md`, with a working `sha256` tool that hashes its `input` string. `--dir PATH` sets the parent directory. The name must be one directory component. A non-empty target is refused unless you pass `--force`, and symlinks are never overwritten.

`validate` takes a directory or a manifest file, and `--json` prints JSON. It runs no code and proves nothing about safety. A valid manifest can still fail to load: a missing entry point, an incompatible core version or a bad handshake. IDs such as `scope` and built-in tool names are reserved.

### Run locally

```sh
0 plugin install ./my-plugin --local
0 plugin info my-plugin
# Read ~/.0/plugins/my-plugin/plugin.js before approving it.
0 plugin enable my-plugin
0 plugin run my-plugin sha256 input=hello
```

The output is the SHA-256 of `hello` (`2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`). The host wraps tool output as untrusted data. It can neutralize instruction markers and truncate long results.

`--local` takes a directory or its manifest, validates it and needs a non-empty regular `plugin.js`. It works with the registry disabled. It copies only `plugin.js` and the validated manifest (as `plugin.json`). It installs no dependencies, runs nothing and approves nothing. Symlinks are refused and manifests are limited to 256 KiB, so bundle dependencies into the entry point and list prerequisites in the README.

Name the tool when you pass `key=value` pairs, or the first pair is read as the tool name. For structured arguments use `--json '{"input":"hello"}'`. Pairs override matching keys and are always strings, so use `--json` for numbers, booleans and objects. Effectful tools need `--yes`, but the plugin has already loaded by then.

To test in an isolated home, run the same commands with a temporary `HOME` and project directory. Also check a failure path, such as `0 plugin run my-plugin sha256 --json '{"input":3}'`, which should exit nonzero with `input must be a string`.

### Write the tool

Edit the manifest and `plugin.js` together. The child receives tool arguments only, not the scan scope, target authentication or engine APIs.

- Validate arguments yourself. A parameter schema alone does not.
- Keep stdout for protocol frames and write logs to stderr.
- Return errors as failed results. A failed scanner must not look like a clean scan.
- Bound subprocess output and time, and stop subprocesses when stdin closes.
- Do not return credentials or extra source. Arguments and results can reach model context and logs.

The loader starts `<pluginDir>/plugin.js` without a shell, using Node, or the embedded Bun in standalone builds, with the plugin directory as the working directory. If a tool scans user files, require an absolute path. Use Node built-ins or bundle your dependencies, and document external programs as prerequisites.

### Manifest

The [JSON schema](https://raw.githubusercontent.com/0sec-labs/hackstore/main/hackstore-manifest.schema.json) gives editor checks. The runtime validator in [`manifest.ts`](https://github.com/0sec-labs/0/blob/main/packages/engine/src/plugins/manifest.ts) is authoritative.

| Field | Contract |
| --- | --- |
| `id` | Required, up to 64 characters, matching `^[a-z][a-z0-9]*([._-][a-z0-9]+)*$`. Use an author namespace such as `acme.router`. |
| `name` | Required display name, up to 2,000 characters. |
| `version` | Required `MAJOR.MINOR.PATCH`, with an optional prerelease or build suffix. |
| `minCoreVersion` | Optional minimum core version. |
| `tools` | Required array of 1 to 64 tools. |
| `kind` | Optional. If set, must be `tool`. |
| `$schema` | Optional editor hint. |

Each tool has:

| Field | Contract |
| --- | --- |
| `name` | Required, up to 48 characters, matching `^[a-z][a-z0-9_]*$`. Unique, and not a built-in name. |
| `description` | Required, up to 2,000 characters. Shown to the model and to you. |
| `parameters` | Required map of parameter names to schema objects. Not a full JSON Schema document. |
| `required` | Optional array of required parameter names. |
| `capabilities` | Required non-empty array from the table below. Unknown values are rejected. |

### Capabilities

Declare what the tool does, including any program it launches.

| Capability | Behavior | Host flags |
| --- | --- | --- |
| `compute` | Computes a result. | Read-only |
| `model-call` | Calls a model. | Read-only |
| `network` | Makes network requests. | Network-capable, not read-only |
| `process-exec` | Starts a process. | Network-capable, not read-only |
| `filesystem-read` | Reads files. | Local scope, read-only |
| `filesystem-write` | Writes files. | Local scope, not read-only |
| `findings-write` | Changes findings state. | Not read-only |

Flags combine. A tool is read-only only if every capability is `compute`, `model-call` or `filesystem-read`. Chats use these flags in authorization checks, and scope checks come from the built-in `scope` plugin (`0 plugin enable scope`, see [Scope](/scope/)). Direct `plugin run` uses only enablement and `--yes`.

Declarations are not operating-system limits. The plugin runs as you with an allowlisted environment, and the host does not check that it obeys. Provider keys and target authentication are not passed to it, and `model-call` does not give it a provider. Never read credentials from the home directory.

### Wire protocol

Registry plugins speak newline-delimited JSON over stdin and stdout. Every frame has `v: 1`, and each request and response share a bounded `id`. See [`protocol.ts`](https://github.com/0sec-labs/0/blob/main/packages/engine/src/plugins/protocol.ts) for exact types. The child sends its handshake first, without waiting for input:

```js
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
process.stdout.write(JSON.stringify({
  v: 1, kind: "handshake", pluginId: manifest.id,
  version: manifest.version, manifest,
}) + "\n");
```

The host checks it against the installed manifest. The generated `plugin.js` has the full message loop.

```text
Host  -> Child: {v:1, kind:"list_tools", id}
Child -> Host:  {v:1, kind:"list_tools", id, tools:[...]}
Host  -> Child: {v:1, kind:"call_tool", id, tool, args:{...}}
Child -> Host:  {v:1, kind:"tool_result", id, ok:true, content:"...", truncated:false}
```

On failure, return `ok:false` with the reason in `content`. Set `truncated:true` when you cut a result, and keep shortened JSON valid. Other errors use `{v:1, kind:"error", id, code, message}`.

Host limits: 5 seconds for the handshake, 30 seconds per call (`plugin run --timeout MS` changes it), 16 in-flight calls, 1,048,576 characters per frame, 100,000 characters of result content. A plugin is marked unavailable after 32 protocol errors.

### Submit to the registry

```sh
0 plugin submit ./my-plugin --out ./my-plugin-submission
```

This validates the plugin and writes `extensions/<id>/` (manifest, `plugin.js`, README) under the new `--out` directory. The directory uses the manifest ID, which can differ from your folder name. It prints SHA-256 fingerprints, needs a non-empty README, and refuses to overwrite. It runs no code and uploads nothing.

Then follow the [contribution guide](https://github.com/0sec-labs/hackstore/blob/main/CONTRIBUTING.md):

1. Fork `0sec-labs/hackstore` and copy `extensions/<id>/` into it.
2. With Node.js 22 or newer, run `npm ci`, `npm run build`, `npm run check` and `npm test`. They regenerate and check `index.json`. Do not edit its inline JavaScript by hand.
3. Commit the plugin and the regenerated `index.json`, then open a pull request with tested versions, a successful and a failing call, your capability rationale, prerequisites and limits.

Registry checks do not run plugin code. Review is not a sandbox or a certification. The registry has no paid listings or payouts.

## Model-authored plugins

During a session the agent can submit TypeScript as an executable plugin with `self_extend`. It is on by default for non-verifier agents, and `allowModelSelfExtension: false` turns it off. There is no `0 plugin submit` for this path.

Each plugin has a manifest with tool names, descriptions, parameter property schemas and capabilities. These gate what the broker allows:

| Capability | Allows |
| --- | --- |
| `compute` | Guest-local computation and scratch files. |
| `model-call` | Calls to the configured provider through a controller-owned broker. |
| `network` | Authorized host network tools, within the parent's scope. |
| `filesystem-read`, `filesystem-write` | Authorized host file tools, within local scope. |
| `process-exec`, `findings-write` | The applicable host gates. Denied broker tools stay unavailable. |

The entry file exports `async run(toolName, args, sdk)`. The `sdk` has `callTool(name, args)`, `callSkill(name, args)` and `callModel({system?, messages, tools?})`. `callModel` needs `model-call`, takes a non-empty `messages` and no model, account or credential override.

The guest runs in Docker by default, with no network, a read-only root and bounded resources. It cannot call `bash`, `run_command`, `python_exec`, `spawn_agent`, `self_extend`, `apply_patch` or `write_file`. Nested calls share one broker budget and stop at depth 4. Node 24 strips erasable TypeScript syntax, so provision dependencies in the image.

Lifecycle, through `self_extend` with `action` set to `submit`, `list`, `evolve` or `rollback`:

1. **Submit** saves an immutable version, checks the source in a guest, and activates it.
2. **Replace** by submitting the same ID. Earlier versions are kept for rollback, up to 32. At 32, submission fails rather than evicting one.
3. **Rollback** reactivates an earlier version.
4. **Evolve** runs the improvement loop on the active version and creates a `measured` version on promotion. Direct submits are `structural`. A failed run increments `failureCount` and records `lastError`.

Start a session with a guest image:

```bash
docker build -f scripts/docker/Dockerfile --target toolbox -t 0-toolbox:local .
env ZERO_PLUGIN_BACKEND=docker ZERO_PLUGIN_IMAGE=0-toolbox:local 0 web
```

Enabling self-extension does not install Docker or pull an image. For measured evolution, point `ZERO_PLUGIN_EVOLUTION_CONFIG` at an operator-owned config and use its `default` profile. See [Self-improvement](/self-improvement/). Creating and replacing plugins works without it.

| Backend | Needs | Isolation |
| --- | --- | --- |
| `docker` (default) | Local Docker and a Node 24 toolbox image | No network, read-only root, all capabilities dropped, no-new-privileges, PID and resource limits. |
| `smolvm` | KVM, smolvm 1.14.6 and a Node 24 toolbox archive (`ZERO_SMOLVM_IMAGE_ARCHIVE`) | MicroVM with its own kernel, bounded resources, no guest network. |

The default image is `0-toolbox:local`, and `ZERO_PLUGIN_IMAGE` overrides it. The image is pinned to an immutable digest on first use, and resumed versions keep that digest. Every call starts a fresh guest. The controller and authorized host tools run outside the sandbox.

Versions live in `~/.0/executable-plugins/`, apart from `~/.0/plugins/`. Digests are checked on read and at admission and execution. These are local integrity checks, not registry signatures. The sources are [`executable-plugins.ts`](https://github.com/0sec-labs/0/blob/main/packages/engine/src/agent/executable-plugins.ts) and [`plugins/executable.ts`](https://github.com/0sec-labs/0/blob/main/packages/engine/src/plugins/executable.ts).
