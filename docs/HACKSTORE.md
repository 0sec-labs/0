# Build a Hackstore extension

An extension adds tools the 0sec agent can call. It consists of a manifest and a
self-contained Node.js program. This guide takes a generated extension through a
local run, then explains the runtime contract.

Use a source build containing the authoring and `plugin run` fixes. The tested
0.16.3 binary fails in `plugin run` because it treats the built-in tool registry
as an array. Older releases may also lack `hackstore init`. Check
`0sec --version` and command-specific `--help`; these instructions follow source.

## Create and validate

```sh
0sec hackstore init my-extension
0sec hackstore validate ./my-extension
```

The scaffold creates:

```text
my-extension/
  manifest.json
  plugin.js
  README.md
```

The generated `sha256` tool hashes its `input` string. It is a working protocol
program, ready to replace with your own tool. `init --dir PATH` selects the parent
directory. Existing non-empty directories are refused unless you pass `--force`.

`validate` accepts a directory or a manifest file. It checks the manifest using
`validatePluginManifest`; `--json` prints the result as JSON. It does not execute
code, inspect dependencies, or prove that a plugin is safe. A valid manifest can
still fail installation or loading because its entry point is missing, its core
version is incompatible, or its handshake is invalid.

## Run locally

The installer writes two files: `plugin.js` and the validated manifest as
`plugin.json`. It does not copy other files or install dependencies. The generated
program reads `plugin.json` beside its entry point.

For local development, copy those two files into a temporary home. This bypasses
registry fetching, not the loader or approval checks. Run from the directory
containing `my-extension`:

```sh
(
  set -eu
  umask 077
  source_dir="$(pwd)/my-extension"
  cli="$(command -v 0sec)"
  test_root="$(mktemp -d)"
  trap 'rm -rf "$test_root"' EXIT
  export HOME="$test_root/home"
  plugin_dir="$HOME/.0sec/plugins/my-extension"
  mkdir -p "$plugin_dir" "$test_root/project"
  cp "$source_dir/manifest.json" "$plugin_dir/plugin.json"
  cp "$source_dir/plugin.js" "$plugin_dir/plugin.js"
  cd "$test_root/project"
  "$cli" plugin enable my-extension
  "$cli" plugin run my-extension sha256 input=hello
)
```

The result contains the SHA-256 digest of `hello`:

```text
2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

The host wraps tool output as untrusted data. It may also neutralize instruction
markers and truncate long results before returning them to the model.

Name the tool explicitly when passing `key=value` arguments. Otherwise the first
pair is parsed as the optional tool name. For structured arguments use
`--json '{"input":"hello"}'`. Pairs override matching keys in `--json`.

Tools classified as effectful require `--yes` for a direct CLI call. The plugin
has already been loaded by that point; declining the call does not mean no plugin
code has executed. Only enable code you trust.

## Implement your tool

Edit the manifest and `plugin.js` together. Keep tool names, arguments, and
capabilities consistent. The child receives tool arguments, not the scan's scope
object, authentication configuration, or access to the engine's internal APIs.

- Validate arguments in the implementation. A parameter schema alone does not
  validate them for you.
- Keep stdout for protocol frames. Write diagnostics to stderr.
- Return errors as failed tool results. A failed scanner must not look like a
  successful scan with no findings.
- Bound subprocess output and execution time. Stop subprocesses when the host
  closes stdin or terminates the plugin.
- Do not return credentials or unnecessary source content. Tool arguments and
  results can appear in model context and logs.

The loader starts `node <pluginDir>/plugin.js` without a shell, with its working
directory set to the installed plugin directory. If a tool scans a user's files,
require an absolute path rather than assuming `.` means the user's project.
Use Node built-ins or bundle JavaScript dependencies into the entry point.
Document external executables such as `foxguard` as prerequisites.

## Manifest reference

The [JSON schema](https://raw.githubusercontent.com/0sec-labs/hackstore/main/hackstore-manifest.schema.json)
provides editor checks. The runtime validator in
[`manifest.ts`](../packages/core/src/plugins/manifest.ts) is authoritative.

| Field | Contract |
| --- | --- |
| `id` | Required. At most 64 characters; matches `^[a-z][a-z0-9]*([._-][a-z0-9]+)*$`. Use an author namespace such as `acme.router`. |
| `name` | Required non-empty display name, at most 2,000 characters. |
| `version` | Required `MAJOR.MINOR.PATCH`, optionally followed by a prerelease or build suffix accepted by the validator. |
| `minCoreVersion` | Optional minimum core version. Set it only when you know which runtime version the extension needs. |
| `tools` | Required array of 1–64 tool definitions. |
| `$schema` | Optional editor hint, discarded by the runtime validator. |
| `kind` | Optional. If supplied, must be `tool`. |

Each tool declares:

| Field | Contract |
| --- | --- |
| `name` | Required, at most 48 characters; matches `^[a-z][a-z0-9_]*$`. Must be unique and not collide with a built-in tool or a forbidden prototype-related name. |
| `description` | Required non-empty description, at most 2,000 characters. Shown to the model and operator. |
| `parameters` | Required map of parameter names to schema objects or booleans, not a complete JSON Schema document. |
| `required` | Optional array naming required parameters. |
| `capabilities` | Required non-empty array from the set below. Unknown capabilities are rejected. |

## Capabilities and approval

Declare what the tool actually does, including any program it launches.

| Capability | Behavior | Derived host flags |
| --- | --- | --- |
| `compute` | Computes a result. | Read-only |
| `model-call` | Calls a model. | Read-only |
| `network` | Makes network requests. | Network-capable, not read-only |
| `process-exec` | Starts a process. | Network-capable, not read-only |
| `filesystem-read` | Reads files. | Local scope, read-only |
| `filesystem-write` | Writes files. | Local scope, not read-only |
| `findings-write` | Changes findings state. | Not read-only |

For combined capabilities, flags are combined: `network` or `process-exec` makes
a tool network-capable; either filesystem capability requires local scope; a
tool is read-only only if all capabilities are `compute`, `model-call`, or
`filesystem-read`. Scan workflows use these flags in their authorization checks.
Direct `plugin run` uses the separate `--yes` check described above.

Declarations are not operating-system restrictions. The plugin runs under your
user account with an allowlisted environment. It can still access resources your
account can access. The host does not verify that code obeys its declarations,
and a child process is not a security sandbox. A capability does not provide a
credential, a paid model allowance, or an internal API handle.

## Wire protocol

See [`protocol.ts`](../packages/core/src/plugins/protocol.ts) for exact message
types and validation. Registry plugins use newline-delimited JSON over stdin and
stdout. Every frame has `v: 1`. Each request and response shares a printable,
bounded correlation `id`.

The child sends its handshake immediately, before waiting for input:

```js
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
process.stdout.write(JSON.stringify({
  v: 1, kind: "handshake", pluginId: manifest.id,
  version: manifest.version, manifest,
}) + "\n");
```

The host checks the handshake against the installed manifest after spawning the
child. There is no startup configuration line to wait for and no one-shot mode
that skips the handshake. The generated `plugin.js` provides the full message
loop. These are the request and response shapes:

```text
Host  → Child: {v:1, kind:"list_tools", id}
Child → Host:  {v:1, kind:"list_tools", id, tools:[...]}
Host  → Child: {v:1, kind:"call_tool", id, tool, args:{...}}
Child → Host:  {v:1, kind:"tool_result", id, ok:true, content:"...", truncated:false}
```

On failure, return `ok:false` with the reason in `content`. Set `truncated:true`
when you omit part of a result. Keep structured results valid JSON when shortening
them. Out-of-band errors use `{v:1, kind:"error", id, code, message}`; `id` can be
null for a plugin-level error.

Default host limits are a 5-second handshake timeout, a 30-second call timeout,
16 in-flight calls per plugin, 1,048,576 characters per frame, and 100,000
characters of result content. The host marks a plugin unavailable after more than 32
protocol errors. `plugin run --timeout MS` changes its call timeout. These are
host-side bounds, not a substitute for limiting work inside the plugin.

Other protocol types support separate host-brokered workflows. Their presence in
`protocol.ts` does not grant registry plugins access to host tools or credentials.

## Installation and updates

```sh
0sec plugin browse
0sec plugin search foxguard
0sec plugin install foxguard.scanner
0sec plugin info foxguard.scanner
0sec plugin enable foxguard.scanner
0sec plugin run foxguard.scanner foxguard_scan --yes path=/absolute/path/to/project
0sec plugin disable foxguard.scanner
```

Installation writes files without running code. Enablement records approval for
the current project without starting the plugin. Loading during a scan or a
direct run starts the child. Disabling removes project approval but keeps files.

Installed files live under `~/.0sec/plugins/<id>/`. Project approval records live
under `~/.0sec/plugin-enablement/`, keyed by the resolved project path. A changed
aggregate capability set requires renewed approval. Version-only changes with
the same capabilities do not by themselves invalidate that approval.

The default registry is
<https://raw.githubusercontent.com/0sec-labs/hackstore/main/index.json>.
`0SEC_REGISTRY_URL`, or `--registry URL` on browse/search/install, overrides it.
The fetcher requires HTTPS; an explicit empty registry setting disables fetching.
The default signature verifier is unconfigured and entries are marked
`unverified`. Do not treat an index entry or a review as a verified signature.

## Publish

Follow the [Hackstore contribution instructions](https://github.com/0sec-labs/hackstore/blob/main/CONTRIBUTING.md).
In that separate repository, add `extensions/<name>/` with your manifest,
`plugin.js`, and README, then run `npm run build` to regenerate `index.json`.
Include evidence of a successful call and a failure through the real loader.
Registry packaging checks do not execute plugin code.

Hackstore does not currently implement paid listings, creator balances, or payouts.
