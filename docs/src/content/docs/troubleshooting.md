---
title: Troubleshooting
description: Fix common install, provider, scan, state and browser app problems.
---

Start with `0 doctor`. It checks the runtime, your model provider and the CLIs on your `PATH`.

```bash
0 doctor
0 --version
0 config show
```

## Install

### Download fails

`install.sh` downloads the binary for your platform from the latest GitHub Release and checks it against `checksums.txt`.

| Message | Cause |
| --- | --- |
| `curl: (22) ... 404` | No release asset for your platform. See the table below. |
| `curl: (6) Could not resolve host` | No network access to `github.com`. |
| `checksums.txt has no entry for ...` | Your platform is not in the latest release. |
| `checksum mismatch ... refusing to install` | Corrupt download. Retry. If it persists, [open an issue](https://github.com/0sec-labs/0/issues). |
| `curl is required` | Install `curl`. |
| `sha256sum or shasum is required` | Install a SHA-256 tool. Do not skip verification. |

| Release asset | Platform |
| --- | --- |
| `0-darwin-arm64` | macOS, Apple Silicon |
| `0-linux-x64` | Linux x86_64 |
| `0-linux-arm64` | Linux ARM64 |
| `0-windows-x64.exe` | Windows x86_64, manual download |

Intel Macs have no native release. Use the [Docker image](/docker/) or a source build.

### FoxGuard download fails

The installer also fetches the FoxGuard static analyzer into the same folder. If that fails, 0 stays installed without it. Fix the network or permission problem and rerun the installer.

To skip FoxGuard on purpose:

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | INSTALL_FOXGUARD=0 sh
```

Without FoxGuard, source reviews lose its static coverage.

<span id="0-command-not-found-after-install"></span>
### `0: command not found`

The binary is at `~/.0/bin/0`. The installer adds that folder to your shell profile, but the current terminal does not see it yet. Run the line it printed, or:

```bash
export PATH="$HOME/.0/bin:$PATH"
```

A source build does not install a global `0`. Run `node packages/cli/dist/index.js` instead.

### Windows

Windows is experimental and `install.sh` does not support it. Download `0-windows-x64.exe` from [Releases](https://github.com/0sec-labs/0/releases/latest). Compare its hash with `checksums.txt` from the same release:

```powershell
Get-FileHash .\0-windows-x64.exe -Algorithm SHA256
.\0-windows-x64.exe --help
```

`0 upgrade` does not support Windows. Download new releases by hand.

## Runtime

<span id="0-doctor-reports-nodejs-version-as-bad"></span>
### `0 doctor` reports Node.js as bad

A source build needs Node.js 24 or newer. The release binary bundles its own runtime.

```bash
node --version
nvm install 24
```

### API provider missing

```
API provider  missing  not configured
```

No model credential was found. Connect a provider in **Settings → Connections**, or export a key:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
0 doctor
```

See [Models and keys](/models/). `configured` means a credential was found, not that it works. The first model request proves access and quota.

### API provider bad

```
API provider  bad  Azure OpenAI
```

0 found a provider but its local setup is incomplete. `0 doctor` prints the reason below the status.

| Provider | Usual fix |
| --- | --- |
| Azure OpenAI | Set `AZURE_OPENAI_BASE_URL` (with `/openai/v1` for Responses) and a deployment ID. See [Azure OpenAI](/models/#azure-openai). |
| ChatGPT Codex | Run `codex login`, or pass `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN` with `env`. |

<span id="0-doctor-shows-no-cli-runtimes-found"></span>
### No CLI providers found

The `claude`, `codex` and `gemini` CLIs are optional. Without them, use `--runtime api` and a provider key. See [CLI runtimes](/models/#cli-runtimes).

### `export ZERO_...` fails

Some shells reject variable names that start with a digit. Pass them with `env`:

```bash
env ZERO_CHATGPT_OAUTH_REFRESH_TOKEN="..." 0 scan source .
```

### The wrong provider is used

With several keys set, a pin, the model name and key priority all decide the route. Pin the one you want:

```bash
env ZERO_SELECTED_PROVIDER=openai ZERO_MODEL="<model-id>" \
  0 scan source ./authorized-repo --runtime api
```

See [How 0 picks a provider](/models/#how-0-picks-a-provider).

### Cost ceiling cannot be enforced

A model with no price entry (a free tier or a custom endpoint) has an unknown cost. 0 counts it as $0, flags it unknown and warns once. A cost ceiling cannot bound it, so also set a time limit.

For a priced model, 0 needs token usage in every response. If a proxy drops or corrupts usage counts, the run stops before the next step. Check the proxy's usage reporting and the wire format (`*_WIRE_API`).

## Scans

### Agent loop error

`Agent loop error: ...` usually means one of:

- **Model unavailable**: rate limit, quota or an unknown model ID. Check `--model` or `ZERO_MODEL`.
- **Network error**: the provider is unreachable. Check connectivity and proxies.
- **Timeout**: see below.

### Scan times out

`scan web --timeout` sets the request timeout in milliseconds (default `30000`). Without a confirmed plan, it is also the scan deadline, so raising it raises both:

```bash
0 scan web --target https://example.com --scope ./scope.json --timeout 600000
```

With a confirmed plan, the plan's time cap sets the deadline instead. A deadline requests cancellation; cleanup can take longer. `--depth quick` does less work but has no fixed duration.

`0 mcp-server` has its own per-tool timeout, also 30 seconds by default (`--timeout`).

### Exit code 2 before a scan starts

The configuration is invalid, for example an unknown `--engagement-profile`, a bad `ZERO_ENGAGEMENT_RATE_RPS` or a malformed `engagement` block in the scope file. The message on stderr names the problem. The scan never starts on a bad posture.

### Target is out of scope

```
--target https://example.com is out of scope per ./scope.json: ...
```

The hostname matches no `in_scope` rule, or matches an `out_of_scope` rule. See [Diagnose a scope refusal](/scope/#diagnose-a-scope-refusal).

### `scan deep` finds nothing

`scan deep` returns leads, not confirmed bugs. Read its JSON status and coverage, not just the findings list.

| Exit | Meaning |
| --- | --- |
| `0` | The sweep finished, with or without leads. Not a clean bill of health. |
| `2` | Skipped, for example no candidate files or a tree over the 5,000-file cap. Narrow with `--subsystem <path>`. |
| `3` | Error: unreadable target, bad flags or every finder failed. |

`--max-candidates` and `--models <a,b>` limit the work. Raise only the limit the coverage report points to. `scan deep` does not take `--model`, `--changed-only` or `--diff-base`; run `0 scan deep --help`.

### `spawnSync rg ENOENT`

Source discovery uses ripgrep and falls back to slower reads without it. Install it with `brew install ripgrep` or `sudo apt install ripgrep`. The Docker image includes it.

### Report has a warnings section

Warnings mean some work was degraded or incomplete. Zero findings after provider or tool failures is not a clean result. Check the JSON report for structured diagnostics, and keep the database when you report a bug.

## Docker

### Container prints help and exits

The image runs `0 --help` by default. It does not mount your folder or read your host credentials. Pass both:

```bash
docker run --rm -e ANTHROPIC_API_KEY \
  -v "$PWD:/work/source:ro" ghcr.io/0sec-labs/0:latest \
  scan source /work/source --runtime api --depth quick
```

Mount a writable output folder and set `--db-path` when results must outlive `--rm`. See [Docker](/docker/).

### Permission errors on mounts

The container runs as `ubuntu` (UID 1000). Give that user read access to the source mount and write access to a separate output mount. Do not make private source world-readable or writable to work around it.

### AD tools not found

impacket, certipy and bloodhound-ce live in a Python venv at `/opt/ad-tools`, with their commands linked into `/usr/local/bin`:

```bash
docker run --rm --entrypoint bash ghcr.io/0sec-labs/0:latest -c 'which secretsdump.py'
```

## State and database

### Database is locked

Two processes are writing to the same SQLite file. Stop the other scan or app cleanly and retry. Do not delete a live database or lock folder.

Each new scan gets its own `~/.0/runs/<run-id>/state.db` unless you pass `--db-path` or `ZERO_DB_PATH`. Reusing one path across parallel jobs brings the contention back. The browser app uses one shared local store.

`0 db reset` refuses to run while a live process holds the lock, or while a lock with no owner is under 5 minutes old. `0 db repair` moves the old file aside and creates a fresh database; it does not recover rows, so back up first.

### Cannot resume a scan

`0 runs relaunch` needs the scan ID (or a unique prefix) and the original database:

```bash
0 runs relaunch <scan-id> --db-path ./scans/scan-001.db
```

The scan ID prints when the scan starts. `0 console --resume` is different: it continues a saved mission, not a scan.

## Browser app

### The app does not open

Run `0` or `0 web`. Use `0 web --no-open` and open the printed URL yourself if no browser starts. In a source checkout, run `pnpm build` first. For scripts, use `0 -p "<prompt>"`; see [Run headless](/app/#run-headless).

### A saved key seems missing

Keys saved in **Connections** live in `~/.0/credentials.json` under the home folder of the process running 0. A nonblank environment variable overrides the saved key for that provider. Do not paste that file into a bug report.

### `--finding-intent` does nothing

`--finding-intent` needs `--finding <id>`. Values: `investigate` (default), `verify`, `draft_fix` and `impact`. The finding must exist in the database chosen by `--db-path`. A scan ID or mission ID is not a finding ID.

## Known limits

- `0 mcp-server` uses stdio transport only.
- `0 upgrade` does not support Windows.
- Plugin catalog contents depend on the configured registry. Installing a plugin and enabling it are separate steps. See [Plugins](/plugins/).

## Still stuck

Run `0 doctor`, then [open an issue](https://github.com/0sec-labs/0/issues) with its output, the command you ran and the error. Leave out keys, tokens and target data. For a vulnerability in 0 itself, follow [SECURITY.md](https://github.com/0sec-labs/0/blob/main/.github/SECURITY.md).
