---
title: Build a Hackstore extension
description: Create, test, and publish tools for the 0 agent.
---

A Hackstore extension adds tools the 0 agent can call. It consists of a manifest
and a self-contained JavaScript program using Node-compatible APIs. This guide
takes a generated extension through a local run, then explains the runtime
contract.

This is the **operator-installed, local child-process** plugin path, not the
model's sandboxed TypeScript `self_extend` path. Hackstore tools do not receive
the executable-plugin `sdk.callTool` / `sdk.callModel` broker, cannot register
authorization hooks, and are not automatically evaluated for improvement.
For model-authored tools and their separate version store, see
[Integrations](/integrations/#model-authored-executable-plugins-self-extension).

Check `0 --version` and command-specific `--help` before following this guide.
The local workflow below requires `plugin install --local` and
`hackstore prepare-submission`; update 0 if your installed version lacks them.

The implementation references for this guide are
[`hackstore.ts`](https://github.com/0sec-labs/0/blob/main/packages/cli/src/commands/hackstore.ts)
(scaffolding/validation/submission preparation),
[`plugin.ts`](https://github.com/0sec-labs/0/blob/main/packages/cli/src/commands/plugin.ts)
(installation/approval/direct calls), and
[`loader.ts`](https://github.com/0sec-labs/0/blob/main/packages/core/src/plugins/loader.ts)
(spawn/handshake/dispatch). Check the help for your installed release rather
than assuming an SDK method has a matching CLI command.

## Create and validate

```sh
0 hackstore init my-extension
0 hackstore validate ./my-extension
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
directory. Names must be a single directory component. Existing non-empty
directories are refused unless you pass `--force`; symlinks are never overwritten.

`validate` accepts a directory or a manifest file. It checks the manifest using
`validatePluginManifest`; `--json` prints the result as JSON. It does not execute
code, inspect dependencies, or prove that a plugin is safe. A valid manifest can
still fail installation or loading because its entry point is missing, its core
version is incompatible, or its handshake is invalid. Built-in plugin IDs such as
`scope` and built-in tool names cannot be used by external extensions.

## Run locally

Install directly from source without fetching a registry:

```sh
0 plugin install ./my-extension --local
0 plugin info my-extension
# Inspect ~/.0/plugins/my-extension/plugin.js before approving it.
0 plugin enable my-extension
0 plugin run my-extension sha256 input=hello
```

`--local` accepts a directory or its manifest file, validates the manifest against
the host contract, and checks for a non-empty regular `plugin.js`. It works even
when the registry is disabled. It copies **only** `plugin.js` and the validated
manifest as `plugin.json`; it does not copy other files, install dependencies,
run code, or automatically approve a new installation. Source and destination
symlinks are refused. Manifests are limited to 256 KiB; the serialized inline
registry entry must fit the 4 MiB index limit. Bundle dependencies into the entry
point and keep prerequisites in the README.

The generated program reads `plugin.json` beside its entry point. Enablement
records approval for the current project, so enable it from the directory where
you will use it. Loading executes the source under your account, not in a sandbox.
For an isolated installation and approval store, run from the directory containing
`my-extension`:

```sh
(
  set -eu
  source_dir="$(pwd)/my-extension"
  cli="$(command -v 0)"
  test_root="$(mktemp -d)"
  trap 'rm -rf "$test_root"' EXIT
  export HOME="$test_root/home"
  mkdir -p "$test_root/project"
  cd "$test_root/project"
  "$cli" plugin install "$source_dir" --local
  "$cli" plugin info my-extension
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
Pairs are always strings (`count=3` yields `"3"`); use `--json` for numbers,
booleans, arrays or nested objects.

Tools classified as effectful require `--yes` for a direct CLI call. The plugin
has already been loaded by that point; declining the call does not mean no plugin
code has executed. Only enable code you trust.

After the successful call, exercise a real failure too:

```sh
0 plugin run my-extension sha256 --json '{"input":3}'
```

Run this inside the temporary-home block above, before its closing `)`, if you
want to keep the installation isolated. It should exit nonzero with `input must
be a string` from the plugin. The block's `set -e` then exits and runs its cleanup
trap. When replacing the scaffold, also test a failing external dependency
through the real loader; manifest validation alone cannot catch those failures.

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

The loader starts `<pluginDir>/plugin.js` without a shell, using the current
runtime: Node for Node installations, or the embedded Bun interpreter for
standalone builds. Standalone plugins do not require Node or Bun on `PATH`.
The working directory is the installed plugin directory. If a tool scans a user's
files, require an absolute path rather than assuming `.` means the user's project.
Use Node built-ins or bundle JavaScript dependencies into the entry point.
Document external executables such as `foxguard` as prerequisites.

## Manifest reference

The [JSON schema](https://raw.githubusercontent.com/0sec-labs/hackstore/main/hackstore-manifest.schema.json)
provides editor checks. The runtime validator in
[`manifest.ts`](https://github.com/0sec-labs/0/blob/main/packages/core/src/plugins/manifest.ts) is authoritative.

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
`filesystem-read`. Console sessions with a supplied plugin host use these flags
in their authorization checks. All scope checks are controlled by the built-in
`scope` plugin: `0 plugin enable scope` activates them for the project, and
`0 plugin disable scope` disables them for new sessions. Credential protection,
sandboxing, and resource limits remain independent. Direct `plugin run` uses only
the separate enablement and `--yes` checks described above; it has no scope-file
argument.

Declarations are not operating-system restrictions. The plugin runs under your
user account with an allowlisted environment. It can still access resources your
account can access. The host does not verify that code obeys its declarations,
and a child process is not a security sandbox. A capability does not provide a
credential, a paid model allowance, or an internal API handle.

Provider keys and the target-auth environment block are not forwarded by the
loader. A `model-call` declaration does not make a provider available, and
`findings-write` does not grant direct access to the scan database. If you need
authorized host services rather than a standalone local process, use the
separate self-extension broker contract. Never design a registry plugin around
reading credentials from the operator's home directory.

## Wire protocol

See [`protocol.ts`](https://github.com/0sec-labs/0/blob/main/packages/core/src/plugins/protocol.ts) for exact message
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
0 plugin browse
0 plugin search foxguard
0 plugin install foxguard.scanner
0 plugin info foxguard.scanner
0 plugin enable foxguard.scanner
0 plugin run foxguard.scanner foxguard_scan --yes path=/absolute/path/to/project
0 plugin disable foxguard.scanner
```

Installation writes files without running code. Enablement records approval for
the current project without starting the plugin. Direct `plugin run`, or loading
an approved plugin for an OpenTUI chat, starts the child. Disabling removes
project approval but keeps files.

Installed external files live under `~/.0/plugins/<id>/`; the built-in `scope`
plugin has no installed files or child process. Project approval records live
under `~/.0/plugin-enablement/`, keyed by the resolved project path. A changed
aggregate capability set requires renewed approval. Version-only changes with
the same capabilities do not by themselves invalidate that approval.

### Use an installed tool in a chat

Enable it from the project where you intend to use it, then start `0 tui` from
that directory. The OpenTUI loads approved marketplace tools into a host pinned
to each chat. Ask the agent for the declared tool (`foxguard_scan`, for example),
not the registry ID (`foxguard.scanner`).

If you install, enable, disable, or replace a plugin while the TUI is open,
refresh through the marketplace and start a new chat. Existing chats keep their
leased host until cleanup; disablement does not retroactively kill that running
code. Close the old chats when revocation must take effect immediately. This
host ownership is implemented in
[`session-plugin-host.ts`](https://github.com/0sec-labs/0/blob/main/packages/cli/src/tui/session-plugin-host.ts).
Other CLI workflows do not automatically acquire this TUI host.

### Update deliberately

There is no separate `plugin update` or `plugin uninstall` subcommand. Running
`0 plugin install <id>` again writes the entry currently supplied by your
configured registry, including over an existing installation. Inspect the code
and `0 plugin info <id>` before using it. Same-capability updates do not require
renewed approval, so capability approval is not approval of exact source bytes.
Local updates use `0 plugin install ./my-extension --local` with the same approval
rules. Installation reports whether existing project approval still applies or
needs renewal; it does not silently revoke or broaden that approval.
An already-running chat is not updated merely because files on disk changed.

For the published FoxGuard adapter, install the standalone `foxguard` executable
first. Hackstore does not install it for you. The adapter requires an absolute
path, accepts an optional `severity`, and bounds scans to 25 seconds and 8 MiB
of scanner stdout. Its results can omit findings to fit the plugin result limit;
inspect `omittedFindings` and truncation rather than assuming a complete report.
Larger paths should be scanned in smaller parts or with the standalone scanner.
See the [adapter source](https://github.com/0sec-labs/hackstore/blob/main/extensions/foxguard/plugin.js)
and the [current registry](https://raw.githubusercontent.com/0sec-labs/hackstore/main/index.json)
for the version you are installing.

The default registry is
<https://raw.githubusercontent.com/0sec-labs/hackstore/main/index.json>.
`ZERO_REGISTRY_URL`, or `--registry URL` on browse/search/install, overrides it.
The fetcher requires HTTPS; an explicit empty registry setting disables fetching.
The default signature verifier is unconfigured and entries are marked
`unverified`. Do not treat an index entry or a review as a verified signature.

## Prepare and submit

After exercising successful and failing calls through the real loader:

```sh
0 hackstore prepare-submission ./my-extension --out ./my-extension-submission
```

This validates the same local installation contract and creates:

```text
my-extension-submission/
  extensions/
    my-extension/
      manifest.json
      plugin.js
      README.md
```

The extension directory uses the validated manifest's **ID**, which may differ
from the source directory name. The command preserves the entry point and README,
normalizes the manifest, and prints SHA-256 fingerprints. Identical source yields
identical file bytes. The README must exist and be non-empty; review it for actual
prerequisites, arguments, results, capability rationale, and limits. No other source
files or secrets are copied. `--out` must name a new path: preparation refuses to
overwrite an existing submission.

**This is a local review artifact, not a publication.** No code is executed,
credentials are read, or files are uploaded by preparation.

Follow the [Hackstore contribution instructions](https://github.com/0sec-labs/hackstore/blob/main/CONTRIBUTING.md):

1. Fork and clone `github.com/0sec-labs/hackstore`.
2. Copy the prepared `extensions/<id>/` into that fork. Review every file.
3. With Node.js 22 or newer, run `npm ci`, `npm run build`, `npm run check`, and
   `npm test` in the registry checkout. These commands regenerate and check
   `index.json`; do not hand-edit its inline JavaScript.
4. Commit the extension directory and regenerated `index.json`, then open a pull
   request. Include tested 0/dependency versions, commands and results for a
   successful call and a real failure, capability rationale, prerequisites, and
   known limits.

Registry packaging checks do not execute plugin code. Review is not a sandbox,
signature verification, or security certification. Hackstore does not currently
implement paid listings, creator balances, or payouts.
