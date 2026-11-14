# Architecture

One page on how the repo is layered and how to keep it that way. The user-facing
vocabulary lives in the docs site ([Concepts](../src/content/docs/concepts.md),
published at `/concepts/`); the public overview is
[architecture.md](../src/content/docs/architecture.md).

## Packages

```
        packages/cli (@0/cli)          packages/web (@0/web)
        commands, terminal UI,         browser app (Vite + React)
        local server, bundle              |
           |            \                 |  built output only
           |             \                v
           |              +------ copied into cli as dashboard-assets.generated.ts
           |  (bench command)
           v
   packages/bench (@0/bench)    never shipped
        |
        v
   packages/engine (@0/engine)  <------- cli and web depend on this too
   scanner, agents, storage, shared types, templates
```

Allowed edges: `cli -> engine`, `cli -> bench` (the `bench` command only),
`web -> engine`, `bench -> engine`. Everything else is forbidden. The engine
depends on none of the other packages.

## Layering rules

Enforced by `pnpm check:architecture` (`scripts/check-architecture.mjs`, run in
`test:public` and in `.github/workflows/main.yml`):

1. `engine` imports nothing from `@0/cli`, `@0/web` or `@0/bench`.
2. `web` imports only `@0/engine` (never `@0/cli` or `@0/bench`).
3. `cli` never imports `@0/web` or anything in `packages/web/src`; it consumes
   only the built assets (`packages/cli/scripts/generate-dashboard-assets.mjs`).
4. `bench` is imported only by `cli`, and by repo-level `scripts/`.
5. Cross-package imports go through a package's `exports` map. The only deep
   entries are listed in `ALLOWED_DEEP` in the check script. Relative imports
   that reach into another package are rejected.
6. Top-level directories inside `packages/engine/src` must not form new import
   cycles. Existing cycles are recorded in `scripts/architecture-baseline.json`
   (a warning count only); a new or grown cycle fails. Refresh the baseline
   with `node scripts/check-architecture.mjs --update-baseline` only when a
   cycle is unavoidable, and never to hide a regression.

The checker reads `package.json` dependencies and every `import`, `export ...
from`, dynamic `import()` and `vi.mock()` string under `packages/*/src`,
`packages/*/test` and the top-level files of each package. Its own rules are
tested in `scripts/check-architecture.test.mjs`.

## Command tree

`packages/cli/src/commands/tree.ts` is the only place that decides where a
command lives (top level or nested under a noun group such as `scan`,
`findings`, `runs`, `research`, `improve`, `plugin`). Command modules export a
`registerXCommand(parent, name?)` function and never know their own path.
`packages/cli/src/index.ts` and `scripts/sync-cli-docs.mjs` both call
`registerCommandTree`, so the CLI and its generated reference cannot drift.

## Vocabulary

Scan, finding, automation, run, chat, plugin and engine are defined in
[Concepts](../src/content/docs/concepts.md). Use those terms in code, CLI help
and docs.

## Where tests live

- `packages/engine`: `src/**/*.test.ts` beside the code and `src/__tests__/`
  (vitest, `packages/engine/vitest.config.ts`).
- `packages/cli`: `src/**/*.test.{ts,tsx}`, `src/commands/__tests__/`, and the
  spawned-CLI end-to-end suite in `test/e2e/`.
- `packages/web`: `test/` (vitest, `packages/web/vitest.config.ts`).
- `packages/bench`: `src/**/*.test.ts`, root-level `*.test.ts` and `test/`
  (`pnpm --filter @0/bench test:targets`).
- Repo-level: `scripts/*.test.mjs` run with `node --test`; the browser and docs
  checks are the `test:*` scripts in the root `package.json`.

## Adding a command

1. Create `packages/cli/src/commands/<name>.ts` exporting
   `register<Name>Command(parent: Command, name?: string)`.
2. Import and register it in `packages/cli/src/commands/tree.ts`, in the group
   where it belongs (use `nest(...)` for a noun group).
3. Put the logic in `@0/engine` when the web app or another surface needs it;
   keep the command a thin adapter.
4. Add a test under `src/commands/__tests__/`, then run `pnpm docs:sync` so the
   CLI reference is regenerated, and `pnpm docs:check`.

## Adding a plugin kind

Plugins are validated by the engine and managed by the CLI.

1. Define the kind in the engine: executable kinds (`tool`, `skill`, `agent`)
   are declared in `packages/engine/src/plugins/executable.ts`; the manifest
   shape is `packages/engine/src/plugins/plugin-manifest.schema.json`.
2. Teach the CLI to install and list it: `packages/cli/src/state/plugin-service.ts`,
   the `plugin` command (`packages/cli/src/commands/plugin.ts`) and the authoring
   helpers (`packages/cli/src/commands/plugin-author.ts`).
3. If the browser surfaces it, update
   `packages/web/src/components/console-control/plugins-control.tsx`.
4. Document it in the [Plugins](../src/content/docs/plugins.md) page.
