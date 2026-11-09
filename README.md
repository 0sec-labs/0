<p align="center">
  <a href="https://0.security/">
    <picture>
      <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="assets/readme/header-dark-static.svg">
      <source media="(prefers-reduced-motion: reduce)" srcset="assets/readme/header-light-static.svg">
      <source media="(prefers-color-scheme: dark)" srcset="assets/readme/header-dark.svg">
      <img src="assets/readme/header-light.svg" alt="0security" width="900">
    </picture>
  </a>
</p>

<h1 align="center">The open-source AI security harness</h1>

<p align="center">
  <sub>Backed by</sub>
  <a href="https://www.ycombinator.com/companies/0security"><img src="assets/readme/y-combinator.png" alt="Y Combinator" width="116" height="24" align="middle"></a>
</p>

<p align="center">
  Investigate vulnerabilities, review findings, and work on fixes in your browser.<br/>
  Use your own model provider. Connect coding agents through CLI or MCP.
</p>

<p align="center">
  <a href="https://docs.0.security/"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/readme/nav-docs-dark.svg"><img src="assets/readme/nav-docs-light.svg" alt="Documentation" height="48"></picture></a>
  <a href="https://0.security/research/"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/readme/nav-research-dark.svg"><img src="assets/readme/nav-research-light.svg" alt="Security research" height="48"></picture></a>
  <a href="#run-0-locally"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/readme/nav-install-dark.svg"><img src="assets/readme/nav-install-light.svg" alt="Install locally" height="48"></picture></a>
  <a href="https://cloud.0.security/signup?provider=github"><picture><source media="(prefers-reduced-motion: reduce)" srcset="assets/readme/cloud-button-static.svg"><img src="assets/readme/cloud-button.svg" alt="0cloud — sign up with GitHub" height="48"></picture></a>
</p>

<p align="center">
  <a href="assets/readme-ui-demo.mp4">
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcset="assets/readme-ui-demo.jpg">
      <img src="assets/readme-ui-demo.gif" alt="0 web UI: submit a demo API source review, follow the investigation, and inspect findings with suggested fixes" width="100%">
    </picture>
  </a>
</p>

<details>
<summary>Watch the 45-second harness launch film</summary>

https://github.com/user-attachments/assets/b0f0facd-a8bf-4642-91c7-31c0612e499e

</details>

<p align="center">
  <sub>The Swiss Applied AI &amp; Cybersecurity Research Lab</sub>
</p>

## Get started

Use **[0cloud](https://cloud.0.security/signup?provider=github)** for managed security reviews on your
GitHub pull requests, or **[run 0 locally](#run-0-locally)** with your own model provider.

### PR security reviews with 0cloud

Connect your GitHub repositories to **0cloud**, the hosted service from 0.security.
It checks pull requests with deterministic scanning and AI agents, runs targeted
tests in a sandbox, and posts findings with evidence and suggested fixes.
Review the findings and apply fixes from the same PR.

<p align="center">
  <a href="https://cloud.0.security/signup?provider=github">
    <picture>
      <source media="(max-width: 600px) and (prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="assets/readme/cloud-flow-mobile-dark-static.svg">
      <source media="(max-width: 600px) and (prefers-reduced-motion: reduce)" srcset="assets/readme/cloud-flow-mobile-light-static.svg">
      <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="assets/readme/cloud-flow-mobile-dark.svg">
      <source media="(max-width: 600px)" srcset="assets/readme/cloud-flow-mobile-light.svg">
      <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="assets/readme/cloud-flow-dark-static.svg">
      <source media="(prefers-reduced-motion: reduce)" srcset="assets/readme/cloud-flow-light-static.svg">
      <source media="(prefers-color-scheme: dark)" srcset="assets/readme/cloud-flow-dark.svg">
      <img src="assets/readme/cloud-flow-light.svg" alt="0cloud: connect a pull request, investigate security issues, review and apply fixes" width="100%">
    </picture>
  </a>
</p>

**[Start with 0cloud →](https://cloud.0.security/signup?provider=github)** ·
[How it works](https://0.security/) · [Pricing](https://0.security/pricing/)

### Run 0 locally

Use the open-source harness for interactive investigations, security workflows,
and agent integrations. Install on Apple Silicon macOS or x64/ARM64 Linux, then run `0`:

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | bash
export PATH="$HOME/.0/bin:$PATH"
0
```

`0` opens the local browser console without an account. Connect your own model
provider, investigate in the browser, or automate through the CLI and MCP.

Configure a [model provider](https://docs.0.security/api-keys/) to run AI workflows.
See [installation](https://docs.0.security/getting-started/) and
[troubleshooting](https://docs.0.security/troubleshooting/).

## Findings

Review source evidence and organize findings in a queue or on the board.

<p align="center">
  <a href="assets/readme-findings.mp4">
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcset="assets/readme-findings.jpg">
      <img src="assets/readme-findings.gif" alt="0 findings: review the queue, organize the board, and inspect source evidence" width="100%">
    </picture>
  </a>
</p>

## Security workflows

Chat with 0 in the web UI, investigate findings, and use built-in templates for
assessment, verification, fixes, and research. Runs retain results; Learning
keeps local activity and source-grounded notes.

<p align="center">
  <a href="assets/readme-workflows.mp4">
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcset="assets/readme-workflows.jpg">
      <img src="assets/readme-workflows.gif" alt="0 workflows: choose a template, inspect the workflow graph, and edit a review step" width="100%">
    </picture>
  </a>
</p>

For automation and coding agents, the CLI exposes the same workflow runner:

```bash
0 workflow list --templates
0 workflow run --template security-research \
  --target /absolute/path/to/repo --workspace /absolute/path/to/repo
0 runs list
0 chat --prompt "your request"
```

[Workflow guide](https://docs.0.security/workflow/) ·
[Learning](https://docs.0.security/learning/) ·
[GitHub Actions](https://docs.0.security/ci/github-action/)

## Hosts and plugins

Choose a host for your work. Connect service integrations and manage extensions.
Use ⌘K / Ctrl+K to jump between tools.

<p align="center">
  <a href="assets/readme-tools.mp4">
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcset="assets/readme-tools.jpg">
      <img src="assets/readme-tools.gif" alt="0 hosts and plugins: jump with keyboard search, choose a host, and browse integrations and extensions" width="100%">
    </picture>
  </a>
</p>

## Skills and memory

Reuse security instructions and retain lessons linked to the source.

<p align="center">
  <a href="assets/readme-memory.mp4">
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcset="assets/readme-memory.jpg">
      <img src="assets/readme-memory.gif" alt="0 skills and memory: browse built-in skills and inspect saved lessons with source references" width="100%">
    </picture>
  </a>
</p>

## Connect another agent

Use CLI commands or expose workflows through MCP:

```bash
0 mcp-server --workflows --workspace /absolute/path/to/repo
```

Local MCP requires an explicitly selected host-local execution profile. Browser
chat's **Connect an external agent** provides a setup prompt. CLI and MCP workflow
clients can share a running local engine's sessions and runs.

[Plugins and MCP setup](https://docs.0.security/integrations/) ·
[Local and remote engines](https://docs.0.security/engine-connections/) ·
[Plugin development](https://docs.0.security/hackstore/)

For AI agents: [product index](https://0.security/llms.txt) ·
[command reference](https://docs.0.security/commands/).

## Development

Install dependencies with `pnpm install`, run `npm run dev`, and open the printed
browser address. The dashboard updates with hot reload.
See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

For local binary analysis, run `npm run setup:0verse` once. It discovers a local
Ghidra and Java installation, installs the Python analysis/MCP dependencies
without removing existing engines, and verifies the decompiler. In this source
checkout, web and terminal chats automatically connect the local 0verse MCP
server. Nine tools cover scanning, triage, preflight, bug classes, findings,
PoVs, reports, memory recall, and capability discovery. The capability catalog
also lists research CLI commands with their MCP-supported or CLI-only status.
Each chat has its own scan state. `0 binary ./target --mode scan --format ndjson` uses the same runtime.

This does not install every platform executor or fuzzing environment. Inspect
0verse's capability report before requesting confirmation; unavailable analysis
is not a clean scan. An explicit `ZERO_MCP` configuration takes precedence, and
`ZERO_0VERSE_MCP=0` disables automatic connection.


## Status and safety

Assess only authorized systems and review findings and fixes.
Use `--mode standard` with headless chat for explicit scope checks. The optional
[scope plugin](https://docs.0.security/scope/) enforces target boundaries.

Report vulnerabilities through [SECURITY.md](.github/SECURITY.md).
Licensed under [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE).

[Public disclosures and upstream fixes](https://0.security/research/#disclosures).
