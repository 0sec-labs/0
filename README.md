<p align="center">
  <a href="https://0.security/">
    <picture>
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
  <a href="https://0.security/enterprise/"><img src="assets/readme/enterprise-button.svg" alt="Enterprise" height="48"></a>
</p>

<p align="center">
  <a href="assets/readme-ui-demo.mp4">
    <picture>
      <img src="assets/readme-ui-demo.gif" alt="0 web UI: submit a demo API source scan, follow the investigation, and inspect findings with suggested fixes" width="100%">
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

Start with the **open-source CLI and local browser console** for security
investigations, evaluations, reverse engineering, and CI automations. Bring your
own model provider; no platform account is required.

For organization-wide automation and use-case integrations, explore
[Enterprise](https://0.security/enterprise/) or
[book a demo](https://0.security/contact/?intent=enterprise).

### Run 0 locally

Use the open-source harness for interactive investigations, security automations,
and agent integrations. Install on Apple Silicon macOS or x64/ARM64 Linux, then run `0`:

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | bash
export PATH="$HOME/.0/bin:$PATH"
0
```

`0` opens the local browser console without an account. Connect your own model
provider, investigate in the browser, or automate through the CLI and MCP.

Configure a [model provider](https://docs.0.security/api-keys/) to run AI scans and automations.
See [installation](https://docs.0.security/getting-started/) and
[troubleshooting](https://docs.0.security/troubleshooting/).

## Findings

Review source evidence and organize findings in a queue or on the board.

<p align="center">
  <a href="assets/readme-findings.mp4">
    <picture>
      <img src="assets/readme-findings.gif" alt="0 findings: review the queue, organize the board, and inspect source evidence" width="100%">
    </picture>
  </a>
</p>

## Scans and automations

Chat with 0 in the web UI, investigate findings, and use built-in templates for
scans, verification, fixes, and research. Save multi-step processes as automations. Runs retain results; Learning
keeps local activity and source-grounded notes.

<p align="center">
  <a href="assets/readme-workflows.mp4">
    <picture>
      <img src="assets/readme-workflows.gif" alt="0 automations: choose a template, inspect the automation graph, and edit a scan step" width="100%">
    </picture>
  </a>
</p>

For automation and coding agents, the CLI exposes the same automation runner:

```bash
0 automation list --templates
0 automation run --template security-research \
  --target /absolute/path/to/repo --workspace /absolute/path/to/repo
0 runs list
0 console -p "your request"
```

[Automation guide](https://docs.0.security/automations/) ·
[Learning](https://docs.0.security/learning/) ·
[GitHub Actions](https://docs.0.security/ci/github-action/)

## Hosts and plugins

Choose a host for your work. Connect service integrations and manage plugins.
Use ⌘K / Ctrl+K to jump between tools.

<p align="center">
  <a href="assets/readme-tools.mp4">
    <picture>
      <img src="assets/readme-tools.gif" alt="0 hosts and plugins: jump with keyboard search, choose a host, and browse integrations and plugins" width="100%">
    </picture>
  </a>
</p>

## Skills and memory

Reuse security instructions and retain lessons linked to the source.

<p align="center">
  <a href="assets/readme-memory.mp4">
    <picture>
      <img src="assets/readme-memory.gif" alt="0 skills and memory: browse built-in skills and inspect saved lessons with source references" width="100%">
    </picture>
  </a>
</p>

## Connect another agent

Use CLI commands or expose automations through MCP:

```bash
0 mcp-server --workflows --workspace /absolute/path/to/repo
```

Local MCP requires an explicitly selected host-local execution profile. Browser
chat's **Connect an external agent** provides a setup prompt. CLI and MCP automation
clients can share a running local engine's chats and runs.

[Plugins and MCP setup](https://docs.0.security/integrations/) ·
[Local and remote engines](https://docs.0.security/engine-connections/) ·
[Plugin development](https://docs.0.security/plugins/)

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
Each chat has its own scan state. `0 research binary ./target --mode scan --format ndjson` uses the same runtime.

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
