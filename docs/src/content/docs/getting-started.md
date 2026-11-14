---
title: CLI Getting Started
description: Install 0, connect a model, and start a browser investigation or CLI review.
---

0 runs security investigations in a local browser and through headless CLI
commands. Connect your own model provider, choose a workspace, and describe the
work. Use the [enterprise platform direction](/roadmap/#enterprise-platform) to explore
organization-wide automation and specialist plugins.

## Install

Use a release binary for everyday use, a source checkout for development,
or Docker for container execution. Check `0 --version` and command-specific
`--help` when using an older release.

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

The `export` only matters for the terminal you ran the installer in; the installer
also adds `~/.0/bin` to supported shell startup files, so a new terminal finds `0`.
It reports any write errors.
Set `INSTALL_DIR` for a custom location and follow the PATH command it prints.
`INSTALL_FOXGUARD=0` skips FoxGuard on a pre-provisioned host. See
[install.sh](https://github.com/0sec-labs/0/blob/main/install.sh) for the details.

To install a specific release, set `RELEASE_BASE_URL` on the shell running the
installer to `https://github.com/0sec-labs/0/releases/download/<tag>`.
Use the checksums from that same release.

Windows release builds are experimental. Download the Windows asset from
[GitHub Releases](https://github.com/0sec-labs/0/releases/latest);
`install.sh` supports Linux and macOS only. See
[Windows installation](/troubleshooting/#install-on-windows).
On Windows, invoke the downloaded executable by its actual filename; the
Unix `0` symlink is not installed there.

### Build from source

Use Node.js 24 or newer and the pnpm version pinned in `packageManager`.
Interactive work uses the browser; the terminal UI is retired.

```bash
git clone https://github.com/0sec-labs/0.git
cd 0
corepack enable
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.js --help
```
For the commands below, replace `0` with `node packages/cli/dist/index.js`.
A source build does not install a global command.

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

Choose a workspace folder, connect a [model provider](/api-keys/), and start a
chat. The browser also contains **Findings**, **Automations**, and **Plugins**.

New chats use **YOLO**, which runs tools without per-action approval. Choose a
permission mode in the composer before sending work. Resumed transcripts start in
**Standard** unless you explicitly choose another mode.
**Auto** uses the engine's `copilot` mode; scope enforcement requires the
[scope plugin](/scope/).

Use **Add to chat** on a finding to put its reference in your draft. See the
[console guide](/console/) for chats and controls, or
[engine connections](/engine-connections/) to choose where tools run.

## Configure a provider

Open **Connections** in the browser, add an API key or sign in to a supported
subscription, then choose a model in the conversation's model menu. **Models**
also contains worker-role choices. Model access comes from the selected provider;
local use requires no platform account.

### Use my own API key

For headless commands, set the provider key in the environment:

```bash
export ANTHROPIC_API_KEY="your-api-key"
```

See [API Keys](/api-keys/) for provider variables and subscription sign-in.
With several connections configured, select the provider and model deliberately.
Model keys are separate from target credentials supplied with `--auth`.

### Use multiple models deliberately

Start with one model. Use **Models** in the browser to choose worker-role models
or configure them through the embedding API. Availability depends on the selected
connections and the automation's roles. See
[multi-model routing](/configuration/#multi-model-role-routing) for the rules.

### Start with a local repository

For an initial authorized source review without a live network target:

```bash
0 scan source ./authorized-repo --runtime api --depth quick --cost-ceiling 2
```

For interactive work, run `0 web` and choose the desired autonomy mode in the
browser conversation. Describe the repository path and objective there.

For headless work, use `0 console -p "your request"` or `0 -p "your request"`.
Headless prompts do not have an interactive approval surface. Combine saved-chat
`--resume <id>` or `--continue` with a headless prompt to retain conversation context.

## Run your first scan

Scope authorization is optional and disabled by default. This example enables
it for the current project before scanning. With the plugin enabled, ordinary
`scan` refuses live HTTP, HTTPS, and MCP targets without a scope policy before
requesting the target. Passing `--scope` alone does not activate those checks.

See [Scope & Authorization](/scope/) for exact host, wildcard, CIDR, and exclusion
matching. Scope is a target boundary, not a network sandbox.

```bash
0 plugin enable scope
printf '%s\n' '{"in_scope":["app.example.com"]}' > scope.json

0 scan https://app.example.com --mode web \
  --scope ./scope.json --runtime api --depth quick --cost-ceiling 2
```

Replace `app.example.com` with a target you own or have explicit permission to
test. The example sets a $2 estimated model-cost ceiling; in-flight work can
overshoot. See [budget limits](/budget-management/). Coverage depends on the
available models, tools and target access.

Review failures and incomplete coverage before interpreting empty results. [Scans](/scans/)
covers saved runs, outputs, resuming, and verification.

With Docker, persist the database and report outside the disposable container.
Create a directory writable by UID 1000, then mount it separately from scope.
Project plugin approval on the host does not activate the plugin inside the
container, so this example enables it in `/work` before scanning:

```bash
mkdir -p scan-output
docker run --rm \
  -v "$PWD/scope.json:/work/scope.json:ro" \
  -v "$PWD/scan-output:/output" -e ANTHROPIC_API_KEY -e ZERO_RUN_DIR=/output \
  --entrypoint /bin/sh ghcr.io/0sec-labs/0:latest -c \
  '0 plugin enable scope && exec 0 scan \
  --target https://app.example.com --mode web --scope /work/scope.json \
  --runtime api --depth quick --cost-ceiling 2 \
  --db-path /output/scan.db --format json'
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
0 scan https://app.example.com --mode web --scope ./scope.json
```

### Audit a package

Retrieves package material for static and AI review. Package ecosystems have
different acquisition requirements; see [Scans](/scans/).
Treat downloaded code as untrusted and use a disposable environment.

```bash
0 scan package lodash
0 scan package requests --ecosystem pypi
0 scan package alpine:3.20 --ecosystem oci
```

### Review a codebase

```bash
0 scan source ./my-app                       # local directory
0 scan source https://github.com/user/repo   # clones automatically
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
0 scan https://app.example.com --mode web --scope ./scope.json --depth deep
```

## No sandbox by default

The default shell executor runs commands **on your host**. Scope checks,
timeouts, and tool restrictions are not OS isolation. Use a disposable
environment for untrusted targets and source.

The optional Docker executor and replay verifiers have their own isolation
boundaries; enabling one does not sandbox every CLI operation. See
[Configuration](/configuration/) and [Scans](/scans/).

## Managed work and onboarding

Start with the open-source CLI, local browser, or your own CI runner. Zero Cloud
is retired as a product direction and hosted self-serve acquisition funnel.
The enterprise direction adds automation, integrations, and specialist plugins
around the core. [Contact the team](https://0.security/contact/?intent=enterprise)
to discuss scope, deployment, and available capabilities. See the
[roadmap](/roadmap/#enterprise-platform).

Agree repositories, targets, allowed actions, budget, and deliverables before
enterprise work starts. Repository access alone does not authorize testing a
deployed application. Local model connections are configured separately.

## Next steps

**Continue working**
- [Console](/console/) — interactive chat, approvals, chats, and keyboard controls
- [Scans](/scans/) — investigation through evidence review
- [Troubleshooting](/troubleshooting/) — diagnose setup, scope, runtime, and execution failures

**Reference**
- [Commands](/commands/) — full CLI reference
- [Configuration](/configuration/) — runtimes, modes, feature flags
- [Recipes](/recipes/) — copy-paste scans for common scenarios
- [Architecture](/architecture/) — how the pipeline works
