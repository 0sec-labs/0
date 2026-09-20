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
Install **Bun 1.3.14** for the full terminal UI and standalone compilation;
Node supports the command-line workflows. Run the following from the monorepo
root. A Python environment is not required for the TypeScript harness.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The bundled CLI is `dist/0sec.js`:

```bash
node dist/0sec.js --version
node dist/0sec.js doctor
```

## Checks

Run the checks that cover your change before opening a pull request:

```bash
pnpm lint
pnpm build
pnpm test
```

`pnpm test` runs the public-source test selection (`test:public`), not every
optional engine, live-provider, VM, or install E2E. The separate `test:*:e2e`
scripts may need credentials, network access, or isolated execution; inspect
their prerequisites before running them.

For documentation changes, use `pnpm docs:check` and `pnpm build:docs`.
If CLI declarations changed, regenerate the command reference with
`pnpm docs:sync` and review the resulting diff.

Desktop source setup is documented in
[`docs/src/content/docs/desktop.md`](docs/src/content/docs/desktop.md).
The independent Python project in [`0verse/`](0verse/README.md) uses its own
`pyproject.toml`, `uv.lock`, and Makefile; root pnpm checks do not replace
its checks. Run its commands from `0verse/`, with Python 3.11+ and `uv`.

For test-target work, start the local fixtures in separate terminals:

```bash
pnpm vulnerable
pnpm safe
pnpm --filter @0sec/test-targets test
```

## Attack templates

Templates live in `packages/templates/attacks/`. Add only authorized,
non-sensitive examples. Mirror an existing YAML template: include a stable
`id`, `name`, category, severity, description, applicable `depth` values,
payload IDs/prompts, and detection rules. The `AttackTemplate` type lives in
`packages/shared/src/types.ts`.

The template package's `prebuild` regenerates `src/embedded.ts` from YAML.
Run `pnpm --filter @0sec/templates build` and include that generated update;
do not maintain a second hand-edited copy of a template in the embedded file.

## Pull requests

Describe the behavior changed, the tests run, and any scope or safety impact.
By submitting a contribution, you agree that it is licensed under MIT OR
Apache-2.0.
