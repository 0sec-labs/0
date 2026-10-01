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
  <a href="https://github.com/0sec-labs/0/releases/latest"><img src="https://img.shields.io/github/v/release/0sec-labs/0?style=flat-square&labelColor=1A1815&color=1A1815" alt="Latest release"></a>
  <a href="#status-and-safety"><img src="https://img.shields.io/badge/status-research%20preview-FD802E?style=flat-square&labelColor=1A1815" alt="Status: research preview"></a>
</p>

## Get started

Install on Apple Silicon macOS or x64/ARM64 Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | bash
export PATH="$HOME/.0/bin:$PATH"
0 web
```

Connect a model provider, open a chat, and describe the repository or system you
want to investigate. Use **Workflows** for reusable reviews and **Plugins** to
connect your tools. Prefer the terminal? Run `0`.

## Use 0 from another agent

**CLI:** an agent with shell access can run a review and read its JSON report:

```bash
0 review /absolute/path/to/repo --format json > review.json
```

Configure 0's model provider first; the coding agent's model session is separate.

**MCP:** give an agent selected live-target tools through a local stdio server:

```bash
0 mcp-server --target https://target.example.com --scan-id my-review \
  --scope /absolute/path/to/scope.json --tools http_request,crawl,query_findings
```

In browser chat, **Onboard your agent** copies a setup prompt for your MCP client.
MCP exposes target tools; it does not control browser chats or run the full CLI.
See [integrations](https://docs.0.security/integrations/) for client configuration
and [scope enforcement](https://docs.0.security/scope/) for target boundaries.

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
