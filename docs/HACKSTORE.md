# Authoring for Hackstore

**Hackstore** is the community extension store for the 0sec CLI. This guide is
for authors: it covers what an extension is, the exact manifest contract, the
capability model and the danger each capability gates, the trust model, and how
to author, validate, and submit an extension.

> Accuracy note: everything here matches the real code. The manifest contract is
> defined by `PluginManifest` / `PluginToolManifest` and `validatePluginManifest`
> in [`packages/core/src/plugins/manifest.ts`](../packages/core/src/plugins/manifest.ts).
> The machine-readable schema is
> [`packages/core/src/plugins/hackstore-manifest.schema.json`](../packages/core/src/plugins/hackstore-manifest.schema.json)
> (`$id`: <https://raw.githubusercontent.com/0sec-labs/hackstore/main/hackstore-manifest.schema.json>).

## What a Hackstore extension is

A Hackstore extension is:

1. **A plugin manifest** (`manifest.json`) declaring one or more *tools*. Each
   tool names itself, describes what it does, declares its parameters, and — the
   part that matters most — declares its **capabilities** from a closed set.
2. **Its source files** — the implementation behind the declared tools.

The manifest is the contract. It is validated by the exact same function the
loader uses (`validatePluginManifest`), so what passes `0sec hackstore validate`
is exactly what the store and the loader will accept.

Themes and config bundles are a different artifact kind and are **out of scope**
for this guide — this guide is about *tool* extensions.

## The manifest contract, field by field

### Top-level (`PluginManifest`)

| Field | Required | Rules |
| --- | --- | --- |
| `id` | yes | Namespaced identifier, e.g. `acme.sqli-pack`. Lowercase dotted/hyphenated (`^[a-z][a-z0-9]*([._-][a-z0-9]+)*$`), ≤ 64 chars. Never reaches the model prompt or a dispatch key, so it may carry `.` and `-`. |
| `name` | yes | Non-empty display string, ≤ 2000 chars. |
| `version` | yes | Semver-like `MAJOR.MINOR.PATCH`, with an optional `-prerelease` / `+build` tail (`1.0.0`, `1.2.3-rc.1`). |
| `minCoreVersion` | no | When present, semver-like. The minimum `@0sec/core` version your extension needs. |
| `tools` | yes | Array, **at least 1**, at most 64. Each entry is a tool manifest (below). |
| `$schema` | no | Optional pointer at the JSON Schema so your editor validates as you type. Ignored by the validator (unknown top-level keys are dropped, not carried). |

### Each tool (`PluginToolManifest`)

| Field | Required | Rules |
| --- | --- | --- |
| `name` | yes | Dispatch key + prompt-facing + UI-facing name. Charset-constrained (see below), ≤ 48 chars, unique within the manifest, and must not collide with a built-in tool. |
| `description` | yes | Non-empty, ≤ 2000 chars. Shown to the model and the operator. |
| `parameters` | yes | An object: a JSON-schema-ish **properties bag** (a map of parameter name → schema object or boolean). This is a properties bag, *not* a complete JSON Schema. |
| `required` | no | Array of parameter-name strings. |
| `capabilities` | yes | **Non-empty** array from the closed set below. There is intentionally no way to declare zero capabilities. |

### Tool-name charset

A tool name travels to three untrusting places: the model prompt (as the
callable tool name), the dispatch table + capability gate maps (as object keys),
and operator-facing UI. So the rules are strict:

- Pattern: **`^[a-z][a-z0-9_]*$`** — lowercase ASCII letters, digits, and
  underscore, and **not starting with a digit** (and not starting with an
  underscore).
- Length ≤ 48.
- `__proto__`, `prototype`, and `constructor` are additionally forbidden
  (prototype-pollution-style keys).
- Must not collide with a built-in tool name (plugins may not shadow built-ins).

## The capability model

Capabilities are **mandatory, non-empty, and fail-closed**. A tool that declared
nothing would look like the *least* dangerous class and bypass every gate — so an
empty or missing `capabilities` list is rejected, and an unknown capability
string is rejected loudly rather than silently ignored.

The set is **closed**. These are the only valid values:

| Capability | What it gates |
| --- | --- |
| `compute` | Pure in-process computation. No egress, no filesystem, no spawn, no state mutation. The least-privileged capability, and a pure read. |
| `model-call` | Calls a model. Treated as a pure read for gating purposes. |
| `network` | Performs engagement egress (HTTP, DNS, any socket). Maps to `NETWORK_CAPABLE_TOOLS` → **forces scope approval** (and is hard-denied under yolo). |
| `process-exec` | Spawns processes / runs commands. A spawned process can open any socket, so this **also implies network-capable** (and thus scope approval). |
| `filesystem-read` | Reads the local filesystem. Maps to `LOCAL_SCOPE_TOOLS` → the **local-filesystem scope gate**. A pure read. |
| `filesystem-write` | Writes/patches the local filesystem. Maps to `LOCAL_SCOPE_TOOLS` and is **never read-only**. |
| `findings-write` | Mutates the findings store (save/update a finding). A **state mutation**, so never read-only. |

How capabilities translate into gates is done in exactly one place
(`gateFlagsFor`), and it is conservative — anything uncertain resolves to the
*most* restrictive flag:

- **networkCapable** — true if `network` **or** `process-exec` is declared. Feeds
  scope-on-demand and the yolo hard-deny.
- **localScope** — true if `filesystem-read` **or** `filesystem-write` is
  declared. Feeds the local-filesystem scope gate.
- **readOnly** — true **only** when the set is non-empty **and every** declared
  capability is a pure read (`filesystem-read`, `compute`, `model-call`). Any of
  `network` / `process-exec` / `filesystem-write` / `findings-write` makes the
  tool not read-only. Read-only feeds the co-pilot approval exemption, so the
  rule is "all reads", not "any read".

Declare the **minimum** set that is true for your tool. Over-declaring makes your
extension look more dangerous (more approval prompts); under-declaring is
rejected at validation time, because the gates are keyed on what you declare.

## The trust model

The security story is three separated states (from
[`packages/cli/src/commands/plugin.ts`](../packages/cli/src/commands/plugin.ts)):

- **installed** — files on disk. `install` writes bytes; it runs **nothing**.
  There is no install script, no postinstall, no import of extension code.
- **enabled** — a per-project operator decision recorded by the enablement store.
  `enable` writes **one json record**; it spawns nothing.
- **running** — a tool is actually invoked. That happens **only in the loader, at
  scan time, and only for ids the enablement store reports as cleanly enabled**.

Nothing you ship runs merely by being installed or listed. Code executes only
after an operator explicitly enables your extension for a project, and only when
a scan actually invokes one of your tools — at which point the capabilities you
declared drive the authorization gates described above.

## Authoring locally

Scaffold a new extension:

```sh
0sec hackstore init my-ext
```

This creates `my-ext/` containing a minimal, valid `manifest.json` (with a
`$schema` pointer and one `compute` example tool), a `README.md`, and an example
tool source file. It refuses to write into a non-empty directory unless you pass
`--force`, and `--dir <path>` chooses the parent directory.

Edit `manifest.json` to declare your real tools and capabilities, and implement
them in your source files.

## Validating

```sh
0sec hackstore validate ./my-ext      # a directory containing manifest.json
0sec hackstore validate ./my-ext/manifest.json   # or the file directly
```

On success it prints `OK: <id>@<version>, N tool(s)`. On failure it prints the
full list of specific errors (one per problem, each naming the offending field)
and exits non-zero. Add `--json` for machine-readable output.

This runs your manifest through the same `validatePluginManifest` the loader
uses, so a clean validate here means the store and loader will accept it too.

Aliases: `0sec hack …` and `0sec store …` are the same command.

## Submitting to the community index

The community registry lives at **github.com/0sec-labs/hackstore**, and its
published index is
<https://raw.githubusercontent.com/0sec-labs/hackstore/main/index.json>.

To submit:

1. **Fork** `github.com/0sec-labs/hackstore`.
2. **Add your manifest entry** to `index.json`.
3. **Open a pull request.**

Before you submit, make sure `0sec hackstore validate` passes cleanly — a
manifest that does not validate will not be accepted.
