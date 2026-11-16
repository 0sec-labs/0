# Extension architecture (step 2 of the build plan)

Implements the store, manifest reader, installer, install prompt and importer from
`one-extension-system.md`. The owner naming decision applies: user-facing text says
**extension**; code under `packages/engine/src/plugins/extensions/` keeps the folder name.

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
   fs-folder.ts    read/write folders diff.ts     folder diff
                                      prompt.ts   InstallPrompt data model + text
                                      env.ts      env allowlist for extension processes
                                      state.ts    state schema and pure transitions
                                      builtins.ts BUILTIN_EXTENSIONS registry array
```

Dependencies point inward: adapters and services depend on ports and core; core imports nothing
from the rest of the engine. The engine imports nothing from `cli`, `web` or `bench`. The CLI
reaches the extension code only through the `@0/engine` barrel.

## Invariants

1. **Immutable, pinned installs.** An install is a revision folder `~/.0/extensions/<name>/<revision>/`.
   `<revision>` is a full commit SHA (git) or `local-<content hash>` (folder). A written folder is never
   modified; `putRevision` refuses to reuse a folder whose content hash differs.
2. **Content equals the pin.** The folder hash is git's tree object id. A fetch must hash to
   `<sha>^{tree}`; every load re-hashes the folder against the stored hash and refuses on mismatch
   (`tampered`). Folders adopted in place by the importer carry provenance only.
3. **Approval is bound to capabilities.** The approval records the exact capability set; a folder whose
   capabilities differ from it is refused (`capabilities_changed`). `enable` of an unapproved revision needs
   explicit approval. Commit needs the caller to echo the revision it was shown.
4. **Never auto-update, never auto-enable from a repo.** Only `commit` after a prompt changes the active
   revision. `suggestions.ts` returns data and has no access to the installer or the store; `loadable`
   reads only `~/.0/extensions/state.json`.
5. **Env allowlist.** Extension processes get a scrubbed base plus declared-and-approved names only.
   Model provider keys are never passed unless declared, shown in the prompt and approved. Loader variables
   are never passed.
6. **No in-process extension code.** Nothing here runs an extension. Scripts and MCP servers are commands
   for bash and the MCP client, under the existing scope, approvals and sandbox.
7. **Old stores are read-only.** The importer reads old plugin, MCP, skill and connector stores, writes only
   the new state and its own revision folders, never copies secret values, and is idempotent.

## Seams

| Seam | Implementations | Used by |
| --- | --- | --- |
| `ExtensionSource` / `SourceResolver` | git commit, local folder (built-ins are in the registry array) | installer |
| `ExtensionStore` | `FsExtensionStore`; tests may use any fake | installer, runtime, importer |
| `Installer` | `ExtensionInstaller` | CLI now, Extensions page (step 3) |
| `Importer` | `LegacyImporter` | CLI, startup |

Built-in extensions are rows in `core/builtins.ts`. Step 1 registers the real `scope` there; step 5
replaces the `github` placeholder.
