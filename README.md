<p align="center">
  <a href="https://0.security/">
    <img src="assets/readme-cover.png" alt="0security terminal security research workflow" width="100%">
  </a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/0-aperture-white.svg">
    <img src="assets/0-aperture-ink.svg" alt="0security" width="280">
  </picture>
</p>

<p align="center">
  <strong>Open-source security research in your browser, terminal, or coding agent.</strong><br/>
  <sub>Backed by Y Combinator · The Swiss Applied AI &amp; Cybersecurity Research Lab</sub><br/>
  <a href="https://0.security/">0.security</a> ·
  <a href="https://docs.0.security/">Documentation</a> ·
  <a href="https://github.com/0sec-labs/foxguard">FoxGuard</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-1A1815?style=flat-square&labelColor=1A1815" alt="License: MIT OR Apache-2.0"></a>
  <a href="https://github.com/0sec-labs/0/releases/latest">Latest release</a>
  <a href="#status-and-safety"><img src="https://img.shields.io/badge/status-research%20preview-FD802E?style=flat-square&labelColor=1A1815" alt="Status: research preview"></a>
</p>

<p align="center">
  <img src="assets/zero-manifesto-movement.webp" alt="Zero manifesto movement" width="100%">
</p>

## Get started

Install on Apple Silicon macOS or x64/ARM64 Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | bash
export PATH="$HOME/.0/bin:$PATH"
0 web
```

**Browser:** `0 web` · **Terminal:** `0`

<details>
  <summary>Preview the web app</summary>

### Chat

Review code, prioritize findings, and plan fixes in chat.

![Customer API security review in the Zero web app](assets/screenshots/web-chat.jpg)

### Workflows

Customize review phases, tools, and triggers.

![Customer API security workflow in the Zero web app](assets/screenshots/web-workflow.jpg)

</details>

## Use 0 from another agent

**CLI:** an agent with shell access can run a review and read its JSON report:

```bash
0 review /absolute/path/to/repo --format json > review.json
```

Configure 0's model provider first; the coding agent's model session is separate.

**MCP:** with operator-selected host-local execution, let an external agent discover templates and start managed workflows:

```bash
0 mcp-server --workflows --workspace /absolute/path/to/repo
```

The agent calls `list_templates`, `start_run`, `get_run`, and
`get_run_results`. Assessments use 0's configured provider. The stdio host owns
its runs; disconnect cancels active work. For live workflows, supply `--scope`
and enable the scope plugin in the host project with `0 plugin enable scope`.

For a registered remote engine, use `0 mcp-server --workflows --backend production`.
The engine owns execution, scope and model configuration; disconnecting the
client leaves remote runs active. Local execution flags are unavailable in this mode.

For individual live-target tools, select them explicitly:

```bash
0 mcp-server --target https://target.example.com --scan-id my-review \
  --scope /absolute/path/to/scope.json --tools http_request,crawl,query_findings
```

In browser chat, **Connect an external agent** copies an MCP setup prompt.
See [integrations](https://docs.0.security/integrations/) for client configuration
and [scope enforcement](https://docs.0.security/scope/) for target boundaries.

## Plugins

Connect GitHub, Elastic, Semgrep, Snyk, Linear, Jira, Cloudflare, Slack, and Teams.
Add custom tools through [plugins and MCP](https://docs.0.security/integrations/).

## Guides

- [Installation and quick start](https://docs.0.security/getting-started/)
- [Models and credentials](https://docs.0.security/api-keys/)
- [Chat, sessions and agents](https://docs.0.security/console/)
- [Integrations and service plugins](https://docs.0.security/integrations/)
- [Build and publish plugins](https://docs.0.security/hackstore/)
- [GitHub Actions](https://docs.0.security/ci/github-action/)
- [Troubleshooting](https://docs.0.security/troubleshooting/)

## Development

From a source checkout with dependencies installed, run `npm run dev` and open
the printed browser address. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status and safety

**Research preview.** Test only systems you own or are authorized to assess.
Review findings and generated fixes. The default terminal console uses YOLO mode;
run `0 console --mode standard` for tool-action confirmations. Enable the optional
[scope plugin](https://docs.0.security/scope/) to enforce target boundaries.

Report vulnerabilities through [SECURITY.md](SECURITY.md).
Licensed under [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE).

Built by the Swiss Applied AI & Cybersecurity Research Lab.
[Public disclosures and upstream fixes](https://0.security/research/#disclosures).
Thanks to [OpenTUI](https://github.com/anomalyco/opentui), [Bun](https://bun.sh/),
[React](https://react.dev/), [Models.dev](https://models.dev/),
[LiteLLM](https://github.com/BerriAI/litellm), and our contributors.
