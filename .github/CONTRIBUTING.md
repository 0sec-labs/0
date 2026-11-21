# Contributing to 0

Thanks for helping improve 0.

## Before you start

- Work from a branch and keep each pull request focused.
- Use only synthetic fixtures or targets you own or are explicitly authorized to
  test.
- Do not submit customer data, credentials, raw target traces, embargoed
  vulnerabilities, or undisclosed exploit material.
- Discuss broad changes in an issue before writing a large patch.

## Setup

Use **Node.js 24+** and the repository-pinned **pnpm 9.15.9**.
Install **Bun 1.3.14** for standalone compilation; Node runs the CLI and browser console. Run the following from the monorepo
root. A Python environment is not required for the TypeScript harness.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The bundled CLI is `dist/0.js`:

```bash
node dist/0.js --version
node dist/0.js doctor
```

## Live development

Run `pnpm dev` from the source checkout. It builds the local dependencies,
starts TypeScript watchers and Vite, and prints the checkout and browser URL.
Frontend edits use HMR; backend edits restart the server and may interrupt active
requests or workers. This does not preserve in-flight work across server restarts.

Use `pnpm dev --port 48141 --frontend-port 5175` for fixed ports, or `0`
for either port to request a free one. `ZERO_DEV_PORT` and
`ZERO_DEV_FRONTEND_PORT` provide the same defaults. Occupied default ports select
free alternatives; an explicitly occupied port fails without attaching to or
stopping another server. Ctrl+C stops only this runner's processes.

## Checks

Run the checks that cover your change before opening a pull request:

```bash
pnpm lint
pnpm check:architecture   # package layering; see docs/design/architecture.md
pnpm build
pnpm test
```

`pnpm test` runs the public-source test selection (`test:public`), not every
optional engine, live-provider, VM, or install E2E. The separate `test:*:e2e`
scripts may need credentials, network access, or isolated execution; inspect
their prerequisites before running them.

### Fast checks

`pnpm test:changed` runs only what your diff reaches: typecheck of touched
packages and their dependants, `vitest related`, the `scripts/*.test.mjs` files
whose static imports include a changed file, plus docs and release-notes checks
when those paths changed. `--dry-run` prints the plan, `--base <ref>` overrides
the merge base, `--all` runs everything. Root `package.json`, lockfile,
`tsconfig*`, vitest/playwright configs and CI files always fall back to the full
suite. It is not a gate: CI and `scripts/ci-local.sh` run everything on main.
`pnpm hooks:install` (opt-in) adds a pre-push hook that runs it.

For documentation changes, use `pnpm docs:check` and `pnpm build:docs`.
If CLI declarations changed, regenerate the command reference with
`pnpm docs:sync` and review the resulting diff.

Desktop is a development-only alpha, excluded from normal CLI builds and releases.
Its explicit source setup is documented in
[`docs/src/content/docs/desktop.md`](../docs/src/content/docs/desktop.md).
The independent Python project in [`0verse/`](../0verse/README.md) uses its own
`pyproject.toml`, `uv.lock`, and Makefile; root pnpm checks do not replace
its checks. Run its commands from `0verse/`, with Python 3.11+ and `uv`.

## Main runs may be superseded

A newer push to `main` cancels the still-running `Main` of the previous commit, so an older main commit can show "cancelled" instead of a verdict.
The newest commit contains the older one, so its green run covers both. Images are published only for releases (a green `Main` on the `vX.Y.Z` tag) and as a nightly `:edge` of the newest green main commit; a cancelled run publishes nothing.

CI is path-aware to save runner minutes: `Main` builds the CLI once and shares it with every job; Windows storage, the Docker server and replay smokes, the GitHub Action contracts, the docs site build and the npm advisory audit are jobs of `Main` that run only for the paths they cover (and always on a release tag), the Release dry run runs for release-related paths and nightly, and a docs-only diff skips the test groups of `Main` (static checks still run). Third-party actions are pinned by commit SHA; Dependabot keeps the pins current. `scripts/check-workflow-triggers.mjs` guards these triggers.
Releases are gated on the release commit's own green `Main` and Release dry run (see below).

## Cutting a release

1. Bump `version` in `packages/cli/package.json`.
2. Move the `[Unreleased]` entries in `docs/CHANGELOG.md` into a `## [x.y.z] - date` section (Added/Changed/Fixed/Security).
3. Add the matching entry to `packages/web/src/lib/releases.ts` (once it exists) for the in-app What's new.
4. Run `node scripts/bump-docs-pins.mjs x.y.z` so the docs pins (image tags, the Action `version:`, the compose example) match the release; `pnpm docs:check` and `pnpm check:release-notes` fail when one lags.
5. `pnpm check:release-notes` must pass; preview with `node scripts/release-notes.mjs`.
6. Tag `vx.y.z`. The Release workflow publishes the binaries and uses the generated notes.
7. Release only a commit whose own `Main` run is green and whose Release dry run passed. A green neighbour does not count, because `Main` runs for superseded commits are cancelled. `Main` always runs every group on a code commit and on the `vX.Y.Z` tag itself; the Release dry run triggers on release-related paths and nightly, so for a release commit that touches none of them run it by hand (`Release` workflow, `dry_run: true`) before tagging.
8. After the tag, `Main` re-runs on it; its success publishes `:X.Y.Z`, `:X.Y` and `:latest` (highest version only), and the nightly Release run re-checks the documented install paths (binary, source, container). The `Release` workflow itself publishes nothing until its `main-gate` job sees a green `Main` run for the tag on the tag commit.

## Pull requests

Describe the behavior changed, the tests run, and any safety impact.
By submitting a contribution, you agree that it is licensed under MIT OR
Apache-2.0.


