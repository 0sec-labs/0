# Extension architecture

Skills are instructions the model loads (no code). Extensions give 0 a connection or ability: connectors, MCP servers and rules. User-facing text says **extension**; code under `packages/engine/src/plugins/extensions/` keeps the folder name.

## Modules and dependencies

```
 CLI adapter  packages/cli/src/commands/skills-extensions.ts   (args in, text out; no decisions)
      |
      v
 composition  extensions/index.ts  createExtensionService({home})
      |
      +--> installer.ts   ExtensionInstaller   implements Installer  (prepare/commit/update/enable/disable/remove)
      +--> runtime.ts     loadable() / listRows()                      (what may run, fail closed)
      +--> verify.ts      readVerified()                               (tree hash must match the pin)
      +--> suggestions.ts readRepoSuggestions()                        (read-only; imports nothing else)
      +--> import/        LegacyImporter implements Importer
      |                     legacy-reader.ts (fs, read-only) -> plan.ts (pure) -> store
      |
      v
 ports.ts     ExtensionSource, SourceResolver, ExtensionStore, Installer, Importer, Clock
      ^                                  ^
      | implemented by                   | depends on
 adapters/                          core/   (pure: no fs, no git, no network)
   git-source.ts   GitSource          result.ts   typed Result and error codes
   local-source.ts LocalSource        files.ts    folder model, limits, git tree hash
   source-resolver.ts                 manifest.ts zod schemas, read order, parseManifest
   fs-store.ts     FsExtensionStore   capabilities.ts  what it can do, approval key, delta
   fs-folder.ts    read/write folders
   state-lock.ts   lock file for state.json   seal-key.ts per-install 0600 HMAC key
   approval-gate.ts (extensions/) who may grant an approval (CLI) diff.ts     folder diff
                                      prompt.ts   InstallPrompt data model + text
                                      env.ts      env allowlist for extension processes
                                      state.ts    state schema and pure transitions
                                      seal.ts     HMAC seals of approval records (pure)
                                      builtins.ts BUILTIN_EXTENSIONS registry array
```

Dependencies point inward: adapters and services depend on ports and core; core imports nothing
from the rest of the engine. The engine imports nothing from `cli` or `web`. The CLI
reaches the extension code only through the `@0/engine` barrel.

## Invariants

1. **Immutable, pinned installs.** An install is a revision folder `~/.0/extensions/<name>/<revision>/`.
   `<revision>` is a full commit SHA (git) or `local-<content hash>` (folder). A written folder is never
   modified; `putRevision` refuses to reuse a folder whose content hash differs.
2. **Content equals the pin.** The folder hash is git's tree object id. A fetch must hash to
   `<sha>^{tree}` (or `<sha>:<subpath>` for an `owner/repo/path` skill); every load re-hashes the folder against the
   stored hash and refuses on mismatch (`tampered`), for stored revisions AND folders adopted in place by the importer.
   A stored revision holding a top-level `.git` is tampered. Names that differ only by letter case or Unicode
   normalisation are refused at prepare time.
3. **Approval is bound to what was shown.** `commit` recomputes the tree hash, the capabilities and the name from
   `snapshot.files` and checks the approval names this prompt id, revision and capability digest (`approvalFor`).
   The capability key covers MCP transport, command, every arg, url, env names and header names (never values).
   A folder whose capabilities differ from the approval is refused (`capabilities_changed`).
4. **Never auto-update, never auto-enable from a repo.** Only `commit` after a prompt changes the active
   revision. `suggestions.ts` returns data and has no access to the installer or the store; `loadable`
   reads only `~/.0/extensions/state.json`.
5. **Env allow pattern.** Declared names must be UPPER_CASE ending in a credential or setting word
   (`_TOKEN`, `_KEY`, `_URL`, ...); PATH, PYTHONPATH, NODE_PATH, GIT_*, SHELLOPTS, LD_*, DYLD_*, BASH_ENV, ENV,
   NODE_OPTIONS and proxies are always rejected. Extension processes get a scrubbed base plus declared-and-approved
   names only; model provider keys only if declared, shown and approved.
6. **No in-process extension code.** Nothing here runs an extension. Scripts and MCP servers are commands
   for bash and the MCP client, under the existing approvals and sandbox.
7. **Old stores are read-only, imports never over-approve.** The importer reads old stores, never copies secret
   values (secret-looking url query keys, `user:pass@` and args such as `--token x` become `${NAME}` placeholders,
   declared as env names), imports skills that have scripts or env as installed, unapproved and disabled (plain
   SKILL.md text is enabled with no approved env), and `--force` adds nothing twice (stable import keys).
8. **One store for built-in enablement.** `state.json` `builtins`; `plugins/builtin.ts` is a view of
   `core/builtins.ts`, not a second registry.
9. **State changes are locked, audited first, ordered.** `update` holds `.state.lock` (stale after 30 s or a dead
   owner), appends the audit line BEFORE writing state and aborts if the append fails, and `remove` writes state
   before deleting folders.
10. **Sealed approvals.** Each approval-bearing record carries an HMAC (`state.json` `seals`) under a 0600
    per-install key (`.seal-key`). A record that is unsealed or does not match is treated as unapproved (extensions:
    approvals dropped, disabled, `sealBroken`, shown as needing approval) or as the default (built-ins).
11. **Approvals are the operator's.** Agent-started children carry `ZERO_AGENT_SESSION=1`; the store refuses every
    change when it is set, and the CLI's approval-bearing commands refuse when it is set (a flag alone never
    approves from an agent session). Without the marker, `--yes` approves with or without a terminal, so a person can
    install from CI or a script; a bare `add` at a terminal asks for confirmation. The Extensions page is the other approval path (browser-only, owner-only).
    `ZERO_AGENT_SESSION` is an internal marker (`shared/agent-session.ts`), set on every command the agent runs through
    bash, so approval commands can tell a thread from the operator. Users never see its name: the refusal is one
    sentence, "This command was run by a thread, not by you. Run it yourself in a terminal to approve." (`RUN_BY_THREAD_MESSAGE`).
12. **Git fetches are bounded.** The all-refs fallback fetch has a 60 s timeout and a 128 MB cap on what it writes;
    git alone receives `HTTPS_PROXY`/`NO_PROXY` from the parent environment.

## Residual risk (read this)

The agent runs as the same OS user and has bash. Layers 10 and 11 and the beforeCommand protected-paths decider make
self-approval require a deliberate, visible, multi-step attack and leave audit evidence, but none is a hard
boundary: the agent can read the seal key if text analysis misses a path, unset the marker, or write state through a
path it builds at run time. The seal protects against hand edits and tooling mistakes, not against an attacker with
the user's file permissions. The sandbox (and OS-level protection of `~/.0`) is the boundary; these are defence in
depth. Built-in enablement is global, not per project. Sealing resets approvals once for installs made before seals existed.

## Seams

| Seam | Implementations | Used by |
| --- | --- | --- |
| `ExtensionSource` / `SourceResolver` | git commit, local folder (built-ins are in the registry array) | installer |
| `ExtensionStore` | `FsExtensionStore`; tests may use any fake | installer, runtime, importer |
| `Installer` | `ExtensionInstaller` | CLI, Extensions page |
| `Importer` | `LegacyImporter` | CLI, startup |

Built-in extensions are rows in `core/builtins.ts`, the one registry. `state.json` keys: `extensions` (was `plugins`; read once and rewritten), `builtins`,
`seals`, `migrations`, `import`.
