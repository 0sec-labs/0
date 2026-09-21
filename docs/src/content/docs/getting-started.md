---
title: CLI Getting Started
description: Install 0, configure a provider, define scope, and run your first authorized CLI scan.
---

0 is the free, open-source security research CLI. Install it, connect a model,
and work on a repository or target you're authorized to test. Model access and
execution infrastructure are separate from the local engine.

This guide uses `0` as the CLI command. Repository and package paths,
release asset names, `~/.0` state paths, and `ZERO_*` environment variables
retain their existing technical names.

| Path | What you need | Where the work runs |
| --- | --- | --- |
| Local CLI with your model access | A supported [API key or provider subscription](#use-my-own-api-key) | Tools run on your configured executor; your provider handles inference and billing. No 0cloud account is required. |
| Local CLI with hosted inference | A compatible [0cloud account and service](#hosted-models), CLI, and model access | The service handles model requests; tools still run on your configured executor. |
| Managed security work | Agreed scope, permissions, budget and service access | A separately scoped service. See [managed onboarding](#managed-work-and-onboarding). |

## Install

Choose the standalone release for the full terminal UI, the npm package for
Node-based commands, a source checkout for development, or the container for a
separate execution environment. Documentation follows the source checkout:
compare `0 --version` and command-specific `--help` with your installed release.

### Release binary

The installer supports Linux x64/arm64 and macOS Apple Silicon. It requires
`curl` and `sha256sum` or `shasum`, verifies the downloaded checksums, and installs
the `0` alias and its release binary under `~/.0/bin`. It also installs the pinned
FoxGuard companion used by default for static analysis.

```bash
# Verified release binary (macOS Apple Silicon / Linux x64/arm64)
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0sec/main/install.sh | bash
export PATH="$HOME/.0/bin:$PATH"
0 --help
```

Add the `export` line to your shell profile for future shells. Inspect
[install.sh](https://github.com/0sec-labs/0sec/blob/main/install.sh) before running
it if your environment requires script review. `INSTALL_DIR` changes the install
location; `INSTALL_FOXGUARD=0` skips the companion on a pre-provisioned host.

To install a specific release, set `RELEASE_BASE_URL` on the shell running the
installer to `https://github.com/0sec-labs/0sec/releases/download/<tag>`.
Use the checksums from that same release. The installer does not modify your
shell profile, and checksum verification is not a signature or code audit.

Windows release builds are experimental. Download the Windows asset from
[GitHub Releases](https://github.com/0sec-labs/0sec/releases/latest);
`install.sh` supports Linux and macOS only. See
[Windows installation](/troubleshooting/#install-on-windows).
On Windows, invoke the downloaded executable by its actual filename; the
Unix `0` symlink is not installed there.

### npm package

With Node.js 24 or newer:

```bash
npm install -g 0sec-cli
0 --help
```

The published package installs both command names, but Node execution does not
provide the Bun TUI. Use the standalone binary for interactive onboarding.


### Build from source

Use Node.js 24 or newer and pnpm 9 or newer. The repository pins pnpm through
`packageManager`. The full terminal UI needs Bun; Node can run non-interactive
commands. See [Console](/console/) for that runtime distinction.

```bash
git clone https://github.com/0sec-labs/0sec.git
cd 0sec
corepack enable
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.js --help
```
Source builds do not install a global `0` command. Use the built entry point
shown above; for interactive source work, run `bun packages/cli/dist/index.js`.

The bundled Node entry point is also available as `node dist/0sec.js`.
Native dependency installation may need a compiler toolchain on platforms
without prebuilt addons. The native release workflow uses its own pinned Bun
compiler; `pnpm build` alone does not produce a standalone executable.


### Container

Docker must be installed and running. The image is a separate execution
environment; pass only the credentials and mounts needed for the task.

```bash
docker run --rm ghcr.io/0sec-labs/0sec:latest --help
```
For a real scan, mount scope and persist any output you need before using
`--rm`; files left only inside the container disappear when it exits.
The image runs the Node bundle as the non-root `ubuntu` user (UID 1000), with
`/work` as its working directory. It does **not** provide the Bun TUI. Mount
source read-only unless the task requires writes, and use a separate writable
mount for the database, journal and reports.


## Configure a provider

Run `0` to open chat, then `/connect`. Choose **0cloud → Sign in**,
**Use my own API key**, or **Provider subscription**. Cloud sign-in opens
your browser; **Esc** returns to chat. Source-based terminal UI execution
requires Bun; the release binary includes its runtime.

On the first no-argument launch, guided setup covers connection, model,
display preferences and analytics consent. Confirm the final **Done** step to
finish setup. Cancelling retains saved choices but leaves setup incomplete.

Use `/model` to select a model. Model and role-model selections apply to the
current audit while idle, or after its current turn completes. If a provider
isn't connected, connect it and select the model again. A normal `/connect`
choice alone prepares the next chat rather than switching a healthy runtime.
A saved Cloud login still needs service access, an available model and an
account eligible to make requests.

<a id="hosted-models-draft"></a>

### Hosted models

:::caution[Confirm account and service compatibility]
This source audit is not an authenticated production acceptance test.
Use the compatible CLI and service approved for your account. A public
sign-in page, browser login, or listed model does not establish that billing
and inference are ready.
:::

0cloud model access and managed security work have separate setup and
authorization. Choosing hosted inference does not move the CLI's shell tools
off your machine.

1. Set `HOSTED_TEST_HOST` to the operator-provided URL. Log in below, choose
   your organization, and authorize the CLI.
2. Check the model catalog and credit account. Review any reported eligibility,
   subscription windows, prepaid consent and admission state. These fields are
   deployment responses, not a promise of free credit. If account data is
   unavailable, resolve CLI/service compatibility first.
3. Choose an ID from `0 models`. Pin `hosted` to use it instead of any
   existing provider key or Codex login.

```bash
0 login --host "$HOSTED_TEST_HOST"
0 models --json
0 balance --json

env ZERO_SELECTED_PROVIDER=hosted ZERO_MODEL="<model-id-from-catalog>" \
  0 review ./authorized-repo --runtime api
```

Replace the model ID and repository path. Reading the catalog or account does
not start an inference request. The review does; account admission and billing
depend on the approved deployment. Login does not claim or purchase credits.

See [account states and errors](/api-keys/#hosted-inference) and
[hosted settings](/configuration/#hosted-configuration).

### Use my own API key

Your provider handles authentication and billing. Local, BYOK and supported
provider-subscription workflows need no 0cloud account.

Set one provider key:

```bash
export ANTHROPIC_API_KEY="your-api-key"
```

See [API Keys](/api-keys/) for other providers, Azure and ChatGPT Codex sign-in.
With multiple credentials, select a matching `--model` or `ZERO_MODEL`.
Keep model keys separate from target credentials (`--auth`).
Never commit keys or paste them into issues.

For supported subscription sign-in, use `/connect` and choose the provider's
subscription entry. This is separate from buying hosted model access through
0cloud. Provider account restrictions and model availability still apply.

### Use multiple models deliberately

Start with one connected provider route that can serve the models you want.
For example, a gateway such as OpenRouter can expose models from multiple
vendors through one account. In `/model`, use **Ctrl+Left / Ctrl+Right** to target
the parent or a worker role, select the desired model, and press **Enter**.
**Ctrl+Backspace** removes that role's override so it inherits the parent.
**Ctrl+S** toggles single-model mode; when enabled it takes precedence over role
choices.

Workers inherit the parent's provider, credentials and endpoint: a role choice
does not automatically switch accounts to another configured provider. See
[multi-model role routing](/configuration/#multi-model-role-routing) for a
concrete configuration and precedence, and [Console](/console/#model-picker)
for live changes. These controls are exposed in the TUI and embedding API,
not as a general CLI role-map flag or environment variable. A role override
chooses a model when that role runs; it does not guarantee every workflow
spawns that role or verifies every finding.

### Start with a local repository

For an initial authorized source review without a live network target:

```bash
0 review ./authorized-repo --runtime api --depth quick --cost-ceiling 2
```

For interactive work with approval prompts, launch the standalone binary or
Bun TUI explicitly in Standard mode:

```bash
0 console --mode standard
```

Then describe the repository path and objective. The default no-argument console
mode is **YOLO**, not Standard. Node/readline and `--print` have no interactive
approval surface; see [approval limitations](/console/#non-interactive-approval-limitations).

## Run your first scan

Every live network target needs a scope file. The CLI refuses an unscoped live
target before it makes a request.

See [Scope & Authorization](/scope/) for exact host, wildcard, CIDR, and exclusion
matching. Scope is a target boundary, not a network sandbox.

```bash
printf '%s\n' '{"in_scope":["app.example.com"]}' > scope.json

0 scan --target https://app.example.com --mode web \
  --scope ./scope.json --runtime api --depth quick --cost-ceiling 2
```

Replace `app.example.com` with a target you own or have explicit permission to
test. USD 2 is the spending ceiling; actual cost varies.
Model/tool availability and target access determine coverage.

Review failures and incomplete coverage before interpreting empty results. [Scan Workflows](/scan-workflows/)
covers saved runs, outputs, resuming, and verification.

With Docker, persist the database and report outside the disposable container.
Create a directory writable by UID 1000, then mount it separately from scope:

```bash
mkdir -p scan-output
docker run --rm \
  -v "$PWD/scope.json:/work/scope.json:ro" \
  -v "$PWD/scan-output:/output" -e ANTHROPIC_API_KEY -e ZERO_RUN_DIR=/output \
  ghcr.io/0sec-labs/0sec:latest scan \
  --target https://app.example.com --mode web --scope /work/scope.json \
  --runtime api --depth quick --cost-ceiling 2 \
  --db-path /output/scan.db --format json
```

`ZERO_RUN_DIR` enables the automatically written `report.json` under the mounted
output directory even with an explicit database path. Use a fresh output
directory per run. Optional execution journals use the separate
`~/.0/runs/<scan-id>/` store; persist the container's state directory too if
you enable journaling and need those traces after exit.

Do not mount your Docker socket or entire home directory just to provide a key.
For volume permission errors, see [Docker troubleshooting](/troubleshooting/#permission-errors-on-mounted-volumes).

## Common scan tasks

### Web app pentest

Shell-first: the agent gets `bash` and standard tooling to probe for CORS, SSRF,
XSS, SQLi, SSTI, exposed files, and more.

```bash
0 scan --target https://app.example.com --mode web --scope ./scope.json
```

### Audit a package

Retrieves package material for static and AI review. Package ecosystems have
different acquisition requirements; see [Scan Workflows](/scan-workflows/).
Treat downloaded code as untrusted and use a disposable environment.

```bash
0 audit lodash
0 audit requests --ecosystem pypi
0 audit alpine:3.20 --ecosystem oci
```

### Review a codebase

```bash
0 review ./my-app                       # local directory
0 review https://github.com/user/repo   # clones automatically
```

### Control scan depth

| Depth | Use |
| --- | --- |
| `quick` | A smaller initial investigation to check setup and access. |
| `default` | The normal investigation budget. |
| `deep` | More investigation budget for a deliberate deeper run. |

Depth sets template limits and agent turn budgets. Test coverage and duration vary
by target. See [Budget Management](/budget-management/).

```bash
0 scan --target https://app.example.com --mode web --scope ./scope.json --depth deep
```

## No sandbox by default

The default shell executor runs commands **on your host**. Scope checks,
timeouts, and tool restrictions are not OS isolation. Use a disposable
environment for untrusted targets and source.

The optional Docker executor and replay verifiers have their own isolation
boundaries; enabling one does not sandbox every CLI operation. See
[Configuration](/configuration/) and [Scan Workflows](/scan-workflows/).

## Managed work and onboarding

The CLI implements repository enrollment, managed run requests, and recurring
schedules, and corresponding server integration exists. That is different
from proving your account's access or a compatible deployed end-to-end flow.
[Contact the team](https://0.security/contact/?intent=contact) to agree managed
work; the local CLI above remains an account-optional starting point.

Before automating `connect` or `service`, check
[managed lifecycle compatibility](/ci/github-action/#managed-lifecycle-compatibility).
The reviewed client/server pair has schedule-filtering and budget-field
mismatches: repository-selective disconnect and per-run ceiling enforcement
must not be assumed safe from the command names or flags alone.

Before managed work starts, agree on the repositories and running targets,
allowed actions, budget, cadence and evidence required. Repository access
alone does not authorize testing a production application or a third party.
Keep patch publication, applying a change and checking a deployed fix as
separate approvals. A generated patch is not a verified fix.

Agree on verification and remediation deliverables as part of the engagement.
Local engine access, hosted inference and managed security are separate paths;
access to one does not grant the others. Follow the
[roadmap](/roadmap/#0cloud) for the current availability boundary.

The CLI also implements [managed lifecycle commands](/commands/#service) for
approved service environments. Starting a remote scan, polling its outcome,
requesting cancellation and deleting schedules are different operations.
Their presence in `--help` does not qualify the backend or grant service access.

## Next steps

**Continue working**
- [Console](/console/) — interactive chat, approvals, sessions, and keyboard controls
- [Scan Workflows](/scan-workflows/) — investigation through evidence review
- [Troubleshooting](/troubleshooting/) — diagnose setup, scope, runtime, and execution failures

**Reference**
- [Commands](/commands/) — full CLI reference
- [Configuration](/configuration/) — runtimes, modes, feature flags
- [Recipes](/recipes/) — copy-paste scans for common scenarios
- [Architecture](/architecture/) — how the pipeline works
