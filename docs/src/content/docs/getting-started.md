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
| Managed security work | Agreed scope, permissions, budget and service access | A separately scoped service. See [managed onboarding](#managed-work-and-onboarding). |

## Install

Choose the standalone release or npm package for browser and headless workflows,
a source checkout for development, or the container for a
separate execution environment. Documentation follows the source checkout:
compare `0 --version` and command-specific `--help` with your installed release.

### Release binary

The installer supports Linux x64/arm64 and macOS Apple Silicon. It requires
`curl` and `sha256sum` or `shasum`, verifies the downloaded checksums, and installs
the `0` alias and its release binary under `~/.0/bin`. It also installs the pinned
FoxGuard companion used by default for static analysis.

```bash
# Verified release binary (macOS Apple Silicon / Linux x64/arm64)
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | bash
export PATH="$HOME/.0/bin:$PATH"
0 --help
```

Add the `export` line to your shell profile for future shells. Inspect
[install.sh](https://github.com/0sec-labs/0/blob/main/install.sh) before running
it if your environment requires script review. `INSTALL_DIR` changes the install
location; `INSTALL_FOXGUARD=0` skips the companion on a pre-provisioned host.

To install a specific release, set `RELEASE_BASE_URL` on the shell running the
installer to `https://github.com/0sec-labs/0/releases/download/<tag>`.
Use the checksums from that same release. The installer does not modify your
shell profile, and checksum verification is not a signature or code audit.

Windows release builds are experimental. Download the Windows asset from
[GitHub Releases](https://github.com/0sec-labs/0/releases/latest);
`install.sh` supports Linux and macOS only. See
[Windows installation](/troubleshooting/#install-on-windows).
On Windows, invoke the downloaded executable by its actual filename; the
Unix `0` symlink is not installed there.

### npm package

With Node.js 24 or newer:

```bash
npm install -g @0/cli
0 --help
```

The published package installs the `0` command. Run `0` or `0 web` for the
account-free browser console; automation commands run headlessly.


### Build from source

Use Node.js 24 or newer and pnpm 9 or newer. The repository pins pnpm through
`packageManager`. Both Node and the standalone binary support the browser
console and headless commands. The interactive terminal UI is retired.

```bash
git clone https://github.com/0sec-labs/0.git
cd 0
corepack enable
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.js --help
```
Source builds do not install a global `0` command. Use the built entry point
shown above; for interactive source work, run `bun packages/cli/dist/index.js`.

The bundled Node entry point is also available as `node dist/0.js`.
Native dependency installation may need a compiler toolchain on platforms
without prebuilt addons. The native release workflow uses its own pinned Bun
compiler; `pnpm build` alone does not produce a standalone executable.


### Container

Docker must be installed and running. The image is a separate execution
environment; pass only the credentials and mounts needed for the task.

```bash
docker run --rm ghcr.io/0sec-labs/0:latest --help
```
For a real scan, mount scope and persist any output you need before using
`--rm`; files left only inside the container disappear when it exits.
The image runs the Node bundle as the non-root `ubuntu` user (UID 1000), with
`/work` as its working directory. Container execution is headless. Mount
source read-only unless the task requires writes, and use a separate writable
mount for the database, journal and reports.


## Open the browser

```bash
0 web  # Command Center
0      # Opens the same browser console
```

The **Command Center** is the browser workspace for chats, workflows, findings,
and tool connections. Choose a workspace folder and connect a [model provider](/api-keys/).
New chats default to **YOLO**, which runs tools without per-action approval.
Choose **Auto** to work autonomously within the engagement and ask before
expanding beyond it when [scope enforcement](/scope/) is enabled. Auto uses the
engine's `copilot` mode. Both modes can ask for missing context or decisions;
saved chats retain their existing permission mode.
Saved findings update in the chat sidebar with a count and recent titles.
Findings belonging to the current conversation also appear above its transcript.
**Add to chat** appends a finding reference to your draft; review it before sending.
Use **Chat** for investigations, **Workflows** for reusable steps and schedules,
and **Plugins** to connect tools. See the [workflow guide](/workflow/) and
[engine connections](/engine-connections/) for execution setup.

## Configure a provider

Run `0` to open the browser console, then open **Connections**. Choose an API
key or a supported provider subscription.

`0` starts the browser console, including on a fresh installation. Choose a
connected provider's model with the conversation model picker.
The interactive console does not route inference through 0cloud; managed-service
access is arranged separately from local model access.

For your own provider, use `/model` to select a model. Model and role-model
selections apply to the current audit while idle, or after its current turn
completes. Switching to a different API-key or subscription provider opens its
model picker before applying the connection.


### Use my own API key

Your provider handles authentication and billing. Local API-key and supported
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
subscription entry. Provider account restrictions and model availability still apply.

### Use multiple models deliberately

Start with one connected provider route that can serve the models you want.
For example, a gateway such as OpenRouter can expose models from multiple
vendors through one account. Choose a model in the browser conversation picker.
Programmatic worker-role overrides remain available through the embedding API.
Workers inherit the parent's provider, credentials and endpoint: a role choice
does not automatically switch accounts to another configured provider. See
[multi-model role routing](/configuration/#multi-model-role-routing) for a
concrete configuration and precedence. Worker-role controls are exposed in the embedding API,
not as a general CLI role-map flag or environment variable. A role override
chooses a model when that role runs; it does not guarantee every workflow
spawns that role or verifies every finding.

### Start with a local repository

For an initial authorized source review without a live network target:

```bash
0 review ./authorized-repo --runtime api --depth quick --cost-ceiling 2
```

For interactive work, run `0 web` and choose the desired autonomy mode in the
browser conversation. Describe the repository path and objective there.

For headless work, use `0 chat --prompt "your request"` or `0 -p "your request"`.
Headless prompts do not have an interactive approval surface. Combine saved-session
`--resume <id>` or `--continue` with a headless prompt to retain conversation context.

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
  ghcr.io/0sec-labs/0:latest scan \
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

Managed execution is separately operated; the local CLI does not provide
repository enrollment or managed scan lifecycle commands.
[Contact the team](https://0.security/contact/?intent=contact) to agree managed
work. Confirm schedule filtering, budget enforcement, deployment compatibility
and account access with the operator before automating service workflows.
The local CLI above remains an account-optional starting point.

Before managed work starts, agree on the repositories and running targets,
allowed actions, budget, cadence and evidence required. Repository access
alone does not authorize testing a production application or a third party.
Keep patch publication, applying a change and checking a deployed fix as
separate approvals. A generated patch is not a verified fix.

Agree on verification and remediation deliverables as part of the engagement.
Local model access and managed security are separate paths; access to one does
not grant the other. See the [roadmap](/roadmap/#0cloud).

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
