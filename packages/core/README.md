<p align="center">
  <img src="https://raw.githubusercontent.com/0sec-labs/.github/main/profile/assets/icons/code.png" alt="" height="32">
</p>

# @0/core

The engine behind the [0 CLI](../../README.md): agent loops, tools,
model runtimes, source review, verification and self-extension. The CLI package
is named `@0/cli`; it registers the `0` and `0` commands.

<p>
  <a href="https://docs.0.security/architecture/"><img src="https://img.shields.io/badge/docs-architecture-DC2626?style=flat-square&amp;labelColor=1A1815" alt="Architecture documentation"></a>
  <a href="https://docs.0.security/improvement-plane/"><img src="https://img.shields.io/badge/evolution-research%20preview-1A1815?style=flat-square&amp;labelColor=1A1815" alt="Self-evolution: Research Preview"></a>
</p>

## Source organization

| Area | Source |
| --- | --- |
| <img height="14" src="https://raw.githubusercontent.com/0sec-labs/.github/main/profile/assets/icons/zap.png" alt=""> Agent execution | `src/agent/`, `src/console/`, `src/runtime/` |
| <img height="14" src="https://raw.githubusercontent.com/0sec-labs/.github/main/profile/assets/icons/code.png" alt=""> Scanning and review | `src/stages/`, `src/review/`, `src/triage/` |
| <img height="14" src="https://raw.githubusercontent.com/0sec-labs/.github/main/profile/assets/icons/verified.png" alt=""> Evidence and verification | `src/verify/`, `src/bench/` |
| <img height="14" src="https://raw.githubusercontent.com/0sec-labs/.github/main/profile/assets/icons/beaker.png" alt=""> Plugins and self-extension | `src/plugins/` |
| Scope and coordination | `src/scope/`, `src/events/`, `src/hub/` |

The package is ESM. Its build generates the skill manifest, compiles TypeScript
and copies runtime assets into `dist/`. The main entry point is `src/index.ts`;
internal modules are not automatically part of that exported API.

## Package role versus CLI

Selected exports from `src/index.ts`:

| Entry point | Purpose |
| --- | --- |
| `scan`, `agenticScan` | Target scanning |
| `sourceReview` | Source review |
| `packageAudit` | Package auditing |
| `createRuntime` | Runtime construction |
| `loadScope`, `matchUrl`, `ScopePolicy` | Scope ingestion and matching |
| `runAnalysisAgent` | Agent execution |

Use the [CLI quickstart](https://docs.0.security/getting-started/) to run an
assessment. For programmatic integration, follow the exported TypeScript types
and [architecture guide](https://docs.0.security/architecture/).

## Feature flags

Feature flags are declared in `src/agent/features.ts`. Each flag maps to a
`ZERO_FEATURE_<NAME>` environment variable. The `@0/cli` `scan` command
also accepts a `--features` flag that sets those env vars automatically:

```bash
0 scan --target https://app.example.test --scope ./scope.json --features web_search
env ZERO_FEATURE_POV_GATE=0 \
  0 scan --target https://app.example.test --scope ./scope.json --features fp-moat
```

Use the exact environment-variable suffix from `src/agent/features.ts`, not a
guessed camelCase property name. The current feature properties are getters:
they re-read the environment when accessed. Explicit `0` or `false` disables a
flag; an unset flag uses its declared default (or a recognized preset).
Enabling a flag does not bypass tool availability, scope, engagement policy or
workflow-specific prerequisites.

Named presets (e.g. `fp-moat`) are defined in `src/agent/feature-presets.ts`.
Applying a preset never overwrites a flag already set in the environment.

Jev advisory evaluation uses a **separate** opt-in configuration:
`ZERO_JEV_FEATURES=browser,memory,dedupe,redteam`, with a selected provider and
credential. Browser assistance only navigates operator-approved read-only URLs;
memory ranking supplies untrusted review context; duplicate assessment adds
cluster mappings without erasing evidence; red-team feedback never decides a
break. See the [feature guide](https://docs.0.security/features/#advisory-evaluations)
for data egress, request/cost limits and which callers wire these capabilities.

## Playbooks

Playbooks live in `src/agent/playbooks.ts`. Each playbook is a string keyed by
vulnerability type (`sqli`, `ssti`, `idor`, `xss`, `cve_exploitation`, …) plus
a set of regex `INDICATORS` that pattern-match against recent tool-result text.
When `ZERO_FEATURE_DYNAMIC_PLAYBOOKS=1`, the native agent loop matches
indicators from about 30% of the turn budget onward and injects matching
playbooks. It tracks injected content and can re-inject after compaction;
this is not a mandatory one-shot phase of every loop.

<details>
<summary>Tool-specific developer reference</summary>

## WordPress fingerprinter (`wp_fingerprint`)

The `wp_fingerprint` tool is enabled by default where the workflow exposes it.
Disable with `ZERO_FEATURE_WP_FINGERPRINT=0`. Implemented in
`src/agent/wp-fingerprint.ts`; availability is not permission to probe a target.

### What it does

1. **Detects WordPress** by fetching `wp-login.php`, `wp-admin/`, `readme.html`,
   `wp-includes/version.php`, `feed/`, and `wp-json/`. Extracts the core
   version from exposed `wp-includes/version.php` source, `readme.html`, or
   the RSS feed's `<generator>` tag. An ordinary PHP response need not expose
   the version; missing markers remain unknown.
2. **Enumerates plugins** from parallel sources:
   - Rendered HTML on `/`, `/?p=1`, `/?page_id=1` (any `/wp-content/plugins/<slug>/…` URL in asset tags)
   - `/wp-json/` namespace index and `/wp-json/wp/v2/posts` rendered content
   - `/wp-content/plugins/` Apache/nginx autoindex listings
3. **Proactively probes high-value vulnerable plugin slugs** from the local
   catalog, WPScan-style, by checking `/wp-content/plugins/<slug>/readme.txt`
   even when the plugin is not linked in rendered HTML.
4. **Enumerates themes** the same way.
5. **Probes versions** by fetching each plugin's `readme.txt` (parsing the
   `Stable tag:` header) and each theme's `style.css` (parsing the `Version:`
   header). These metadata hints can be absent or stale and are not proof of
   the deployed vulnerable code path.
6. **Matches CVEs** using a built-in high-impact WordPress plugin vulnerability
   catalog, queries the no-key WPVulnerability API for current plugin/theme
   advisories, optionally queries WPScan's API when `WPSCAN_API_TOKEN` (or
   `ZERO_WPSCAN_API_TOKEN`) is set, then optionally POSTs each `(slug, version)`
   pair to `https://api.osv.dev/v1/query` for broader OSV coverage.
7. **Returns structured findings** — entries with `kind`, `slug`, `version`,
   `cves` and `exploitHints`, plus a human-readable summary in the tool wrapper.

Advisory matches are investigation leads, not independently reproduced exploits.
The target fetch path and advisory-service fetch path are separate; inspect
egress policy before enabling live advisory lookups.
`skip_osv` skips OSV only; WPVulnerability and an enabled WPScan lookup can
still make external requests.

### CLI usage

```bash
0 scan \
  --target https://wordpress-target.example.test \
  --scope ./scope.json
```

### Tool invocation (from the agent)

```json
{
  "name": "wp_fingerprint",
  "arguments": {
    "max_plugin_probes": 40,
    "max_vulnerable_plugin_probes": 40,
    "wpscan_api_token": "<optional>",
    "skip_osv": false
  }
}
```

<a id="sample-output-structured"></a>

### Return structure

The tool returns `{ summary: string, result: { isWordPress, evidence, coreVersion, plugins, themes, findings } }`.
Each finding contains the slug, detected version, matched CVEs with severity
and advisory URL, and exploit hints the agent can act on.

### Tests

```bash
pnpm --filter @0/core test -- wp-fingerprint
```

The test suite (`src/agent/wp-fingerprint.test.ts`) mocks `fetch` with an
in-memory route table and exercises: plugin slug extraction, `readme.txt`
version parsing, `style.css` version parsing, the full end-to-end
`runWpFingerprint` with `skipOsv: true`, and the negative case where no WP
endpoints respond. Tests never hit the network.

## Anti-honeypot flag-shape validator (`decoyDetection`)

Some CTF/benchmark targets plant a **decoy flag** as a honeypot — a fake
`FLAG{...}` string sitting in an obvious location (the first file a naive
LFI exploit will land on, the `.git/config` a lazy credential hunt will
open, etc.). A naive agent reads the decoy, sees a flag-shaped literal,
calls `done`, and silently fails. XBEN-079 (Poison Inclusion - Protected)
is the canonical example: the decoy is `FLAG{I'm_a_Script_Kiddie}`, the
real flag is `FLAG{7dda4e738d29a996f343a610}`.

The `decoyDetection` feature (default **ON**) scores every proposed flag's
*shape* before the `done` tool accepts it. Implementation:
`packages/core/src/agent/flag-validator.ts`.

Scoring rules (highest match wins, length penalties apply after):

| Inner content                          | Confidence |
| -------------------------------------- | ---------- |
| UUID4                                  | 0.95       |
| UUID / sha256 / hex ≥ 16 chars         | 0.9        |
| Hex 8–15 chars                         | 0.75       |
| Base64-ish alnum ≥ 16 chars            | 0.7        |
| Mixed alnum/`_`/`-` ≥ 12 chars         | 0.6        |
| Single token, no strong shape signal   | 0.45       |
| Multi-word sentence (spaces or prose)  | 0.2        |
| Alphabetic word chain joined by `_`    | 0.25       |
| Contains `DECOY`/`FAKE`/`HONEYPOT`/etc | 0.05       |
| Length < 8 or > 100                    | clamp 0.3  |
| No `FLAG{...}` wrapper                 | 0.1        |

When confidence is below 0.5, the `done` tool rejects the call **once**
with a hint that the flag looks like a decoy and the agent should keep
exploring. A **second** call with the same flag passes through — the
heuristic is a speed bump, not a hard wall, so an agent that legitimately
only found one candidate can still submit it.

The attack-role system prompt also gets a one-line warning: *"If you find
a flag-shaped string, do not immediately call `done`. Verify the shape
matches the suite's expected format (typically hex/uuid). Defenders
sometimes plant decoy flags in obvious locations to catch script kiddies."*

### Configuration

- Env var: `ZERO_FEATURE_DECOY_DETECTION=0` to disable.
- CLI flag: `0 scan --no-decoy-detection <target>`.

### Tests

```bash
pnpm --filter @0/core test -- flag-validator
```

The test suite (`src/agent/flag-validator.test.ts`) covers the XBEN-079
decoy, UUID / sha256 / hex / short-hex good flags, sentence-style and
word-chain decoys, `DECOY`/`FAKE`/`HONEYPOT` markers, edge cases (empty,
no wrapper, too short, too long, expected-shape mismatch), and the full
`done`-tool integration path including the retry-to-override flow.

</details>

## Agent runtimes

The package provides multiple LLM runtime backends in `src/runtime/`:

- **LlmApiRuntime** — direct API requests and native tool-use loops.
- **ProcessRuntime** — subprocess adapters for Claude, Codex and Gemini CLIs.
- **OpenRouterRuntime** — the separate OpenRouter adapter and ensemble support.
- **OllamaRuntime** — local inference through Ollama.
- **CliNativeRuntime** — CLI-native session execution.

`createRuntime(config)` constructs the API, process or Ollama runtime from
`config.type`. Other exported adapters have their own constructors.
`pickRuntimeForStage` and `detectAvailableRuntimes` are registry helpers.
Provider metadata does not establish credentials or account access.

## Verification

`src/verify/` contains deterministic replay runners (local, Docker and QEMU),
kernel replay, patch validation, reproduction bundles and minimization. Each
workflow has its own prerequisites. Local shell replay is host execution, not an
OS sandbox.

Use the canonical `VerificationResultSchema` from `@0/shared` for ordinary
replay JSON: `reproduced`, `not_reproduced`, `skipped`, or `error`, with declared
assertions and hashed artifact descriptors. Kernel and bundle outputs have
separate contracts. A source finding, model consensus or a saved candidate is
not automatically runtime proof.

The agentic scanner's native verifier gives each candidate a five-turn session
with the original evidence and analysis excerpts. The structured four-step
verifier is a tool-free assessment used for opt-in consensus; it does not execute
a PoC. `stages/runtime-verify.ts` remains an E2B skeleton behind an injectable
hunt gate, not a provisioned runtime verifier.

See [blind verification](https://docs.0.security/blind-verification/) and
[replay results](https://docs.0.security/verification-result/) for contracts and
limits.

## Plugin system

`src/plugins/` contains manifest validation, discovery, protocol handling,
versioned executable plugins, self-extension and the live harness host.

- `ExecutablePluginManager` retains executable source versions for guest
  invocations.
- `LiveHarnessHost` manages live generations and their host-held state.
- Workspace-trusted ESM execution requires a separate trust grant.

Sandboxed phases run as separate guest invocations; they do not imply a
persistent warm guest. Live providers and state do not automatically reconstruct
after a process restart. These are Research Preview mechanisms; follow the
[improvement-plane guide](https://docs.0.security/improvement-plane/) for current
activation, evaluation and recovery limits.

## Development

From the repository root:

```bash
pnpm --filter '@0/core...' build
pnpm --filter @0/core test
pnpm --filter @0/core test -- wp-fingerprint
pnpm --filter @0/core dev
```

Build assets live in `scripts/`: `generate-skills-manifest.mjs` compiles the
skills directory into a TypeScript manifest, `copy-build-assets.mjs` copies
non-compiled assets into `dist/`.