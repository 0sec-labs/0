# 0sec

**Agent mission control for security scans.**

0sec is the open-source launcher, scan runner, and evidence workspace for
agent-driven security work. Start a run, let an agent investigate an authorized
target, and inspect what happened: the stages it entered, the tools it used,
the findings it produced, and where human review is still needed.

0sec is an active product build, not a fully managed security service. Today,
the local CLI and dashboard are the center of the product. You bring the model
connection, target authorization, and execution environment. Managed scheduling,
team administration, and hosted operational guarantees are separate capabilities
and should not be inferred from this repository.

<p align="center">
  <img src="assets/readme-cover.png" alt="0sec agent mission control" width="100%">
</p>

<p align="center">
  <a href="https://0.security/"><strong>0.security</strong></a> ·
  <a href="https://docs.0.security/">Documentation</a> ·
  <a href="https://github.com/0sec-labs/foxguard">FoxGuard</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-1A1815?style=flat-square&labelColor=1A1815" alt="License: MIT OR Apache-2.0"></a>
  <a href="https://github.com/0sec-labs/0sec/releases/latest"><img src="https://img.shields.io/github/v/release/0sec-labs/0sec?style=flat-square&labelColor=1A1815&color=1A1815" alt="Latest release"></a>
  <a href="#status-and-scope"><img src="https://img.shields.io/badge/status-research%20preview-FD802E?style=flat-square&labelColor=1A1815" alt="Status: research preview"></a>
</p>

## The product in one sentence

**Launch a scan, watch the agent work, and keep the evidence.**

The important surface is deliberately small:

1. **Launch.** Open the console or start a scan from the CLI.
2. **Assign.** Give the agent a target, scope, objective, runtime, depth, and budget.
3. **Observe.** Follow lifecycle events, agent phases, tool activity, costs, and decisions.
4. **Review.** Inspect findings, evidence, verification state, and blocked work.
5. **Decide.** Resume, verify, fix, disclose, or stop. 0sec does not silently merge changes or turn an incomplete run into a clean result.

## Quick start

### 1. Install

For the full interactive console, use the standalone release on Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0sec/main/install.sh | bash
export PATH="$HOME/.0sec/bin:$PATH"
0 --help
```

The installer places the `0` command and the `0sec` alias under
`~/.0sec/bin`. Add the `export` line to your shell profile.

For Node-based, non-interactive commands (Node.js 24+):

```bash
npm install -g 0sec-cli
0 --help
```

The npm package is named `0sec-cli`. The standalone release is the simplest
way to get the Bun-powered interactive UI.

### 2. Connect a model

Launch the console:

```bash
0 console --mode standard
```

Use `/connect` to choose a provider and `/model` to choose a model. The console
can show the active connection and agent activity while a run is in progress.
You may use your own provider credentials; a 0cloud account is not required for
local workflows.

### 3. Run an authorized scan

Network targets require an explicit scope file. Use only systems you own or
have written permission to test.

```bash
printf '%s\n' '{"in_scope":["app.example.com"]}' > scope.json

0 scan \
  --target https://app.example.com \
  --mode web \
  --scope ./scope.json \
  --runtime api \
  --depth quick \
  --cost-ceiling 2
```

For a local repository:

```bash
0 review ./my-repository --runtime api --depth quick --cost-ceiling 2
```

Scope limits what the agent may assess; it is not an OS sandbox. Tools run in
the configured local executor unless you deliberately provide another execution
environment.

### 4. Open mission control

The local dashboard is the primary transparency surface for saved runs:

```bash
0 dashboard
```

It opens a loopback-only dashboard in your browser. It shows scans, findings,
work items, agent states, recent events, review gates, and evidence. To use a
specific database or prevent automatic browser opening:

```bash
0 dashboard --db-path ./scan.db --no-open
```

The dashboard binds to loopback addresses only. It generates a per-process
control token and is not a public internet service. Use an authenticated tunnel
if you need remote access.

## What you can see

0sec records a run as more than a final report. Depending on the workflow, the
local database and dashboard expose:

- scan start, progress, completion, failure, and cancellation;
- agent roles, work items, queue state, and review gates;
- phase and tool activity, with event timestamps and run identifiers;
- findings, evidence, verification attempts, verdicts, and triage state;
- cost summaries, warnings, incomplete coverage, and blocked work;
- resumable run state and replayable output where the workflow supports it.

Use the CLI when you want a compact view or machine-readable output:

```bash
0 history
0 findings list
0 timeline <scan-id>
0 findings show <finding-id>
0 resume <scan-id>
```

Exact subcommand options vary by release. Run `0 <command> --help`; the source
checkout and installed release can differ.

## How an agent run works

A scan is an observable workflow, not a promise that an agent will find or fix
every issue.

```text
operator defines target + scope + budget
                |
                v
        0sec launches a run
                |
                v
 agent plans -> gathers context -> uses authorized tools
                |
                v
      evidence and candidate findings are persisted
                |
                v
 agent verification / consensus -> human review when required
                |
                v
       report, resume, fix, disclose, or stop
```

The agent can be wrong, incomplete, or blocked by the target, credentials,
tool availability, model limits, or budget. A finding marked discovered is not
the same as an independently verified vulnerability. Review the evidence and
verification state before acting on it.

## Transparency and safety principles

- **Authorization first.** Live network work requires scope. Only test systems
  you own or are explicitly authorized to assess.
- **Evidence over confidence.** The UI and reports distinguish hypotheses,
  agent review, human review, verification, false positives, and blocked work.
- **No hidden managed claim.** Local inference, hosted inference, and managed
  security operations are different deployment models.
- **No automatic isolation claim.** Approval modes do not provide OS isolation.
  Use a container or another dedicated executor when isolation is required.
- **No silent completion.** A completed process is not proof that every finding
  was fixed or that coverage was complete.
- **Credentials stay local to their configured route.** Do not commit keys,
  target credentials, scope files containing secrets, or raw sensitive traces.

## Main entry points

| Need | Start here |
| --- | --- |
| Interactive launch and agent control | `0 console --mode standard` |
| Launch a web or API scan | `0 scan --target ... --scope ...` |
| Review a repository | `0 review ./path` |
| Mission-control dashboard | `0 dashboard` |
| Inspect saved runs | `0 history`, `0 timeline <scan-id>` |
| Inspect and triage findings | `0 findings list`, `0 findings show <id>` |
| Continue a run | `0 resume <scan-id>` |
| Verify or repair a result | `0 verify`, `0 fix`, `0 secure` |
| Check local setup | `0 doctor` |

The repository also contains specialized research workflows. They are not all
part of the core launch path and may require additional engines, credentials,
fixtures, or isolation. Discover them with `0 --help` and read the relevant
documentation before running them.

## Local, hosted, and managed work

These modes are intentionally separate:

- **Local CLI:** 0sec runs on your machine with your provider credentials and
  your executor.
- **Hosted inference:** model requests may be handled by a compatible hosted
  service, while tools still run in the configured executor.
- **Managed work:** recurring scans, organization controls, service-side
  scheduling, and deployment guarantees require separately configured service
  access. Installing this repository does not enroll you in that service.

See the [getting started guide](https://docs.0.security/getting-started/),
[console guide](https://docs.0.security/console/),
[scan workflows](https://docs.0.security/scan-workflows/), and
[configuration reference](https://docs.0.security/configuration/) for details.

## Development

Use Node.js 24+, Bun 1.3.14 for the full terminal UI, and the repository-pinned
pnpm version:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/0sec.js --help
```

Useful checks for a README or documentation change:

```bash
pnpm docs:check
pnpm build:docs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for source setup, checks, fixture rules,
and pull-request expectations. Report security issues through [SECURITY.md](SECURITY.md).

## Status and scope

0sec is a research preview. Agent behavior, supported providers, event detail,
verification depth, and dashboard workflows are evolving. Treat generated
analysis and fixes as reviewable work. Keep the run database and reports when
you need an audit trail, and inspect warnings before interpreting a clean or
completed result.

## License

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE).
