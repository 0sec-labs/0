# One extension system: plugins

> **Language decision 2026-11-16.** Skills are instructions the model loads (no code). Extensions are what gives 0 a connection or ability: connectors (GitHub, later Slack, Jira, PagerDuty), MCP servers and rules. An extension may come with a skill that explains how to use it; bundling skills into an extension is an optional companion, not the definition. The text below keeps its original wording.

Architecture of the store, installer and importer (step 2): [extension-architecture.md](./extension-architecture.md). Naming decision: user-facing text says "extension"; skills stay "skills".

Status: DESIGN ONLY, nothing implemented. Owner direction (Doruk): everything beyond
the tiny core is a plugin; connectors and MCP are plugins; one word; drop
registry signatures and harness trust.
Supersedes `plugins-one-concept.md` and the audit's "skills only" idea; keeps the
audit's finding that the skill install flow (pin by SHA, preview, click, no
auto-update) is already the right trust model. Core stays: loop, bash, file helpers,
findings, memory, Threads, Agents, plus one hook (section 3). All else is a plugin.

## 1. What the three trust mechanisms are today (plain English)

**Registry signature verification.** Proves a plugin entry listed by a registry
came from its publisher and was not altered. Code: `registry-client.ts:224-270`.
By default `unconfiguredVerifier` (`:231-235`) has no key, so entries are just
labelled "unverified" and allowed. A stub that refuses everything exists
(`createStubSignatureVerifier`, `:246-252`, `verify: () => false`), and a real
Ed25519 check exists (`:265-270`) but only turns on if an operator sets
`ZERO_REGISTRY_PUBLIC_KEY_FILE` (`:280`). No key is bundled and no registry
publishes signatures. Net: it protects nothing on a normal install.
Defends against: a malicious or compromised registry swapping a plugin. Simpler
cover: install from `repo@commit`; the commit SHA is already a content hash, and
the prompt shows the repo. Signatures only matter once a registry with real,
distinct publishers exists. Not today.

**Harness trust.** A per-folder yes/no stored in `harness-trust/grants.json`
(`harness-trust.ts:9-24`, written at `:26-43`), like VS Code's "Trust this
workspace?". It is read in `native-loop/run.ts:337` and `turn-engine/session.ts:269`
and gates one thing: a model-authored "live harness" whose provider source is
`kind: "trusted"` host ESM (`live-harness.ts:22,255`: "Explicit workspace trust
grant required for host ESM"). Granting it lets that code run with your privileges.
Defends against: a repo or the model making code run silently (the 2025-26
Cursor/Copilot/Claude Code CVE class: repo-controlled config executing on open).
Simpler cover: the install prompt (below) for anything that executes, and delete the
live harness with `self_extend`. Per-folder trust of arbitrary ESM is a second,
separate consent system for one feature.

**Per-tool approval hashes.** A sha256 per tool over name, description, parameters
and capabilities (`packages/cli/src/web/github-plugin-install.ts:24-27,83`),
compared with the hashes recorded at last install so the update review marks tools
Changed/New/Removed (0.31, 0.34). Today only GitHub-installed executable plugins
have it. MCP servers get a config fingerprint instead (command, args, env names,
URL; `plugin-trust.md`), which does NOT notice a server changing a tool description
at runtime.
Defends against: tool poisoning (hostile text in a description) and rug pull (a
tool the user approved is quietly changed). This one is worth keeping, but only for
MCP tools, the only place descriptions can change without a new commit (section 3).

**Simple mechanism that covers the rest.** One install prompt: `repo @ commit`, what
it can do (runs commands / connects to MCP servers / calls <service>), and a diff since the last approved version. Pin by SHA, re-prompt on any
change, no auto-update of third-party plugins, no registry signatures until a
registry with real publishers exists.

## 2. The one model

**A plugin is a folder, pinned by commit, that may bundle any of:** skills
(`SKILL.md` know-how), scripts (run only through bash), MCP server definitions, a
connector (auth + access to a service), a verifier.

**Manifest.** Reading order, first hit wins, so existing material works unchanged:
1. `.claude-plugin/plugin.json` (Claude Code layout: `name`, `version`,
   `description`, `skills/`, `.mcp.json`). 0 reads skills and MCP servers from it.
   Claude `hooks/`, `commands/`, `agents/` are not supported; the prompt says
   "ignored: hooks", never silently run.
2. `plugin.json` at the root, same fields, plus an optional `"0"` object for
   what Claude has no word for:
   `{"connector": {...}, "verify": "scripts/verify.sh",
   "requires": {"bins": ["gh"], "env": ["GITHUB_TOKEN"], "0": ">=0.36"}}`.
3. A bare `SKILL.md` folder (or `.agents/skills/x`): a plugin with one skill and a
   synthesized manifest. Nothing existing needs editing.
The old `plugin.json` + `plugin.js` executable format (guest protocol,
`protocol.ts`, `executable.ts`) is not read after migration (section 5).

**Sources.** (a) `git url@sha`, the existing skills flow; only the full SHA is stored. (b) local folder: linked, "unpinned, local", re-prompts when content hash changes. (c) built-in first-party bundles inside the binary (github, later slack/email-digest), updated with the binary, same manifest.

**On disk.** `~/.0/plugins/<name>/<sha>/` (immutable per SHA) and
`~/.0/plugins/state.json` (source, SHA, approved capabilities, enabled global or per
project). A repo's `.0/plugins.json` may list `repo@sha` it recommends; that is a
suggestion only, never an install (section 4). Approvals live in `~/.0`.

**Enable/disable.** Installed = on disk; enabled = active globally or per project. Disabling is free; enabling prompts once per SHA.

**What the user sees.** One page. Recommendation: rename sidebar **Skills** to
**Plugins**, tabs Installed | Browse, a filter Skills / MCP / Connectors, built-ins
badged "Built in". Skills become a view of what plugins contain: one noun. Rejected:
keep "Skills" plus a Plugins tab (two nouns). Explore is deleted (themes live in
Settings > Appearance), so the sidebar goes from seven to six items. The owner
decides the name; this doc changes no UI nouns.

**CLI.** Rename `0 skills add|list|remove|update|info` to `0 plugins ...`, keep
`0 skills` as a hidden alias with a `moved:` hint. The visible top-level count is
unchanged (the nine-command cap needs a separate cut; 0.33 says 14). `update` shows
the diff and asks; `info` prints the install prompt text.

## 3. How the four things map

**Hook point in the core: `beforeCommand`.** Called for every bash command, every
network target a core tool opens, and every file write outside the workspace.
Input: `{kind, command, argv, cwd, hosts[], paths[], thread}`. Output:
`allow | deny(reason) | ask(reason)`. Combination: any deny wins, then any ask,
else allow. The existing "Ask before running commands" setting
(`settings.ts:393`) and the sandbox choice become the lowest-priority policy on this
same hook, not separate code paths. A hook that throws or times out means deny.

Third-party hook plugins are out of scope for v1 (open question 3); only built-ins
register `beforeCommand`.

**Connectors as plugins.** A connector plugin declares `connector`:
`{service, auth: "token" | "oauth-device" | "cli", env, access: {read:[...],
write:[...]}, surface: "scripts/" | ".mcp.json"}`. Core keeps the secret store, the generic "Connect" card drawn from this declaration,
injection of the token only into the declared env var of that plugin's scripts or MCP
process, and the audit event. The plugin owns service logic, scripts or MCP server,
and its read/write list (shown at install, enforced via `beforeCommand` as declared
hosts only). Slack, email digest, Jira, PagerDuty are ordinary plugins.
GitHub: recommend a **first-party built-in plugin**, because pull request Agents
depend on it. It cannot be removed; disabling it pauses PR Agents with a clear
message. Device-flow and `gh` login logic (`web/github-auth.ts`, 170 lines) move
into the plugin's auth type; the PR poller and review rules stay core (they are the
Agent feature, not the connector).

**MCP: enabled, defined inside a plugin.** A plugin's `.mcp.json` declares servers;
standalone "add MCP server" in the UI becomes "install a plugin" (a local folder with
one `.mcp.json` is the one-click case). Schemas load on demand: the prompt carries
only server name plus one line; a `tool_search`/`load_tools` step pulls full schemas
when needed (progressive disclosure, no schemas in every prompt). Per-tool hash
(name, description, input schema) is pinned at approval for MCP tools only; a changed
hash disables that tool until re-approved (rug-pull defence). Tool output stays
untrusted data. stdio servers run through the same env allowlist and sandbox as bash.

**Skills and verifiers inside plugins.** `skills/*/SKILL.md` load as today (`load_skill`); built-in YAML methodology skills ship in a built-in `methodology` plugin. A verifier is a `verify` command whose exit code the verifier gate reads; it runs through bash under scope.

## 4. Security model (one page)

- **What a plugin can do:** anything bash can do, under the same budget,
  approvals and sandbox. There is no second permission system and no in-process
  plugin code. Its scripts and MCP servers are just commands.
- **Install prompt shows:** `repo @ full commit`, licence, file list, hidden-Unicode
  flags, and what it can do: runs commands (lists scripts), connects to MCP servers
  (command or URL, env names), calls a service (hosts, read/write list). The click echoes the SHA. Audit event `plugin.install` with SHA and
  capabilities.
- **Update:** `0 plugins update` fetches the new SHA, shows the folder diff plus a
  capability delta, and asks. Any change re-prompts, even one new script. No silent
  auto-update of third-party plugins.
- **First-party built-ins** update with the binary (the binary is the trust root); everything else never updates silently.
- **Env allowlist:** a plugin process gets a scrubbed env plus only names declared in
  `requires.env`/`connector.env` and approved at install. Provider keys (model API
  keys) are never passed unless declared and shown in the prompt. Loader variables
  (`LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS`) stay rejected.
- **Repo-controlled config is a suggestion:** a repo's `.0/` or `.claude/`
  (`settings.json`, `.mcp.json`, skills) must not install or enable a plugin or MCP
  server. On first open the app shows "This repo asks for plugins X, Y" with the
  install prompt each; ignored means nothing runs. Plain SKILL.md text is still read
  as instructions (no execution), as today.
- **Sandbox preference:** with a Computer/VM available, plugin scripts and MCP servers run there by default; "run on host" is a per-plugin choice shown in the prompt.
- **Not done:** signatures, publisher identity. A malicious approved plugin can do what bash can; the defence is the prompt, the pin and the sandbox.

## 5. Migration

One-time importer on first start of the new version, read-only on old stores, writes
`~/.0/plugins/state.json`, prints a report (also in the Plugins page), never deletes
old data.

| Today | Becomes |
| --- | --- |
| Installed GitHub plugins (`~/.0/plugins`) | Executable `plugin.js` format is not runnable. Imported as disabled entries listed "could not migrate: executable tools, re-express as scripts or MCP". Source SHA kept. |
| Model-authored plugins (`self_extend`, `~/.0/executable-plugins`) | Reported, files left in place. `self_extend` tool and `allowModelSelfExtension` removed; the model writes a skill or script folder (`create_skill`) and the user installs it as a local plugin. |
| Custom MCP servers | Each becomes a local plugin with one `.mcp.json`, imported as installed and enabled only for projects where it was enabled, marked "re-approve" (prompt on first use). |
| Service connections (GitHub, Slack, Elastic) | GitHub: built-in plugin, connection and token kept. Token-only ones (Slack, Linear, Cloudflare, Teams): imported as connector extensions needing approval, token not copied. The rest (URL or ids needed): reported only; stored credentials untouched. (Step 5, shipped.) |
| Skills (user, project, mounted, built-in, team) | Unchanged on disk; shown as plugins of kind skills-only; provenance and pinned SHA carried over. |

**Deleted code (LOC from the audit, tests included):**
- Registry signature verifier and `ZERO_REGISTRY_PUBLIC_KEY_FILE`: about 130 of
  `registry-client.ts`'s 735; the whole client (735 + 433 test) goes (question 4).
- Harness trust: `harness-trust.ts` 43, `live-harness.ts` 669 + 498 test, and the two
  call sites (`run.ts:337`, `session.ts:269`).
- Capability manifests: `capability-classification.ts` 92, `manifest.ts` 682 + 526
  test, schema 102; replaced by the prompt and a small manifest reader (~250 new).
- Executable runtime: `executable.ts` 594, `protocol.ts` 746, `guards.ts` 350,
  `loader.ts` 1,275, `self-extension.ts` 976 (plus tests).
- Service plugins 1,037, Explore 169, plugin web UI 675, old CLI plugin commands
  2,403, GitHub plugin install 473 (reworked into the generic installer).
- Total about 18k from `engine/plugins` plus about 5k CLI/web, against about 1.5k
  added (installer, manifest, hook, MCP pinning, importer). MCP client (2,420) and
  MCP server mode (3,406, owner decides) stay.

**Statements this reverses (`docs/CHANGELOG.md`):**
- 0.30: "Add Ed25519 verification of plugin registry entries when you set
  `ZERO_REGISTRY_PUBLIC_KEY_FILE`..." and "Refuse unsigned or badly signed plugin
  registry entries when an operator has configured a registry public key".
- 0.29: "Require approval of the exact reviewed configuration (a fingerprint that also
  binds env and header values through a per-install keyed MAC)": replaced by the
  install prompt and pin.
- 0.29: "Add Explore tabs" and custom MCP / GitHub plugins "pinned to a commit ... never auto-updated": pin and no-auto-update stay, executable plugins go.
- 0.31: "Updating a plugin installed from GitHub says which tools were added, removed or
  changed. Each tool has its own hash" and 0.34 "marks each tool as Changed, New or
  Removed": replaced by a folder diff; per-tool hash kept for MCP only.
- 0.32/0.33: Explore ("Explore keeps Plugins and Themes", brand logos) and the seven-item sidebar (becomes six).
- 0.33: "a single Plugin concept (MCP servers and tool plugins are kinds)": kept; "tool plugins" go.
- 0.35 (unreleased): `0 plugin` folded into `0 skills --plugin/--enable/--info`:
  rewrite before release; it becomes `0 plugins`.

**Explore:** deleted; Browse tab holds the curated catalog (pinned SHAs); old routes redirect to Plugins.

## 6. Build plan (six PRs, each revertible)

1. **`beforeCommand` hook + decider, fail closed (M).** Proof:
   hook throw denies; Ask-before-running uses the same hook. Ships first because it closes the known gap.
2. **Plugin store, manifest reader, git@sha installer, install prompt, diff, audit,
   importer report (L).** Reads the three manifest shapes; old skill installs import.
   Proof: install a Claude-layout plugin and a bare SKILL.md folder; update shows
   diff and re-prompts; repo `.0/plugins.json` and `.claude/` do not install
   (hostile test). Blocks 3, 4, 5, 6.
3. **UI and CLI: Plugins page, `0 plugins`, `0 skills` alias, redirects, Explore
   removed (M).** Proof: screenshots, CLI help snapshot, link checker. Needs 2.
4. **MCP inside plugins: lazy schemas, per-tool hash pin, env allowlist (M).** Proof:
   a server that changes a description is disabled until re-approved; prompt size
   test shows schemas absent until loaded; provider key not in server env. Needs 2.
5. **Connector contract + built-in `github` plugin (M).** Proof: PR Agents work on a
   fresh install through it; token only reaches declared env; disabling pauses PR
   Agents with a message. Needs 2 (and 4 if it ships MCP). Slack, email digest, Jira,
   PagerDuty follow as small PRs.
6. **Delete (L).** Executable runtime, `self_extend`, harness trust, registry
   signatures, service plugins, old plugin UI/CLI; CHANGELOG with the reversals above;
   rewrite `plugin-trust.md` as one page. Proof: typecheck, suites, importer test on a
   fixture home with old plugins/MCP. Needs 1-5 shipped for one release.

## 7. Open questions (recommendation each)

1. Plugins or Skills as the name? Recommend Plugins, `0 skills` hidden alias; owner decides.
2. Keep MCP server mode (`0 lab mcp-server`, 3.4k LOC)? Recommend keep, hidden; separate work.
3. May third-party plugins register `beforeCommand`? Recommend no in v1: built-ins only,
   so a plugin cannot loosen a decider.
4. Keep any registry? Recommend no: curated catalog of pinned SHAs; delete
   `registry-client.ts`; signatures return only with real publishers.
5. Support Claude `hooks/` and `commands/`? Recommend no in v1: ignore and say so in the
   prompt; hooks are the repo-controlled-execution risk.
