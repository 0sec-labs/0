---
title: CLI Getting Started
description: Install 0, configure a provider, define scope, and run your first authorized CLI scan.
---

0 is the free, open-source security research CLI. Install it, connect a model,
and work on a repository or target you're authorized to test. Model access and
execution infrastructure are separate from the local engine.

This guide uses the existing `0` executable alias. Repository and package paths,
release asset names, `~/.0sec` state paths, and `0SEC_*` environment variables
retain their legacy technical names until a separate rename.

| Path | What you need | Where the work runs |
| --- | --- | --- |
| Local CLI with your model access | A supported [API key or provider subscription](#use-my-own-api-key) | Tools run on your configured executor; your provider handles inference and billing. No 0cloud account is required. |
| Local CLI with hosted inference | An approved [0cloud test service](#hosted-models), compatible CLI and service access | The service handles model requests; tools still run on your configured executor. |
| Managed security work | Agreed scope, permissions, budget and service access | A separately scoped service. See [managed onboarding](#managed-work-and-onboarding). |

## Install

Install the verified release binary with one command, build from source, or run
the container image.

### Release binary

The installer supports Linux x64/arm64 and macOS Apple Silicon. It requires
`curl` and `sha256sum` or `shasum`, verifies the downloaded checksums, and installs
the `0` alias and its release binary under `~/.0sec/bin`. It also installs the pinned
FoxGuard companion used by default for static analysis.

```bash
# Verified release binary (macOS Apple Silicon / Linux x64/arm64)
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0sec/main/install.sh | bash
export PATH="$HOME/.0sec/bin:$PATH"
0 --help
```

Add the `export` line to your shell profile for future shells. Inspect
[install.sh](https://github.com/0sec-labs/0sec/blob/main/install.sh) before running
it if your environment requires script review. `INSTALL_DIR` changes the install
location; `INSTALL_FOXGUARD=0` skips the companion on a pre-provisioned host.

Windows release builds are experimental. Download the Windows asset from
[GitHub Releases](https://github.com/0sec-labs/0sec/releases/latest);
`install.sh` supports Linux and macOS only. See
[Windows installation](/troubleshooting/#install-on-windows).
On Windows, invoke the downloaded executable by its actual filename; the
Unix `0` symlink is not installed there.


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


### Container

Docker must be installed and running. The image is a separate execution
environment; pass only the credentials and mounts needed for the task.

```bash
docker run --rm ghcr.io/0sec-labs/0sec:latest --help
```
For a real scan, mount scope and persist any output you need before using
`--rm`; files left only inside the container disappear when it exits.


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

:::caution[Hosted access is a development integration]
Cloud inference isn't available as a qualified public production flow yet.
Use the compatible CLI and approved service supplied for your test. A browser
login or a listed model does not establish that billing and inference are ready.
:::

0cloud model access and managed security work have separate setup and
authorization. Choosing hosted inference does not move the CLI's shell tools
off your machine.

1. Set `HOSTED_TEST_HOST` to the operator-provided URL. Log in below, choose
   your organization, and authorize the CLI.
2. Check the model catalog and credit account. Review free-credit eligibility,
   any reported subscription windows, prepaid consent and admission state.
   If credit data is unavailable, resolve CLI/service compatibility first.
3. Choose an ID from `0 models`. Pin `hosted` to use it instead of any
   existing provider key or Codex login.

```bash
0 login --host "$HOSTED_TEST_HOST"
0 models --json
0 balance --json

env 0SEC_SELECTED_PROVIDER=hosted 0SEC_MODEL="<model-id-from-catalog>" \
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
With multiple credentials, select a matching `--model` or `0SEC_MODEL`.
Keep model keys separate from target credentials (`--auth`).
Never commit keys or paste them into issues.

For supported subscription sign-in, use `/connect` and choose the provider's
subscription entry. This is separate from buying hosted model access through
0cloud. Provider account restrictions and model availability still apply.

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

With Docker, mount the scope file and pass its container path:

```bash
docker run --rm -v "$PWD/scope.json:/work/scope.json:ro" -e ANTHROPIC_API_KEY \
  ghcr.io/0sec-labs/0sec:latest scan \
  --target https://app.example.com --mode web --scope /work/scope.json \
  --runtime api --depth quick --cost-ceiling 2
```

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

Proposed managed onboarding is a prototype, not a connected self-serve setup
flow. Do not treat editable examples as saved settings, a repository
connection or a started run. [Contact the team](https://0.security/contact/?intent=contact)
to agree on managed work; use the local CLI above for an account-optional start.

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
