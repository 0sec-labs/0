---
title: Troubleshooting
description: Common installation, runtime, configuration, and diagnostic issues with the 0 CLI.
---

## Installation

### Binary download fails

The install script (`install.sh`) downloads from the latest GitHub Release.
Failures usually mean one of:

| Symptom | Likely cause |
|---------|-------------|
| `curl: (22) The requested URL returned error: 404` | Release asset not found for your platform/arch. Check supported combos below |
| `curl: (6) Could not resolve host` | No network access to `github.com` |
| `checksums.txt has no entry for ...` | Platform/arch not published for the latest release |
| `checksum mismatch` | Download corrupted; retry. If persistent, [contact the team](https://0.security/contact/?intent=contact) |
| `curl is required` | `curl` not installed. Install it (`apt install curl`, `brew install curl`) |
| `sha256sum or shasum is required` | Install a SHA-256 utility; do not bypass checksum verification |
| `refusing to replace existing .../0` | The installer found a regular file or unrelated symlink at the alias path; inspect it and choose an unused `INSTALL_DIR` rather than overwriting another program |

Supported release assets (from `.github/workflows/release.yml`):

| Asset | Platform |
|-------|----------|
| `0-linux-x64` | Linux x86_64 |
| `0-linux-arm64` | Linux ARM64 |
| `0-darwin-arm64` | macOS Apple Silicon |
| `0-windows-x64.exe` | Windows x86_64 (manual download — install.sh supports Linux/macOS only) |

Intel macOS is not in this native release matrix. Use a supported source/npm
runtime or the container rather than renaming an Apple Silicon binary.
`RELEASE_BASE_URL` must point to a release download directory containing both
the binary and its matching `checksums.txt`; changing it does not change the
pinned FoxGuard download.

### FoxGuard provisioning fails

`install.sh` auto-provisions the FoxGuard static analyzer binary. If it fails:

- `INSTALL_FOXGUARD=0` skips provisioning for a host where you deliberately
  supply or do not need the analyzer; it does not provide equivalent static coverage.
- FoxGuard requires working `curl`, checksum verification and write access to
  `INSTALL_DIR` (default `~/.0/bin`).
- The main binary and alias are installed before FoxGuard is downloaded, so a
  companion failure can leave the CLI installed. Correct the failure and rerun
  the installer. `FOXGUARD_TAG` cannot select an arbitrary release: its checksums
  are pinned in the script.

```bash
# Install without FoxGuard
INSTALL_FOXGUARD=0 bash <(curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh)
```

<span id="0-command-not-found-after-install"></span>
### `0` command not found after install

The binary is installed to `~/.0/bin/0` (and symlinked as `~/.0/bin/0`).
Add it to your `PATH`:

```bash
export PATH="$HOME/.0/bin:$PATH"
# or add the line above to ~/.bashrc / ~/.zshrc
```

If the install script detected `~/.0/bin` is not on `PATH`, it prints a
warning with the command to add it.

### Install on Windows

Windows support is experimental. `install.sh` does not support Windows.
Download the release asset manually from the
[releases page](https://github.com/0sec-labs/0/releases/latest):

```
0-windows-x64.exe
```

Replace your current binary in place. Auto-upgrade is tracked separately.
The Unix alias is not created. In PowerShell, run the actual downloaded file:

```powershell
.\0-windows-x64.exe --help
```

Download `checksums.txt` from the same release and compare its entry with
`Get-FileHash .\0-windows-x64.exe -Algorithm SHA256` before execution.

## Runtime

<span id="0-doctor-reports-nodejs-version-as-bad"></span>
### `0 doctor` reports Node.js version as bad

Source/npm execution requires **Node.js 24 or newer**.

```bash
# Check your version
node --version

# Upgrade (example via nvm)
nvm install 24
```

The standalone release binary includes its runtime and does not require Node
or Bun installed separately. The full terminal UI requires Bun when running
from source; Node provides the readline fallback.

If `pnpm build` succeeds but `0` is missing, that is expected: a source checkout
does not globally install an alias. Use `node packages/cli/dist/index.js --help`
or `bun packages/cli/dist/index.js` for the TUI. The published Node package is
`@0/cli`; install it with `npm install -g @0/cli` if you want global commands.

### No API runtime configured

`0 doctor` reports `API runtime missing`:

```
API runtime   missing  not configured
```

Set one of the supported provider environment variables. See
[API Keys](/api-keys/) for the full list.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# or
export OPENAI_API_KEY="sk-..."
```

Then run `0 doctor` again to check configuration discovery. **Configured is not
authenticated**: doctor checks local prerequisites; the first model request
establishes whether credentials, model access and quota actually work. Under
Bun with a TTY, doctor opens its interactive screen instead of the text table.

### API runtime configured but unusable

```
API runtime   bad  Azure OpenAI
```

The runtime detected a provider but its local configuration is incomplete or
unusable. This is not a live provider-authentication test. Common cases:

| Provider | Missing |
|----------|---------|
| Azure OpenAI | `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_MODEL` not set. The base URL must include `/openai/v1` for the Responses API |
| ChatGPT Codex | Neither `ZERO_CHATGPT_ACCESS_TOKEN`, `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN`, nor `~/.codex/auth.json` was found. Run `codex login` first, or pass the env var directly: `env ZERO_CHATGPT_OAUTH_REFRESH_TOKEN="..." 0 scan ...` |

For an explicit Azure setup, supply all three variables (a supported Azure-backed
Codex config can also supply deployment configuration):

```bash
export AZURE_OPENAI_API_KEY="..."
export AZURE_OPENAI_BASE_URL="https://your-resource.openai.azure.com/openai/v1"
export AZURE_OPENAI_MODEL="gpt-4o"
```

<span id="0-doctor-shows-no-cli-runtimes-found"></span>
### `0 doctor` shows no CLI runtimes found

CLI runtimes (`claude`, `codex`, `gemini`) are optional. For scan, review and
audit, `auto` selects an available runtime for the workflow. Use `--runtime api`
to select direct provider calls explicitly. To install a CLI runtime:

```bash
npm i -g @anthropic-ai/claude-code   # Claude Code CLI
npm i -g @openai/codex               # Codex CLI
npm i -g @google/gemini-cli          # Gemini CLI
```

Verify:

```bash
0 doctor
# CLI runtimes  found  claude codex gemini
```

### Agent loop error during a scan

An unrecoverable agent-loop failure reports an error such as:

```
Agent loop error: ...
```

Common causes:

- **Model unavailable** — the configured provider is rate-limited, over quota,
  or the model doesn't exist. Check `ZERO_MODEL` or `--model` and see
  [Configuration](/configuration/) for available models
- **Network error** — the provider API is unreachable. Check network connectivity
  and proxy settings
- **Timeout** — a request or agent operation exceeded its configured timeout.
  `scan --timeout` is a request timeout, not a universal wall-clock scan limit.
  Check the failing stage before raising it; reduce depth if less work is appropriate.

See [Budget Management](/budget-management/) for cost and timeout controls.

### Scan fails with exit code 2

Exit code 2 from scan-related commands indicates bad configuration:

- A typo'd `--engagement-profile` name
- An invalid `ZERO_ENGAGEMENT_RATE_RPS` value
- A malformed scope file `engagement` block

The error message on stderr identifies the exact issue. Fix it and re-run. The
scan never starts on a bad posture config.

### Scope rejection

When a target is out of scope:

```
--target https://example.com is out of scope per ./scope.json: ...
```

The target URL does not match any `in_scope` entry in the scope JSON file, or
matches an `out_of_scope` deny rule (deny takes precedence). See
[Scope & Authorization](/scope/) for scope syntax.

### Cloud auth failure

```bash
0 auth status
# FAIL (HTTP 401)
```

| Exit | Meaning |
|------|---------|
| `2` | Auth failure (401/403 or missing credentials) |
| `3` | Network error (host unreachable, DNS failure) |
| `1` | Other error |

For an operator-provided host, retry `0 auth login` or use the manual token path below. See [0cloud setup](/getting-started/#hosted-models-draft) for availability.

```bash
0 auth login --host https://control-plane.example.com --token "your-token"
```

## Provider issues

### Multiple providers configured — which one is used?

Routing is not simply “first key wins.” A saved or explicit provider selection,
per-call model override, model prefix and available credentials can all affect
the route. Review the active model/provider in `/model` and follow
[provider pinning](/api-keys/#provider-pinning).

For a direct OpenAI route without deleting other keys:

```bash
env ZERO_SELECTED_PROVIDER=openai ZERO_MODEL="<model-id-your-account-can-use>" \
  0 review ./authorized-repo --runtime api
```

Replace the model ID with one your provider exposes. In the TUI, connecting a
provider usually stages the next chat rather than replacing a healthy current
runtime: reselect the model in `/model` to apply it live. A worker-role override
is inactive while single-model mode is enabled; **Ctrl+S** in `/model` toggles
that policy. See [model picker controls](/console/#model-picker).

### `ZERO_*` env vars with leading digit

Variables like `ZERO_CHATGPT_ACCESS_TOKEN` start with a digit. Most shells
reject `export ZERO_*=...`. Pass them to the process with `env`:

```bash
# Correct
env ZERO_CHATGPT_OAUTH_REFRESH_TOKEN="..." 0 review .

# Incorrect (bash syntax error)
export ZERO_CHATGPT_OAUTH_REFRESH_TOKEN="..."
```

### ChatGPT Codex auth file path

By default, the Codex runtime reads tokens from `~/.codex/auth.json`. Override:

```bash
env ZERO_CHATGPT_AUTH_FILE="/path/to/auth.json" 0 scan ...
```

`ZERO_CODEX_AUTH_JSON_PATH` is a deprecated spelling. Prefer
`ZERO_CHATGPT_AUTH_FILE`.

### OpenRouter routing

OpenRouter can provide a fallback when a model's direct provider credentials
are absent. To select it as the primary route without deleting other keys,
configure `OPENROUTER_API_KEY` and pin a model supported by your account:

```bash
env ZERO_SELECTED_PROVIDER=openrouter ZERO_MODEL="<OpenRouter-model-id>" \
  0 review ./authorized-repo --runtime api
```

See [provider pinning](/api-keys/#provider-pinning) for per-call model overrides.

### Hosted balance is unavailable

Run `0 auth status` to check authenticated account access, then
`0 balance --json`. A `null` result means the current client could not
interpret the account response; it does not mean zero credit or a failed login.
Use the CLI/service combination approved for your test environment.

The client expects a `usage-v2` snapshot. A legacy `credits-v1` response is
not compatible with that reader. Included allowance works without prepaid.
`prepaid_disabled` means the service reports no usable included allowance and
prepaid fallback is off; it is not an instruction to enable prepaid.
Check `included.state` in `0 balance --json`: `none` means no included allowance
is reported, `exhausted` means it has been used up, and `unavailable` means it
could not be verified. A missing percentage is not zero usage.
Review the organization's included allowance in `/connect` or with its owner;
reconnecting or choosing another hosted model does not provision allowance. After access changes, use
**Ctrl+R** in chat to check again. Your draft is retained, not automatically sent.
See [hosted account data](/api-keys/#hosted-inference).

## Scan and review
### Triage command reports an ambiguous target

If `0 triage --help` reports **Ambiguous target** before showing help,
the root router has treated the command name as a target instead of reaching
its registered subcommands. This is a current source routing defect, not
missing model credentials or a scope-file problem.

Check `0 --version` when reporting it. Do not add a URL, change scope or
start a scan to bypass the error. The registered triage reference describes
the intended command interface; it does not establish that this routing path
works in your installed build.


### Deep review produces no findings

`deep-review` emits **leads**, not confirmed bugs. Inspect its JSON status,
warnings and incomplete coverage, not just the findings list:

- **Exit 0** — the sweep completed, with or without leads; this is not a
  claim that the whole source tree is secure.
- **Exit 2** — skipped, for example no candidate files or a tree over the
  review cap. Use `--subsystem` to narrow a deliberately large target.
- **Exit 3** — error, including unreadable targets, bad flags or all finders
  failing. Resolve the reported failure before interpreting zero results.
- **Limited coverage** — `--max-candidates`, `--models`, `--attempts`,
  concurrency and budget constrain the work. Increase only the relevant limit
  after inspecting the coverage report and provider capacity.

`--changed-only`, `--diff-base` and singular `--model` are not deep-review
options. Use its plural `--models <a,b>` and command-specific
`0 deep-review --help`; do not copy the ordinary review command's flags.

### Scan times out

`scan --timeout` sets the request timeout in milliseconds (default `30000`). To increase it:

```bash
0 scan --target https://example.com --scope ./scope.json --timeout 600000
```

For the MCP server, the default per-tool timeout is 30 seconds:

```bash
0 mcp-server --target https://example.com --scan-id s1 --scope ./scope.json --timeout 60000
```

Total duration depends on work, concurrency and provider response time. There is
no fixed completion time implied by `--depth quick` or a longer request timeout.

### `spawnSync rg ENOENT` warnings

The audit/scan agent's source-tree discovery loop defaults to `ripgrep` for fast
searches. When `rg` is not on `PATH`, the agent falls back to slower `find` +
per-file reads. Install ripgrep:

```bash
# Ubuntu/Debian
sudo apt install ripgrep

# macOS
brew install ripgrep
```

The [Docker image](/integrations/#docker-image) includes ripgrep pre-installed.

### Results format not supported

`scan`, `review`, and `audit` default to `terminal`. Their registered formats are
`terminal`, `json`, `md`, `html`, `sarif`, and `pdf`. Check
[Commands](/commands/) for the selected command's options.

```bash
0 scan --target http://127.0.0.1:8080 --scope ./scope.json --format pdf
```

PDF reports require pdfkit (bundled in the CLI dependencies).

### Report contains warnings section

Warnings describe degraded or incomplete work, not successful verification.
Read the warning's stage and message alongside scan status and coverage; a
report with zero findings after provider/tool failures is not a clean bill of
health. Preserve the database and any emitted journal when reporting a failure.
The report formats expose warnings differently, so inspect the JSON result
when you need structured diagnostics. Do not assume a CI wrapper publishes
warnings unless your actual workflow is configured to do so.

## Docker

### Container exits immediately

The image shows CLI help by default. It does not automatically mount your
current directory or inherit host credentials. Pass both explicitly:

```bash
docker run --rm -e ANTHROPIC_API_KEY \
  -v "$PWD:/work/source:ro" ghcr.io/0sec-labs/0:latest \
  review /work/source --runtime api --depth quick
```

Add a writable output mount and explicit database/report paths when results
must survive `--rm`; see the [container workflow](/getting-started/#run-your-first-scan).
The image runs Node, so adding `-it` does not turn it into the Bun TUI.

### Permission errors on mounted volumes

The container runs as `ubuntu` (UID 1000). Give that user narrowly scoped access
to the mounted source and a separate writable output directory. Directory
traversal needs execute permission as well as file read permission. On Linux,
check host ownership/ACLs; on Docker Desktop, also check file-sharing settings.
Do not recursively make private source world-readable as a general workaround,
and do not grant write access to source just to make report output work.

### AD tools not found despite being in the image

The AD tools (impacket, certipy, bloodhound-ce) are installed in a Python venv
at `/opt/ad-tools`. Their console scripts are symlinked to `/usr/local/bin/`:

```bash
# Verify they're available
docker run --rm --entrypoint bash ghcr.io/0sec-labs/0:latest -c 'which secretsdump.py'
```

The system Python interpreter (`python3`) is deliberately not the venv one, so
the agent's helper scripts can import the apt-managed `requests` and `bs4`.

## Database and state

### SQLite database locked

The database uses a WASM SQLite backend with rollback journaling, not WAL.
Concurrent writers can contend. First stop the competing scan/dashboard
writer cleanly and retry; do not remove a live database or lock directory.
Initialization and migrations are transactional, but that does not make
concurrent writers unlimited. For intentionally separate runs, choose separate
database paths and keep each with its run artifacts.

Fresh scan/review runs already receive isolated
`~/.0/runs/<run-id>/state.db` paths unless overridden. Reusing one explicit
`--db-path` or `ZERO_DB_PATH` across jobs defeats that separation; the console
still uses its shared local store by default.

```bash
0 scan --target https://example.com --scope ./scope.json --db-path ./scans/scan-001.db
```

After a crashed process, the database opener can clear an advisory `.lock`
directory older than its stale-lock threshold (10 seconds). A stale lock is
different from corruption. Preserve a backup before repair; `0 db repair`
recreates the working database after moving the old file aside and does not
recover its rows. Do not use reset/repair as the first response to contention.

### Resume scan not found

`0 resume` requires a scan ID (or unique prefix); a database path alone is not
enough. Keep the original database and its sibling run artifacts, then pass both:

```bash
0 resume <scan-id> --db-path ./scans/scan-001.db
```

The scan ID is printed at the start of the original run.
`0 console --resume` is separate: it loads a saved chat transcript, not a scan
checkpoint. See [console resume](/console/#resume) for its scope and model
limitations.

## TUI / Console

### Console doesn't start

The full UI needs the standalone Bun-compiled release, or Bun plus an installed
source checkout, and both stdin and stdout must be TTYs. Node and redirected
stdio do not select the TUI.

```bash
# Verify prerequisites
0 doctor
```

For a source checkout, install the repository dependencies and run
`bun packages/cli/dist/index.js` after building. Running the same entry point
with Node selects readline, which requires `--scope`; default YOLO also requires
a nonempty `in_scope` list. The Docker image similarly uses Node.

See [launch and approval limitations](/console/#launch) before substituting
readline or `--print`: Standard without an approval callback is not fail-closed,
and Co-pilot does not prompt for each effectful call.

### `/providers` command shows no options

`/providers` now opens the same connection pane as `/connect`; it is not a
read-only credential-status listing. The pane offers connections before keys
are configured. If a provider is disconnected, choose its supported method and
finish sign-in or key entry, then select the model again in `/model`.

If a saved credential appears missing, check which home directory the process
uses and whether its `~/.0/credentials.json` is readable. An explicit
environment credential takes precedence over the store. Do not paste that
file into a bug report. See [API Keys](/api-keys/) for Codex auth-file overrides
and provider-specific requirements.

### Finding chat intent does nothing

`--finding-intent` requires `--finding <id>` and accepts four prompt workflows:

| Intent | Instruction given to the model |
|--------|-------------------------------|
| `investigate` (default) | Assess evidence and propose the next authorized step; do not modify source |
| `verify` | Independently assess impact and identify a minimal authorized reproduction; do not modify source |
| `draft_fix` | Propose a minimal patch and regression test; wait for separate approval before applying |
| `impact` | Explain evidence-qualified business impact and conditional chains; do not execute tools or expand scope |

These are instructions, not a separate filesystem sandbox or replacement for
mode/tool authorization. Invalid values report the allowed list. Check that the
finding exists in the database selected by `--db-path`; an unrelated scan ID or
chat-session ID is not a finding ID.

## Known gaps

| Gap | Details |
|-----|---------|
| **No composite GitHub Action** | The planned `.github/actions/0-scan` composite action has not shipped. Use the container image or binary install instead |
| **Marketplace availability** | The TUI and plugin execution exist; catalog availability depends on the configured registry. Installation and enablement are separate. See [Hackstore](/hackstore/) |
| **Windows upgrade** | `0 upgrade` does not support Windows. Download release assets manually |
| **MCP transport** | The MCP server uses stdio transport only. SSE/WebSocket transport is not implemented |
| **Cloud access** | Device/browser login and authenticated account/model endpoints require a compatible service. A manual token does not bypass service authorization or hosted request admission |

## Diagnostic quick reference

| Command | What it checks |
|---------|----------------|
| `0 doctor` | Node version, API runtime, CLI runtimes |
| `0 auth status` | Cloud credential validity against the authenticated account endpoint |
| `0 h1 auth` | HackerOne API credential validity |
| `0 --version` | CLI version |
| `0 config show` | Effective layered configuration (global + project) |
| `0 scan ... --emit pr --dry-run` | Preview publication commands only; the scan still executes and needs ordinary target authorization |

## See also

- [Configuration](/configuration/) — runtime modes, scan modes, depth settings
- [API Keys](/api-keys/) — supported providers and setup
- [Console](/console/) — interactive chat
- [Scan Workflows](/scan-workflows/) — available scan modes and strategies
- [Scope & Authorization](/scope/) — scope JSON files and target format
- [Budget Management](/budget-management/) — cost ceilings, rate limiting
- [Triage](/triage/) — finding classification and prioritization
- [Verification Results](/verification-result/) — deterministic replay contract
- [Commands](/commands/) — full CLI command reference
- [Integrations](/integrations/) — MCP server, GitHub CI, Docker, HackerOne