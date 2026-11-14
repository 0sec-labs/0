<p align="center">
  <a href="https://0.security/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/readme/header-dark.svg">
      <img src="assets/readme/header-light.svg" alt="0security" width="900">
    </picture>
  </a>
</p>

<h1 align="center">The open-source cybersecurity harness</h1>

<p align="center">
  <sub>By the Swiss Applied AI &amp; Cybersecurity Research Lab</sub>
</p>

<p align="center">
  <sub>Backed by</sub>
  <a href="https://www.ycombinator.com/companies/0security"><img src="assets/readme/y-combinator.png" alt="Y Combinator" width="116" height="24" align="middle"></a>
</p>

<p align="center">
  <a href="https://github.com/0sec-labs/0/releases/latest"><img src="https://img.shields.io/github/v/release/0sec-labs/0" alt="Latest release"></a>
  <a href="LICENSE-MIT"><img src="https://img.shields.io/badge/license-MIT%20%7C%20Apache--2.0-blue" alt="MIT or Apache-2.0 license"></a>
  <a href="https://github.com/0sec-labs/0/stargazers"><img src="https://img.shields.io/github/stars/0sec-labs/0?style=flat" alt="GitHub stars"></a>
</p>

<p align="center">
  0security automates vulnerability discovery, fixing and verification workflows.
</p>

<p align="center">
  <a href="https://docs.0.security/"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/readme/nav-docs-dark.svg"><img src="assets/readme/nav-docs-light.svg" alt="Documentation" height="48"></picture></a>
  <a href="https://0.security/research/"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/readme/nav-research-dark.svg"><img src="assets/readme/nav-research-light.svg" alt="Security research" height="48"></picture></a>
  <a href="#quick-start"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/readme/nav-install-dark.svg"><img src="assets/readme/nav-install-light.svg" alt="Install locally" height="48"></picture></a>
  <a href="https://0.security/enterprise/"><img src="assets/readme/enterprise-button.svg" alt="Enterprise" height="48"></a>
</p>

<p align="center">
  <a href="assets/readme-ui-demo.mp4">
    <picture>
      <img src="assets/readme-ui-demo.gif" alt="0 web UI: review a demo API, watch the investigation, then open findings with suggested fixes and verification" width="100%">
    </picture>
  </a>
</p>

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | bash
0
```

Prefer the terminal?

```bash
export ANTHROPIC_API_KEY="your-api-key"
0 scan source ./your-repo --runtime api --depth quick --cost-ceiling 2
```

<details>
<summary>Windows, Docker and source installs</summary>

- **Windows** (experimental): download `0-windows-x64.exe` from [Releases](https://github.com/0sec-labs/0/releases/latest).
- **Docker**: `docker run --rm ghcr.io/0sec-labs/0:latest --help`. See the [Docker guide](https://docs.0.security/docker/).
- **Source**: Node.js 24+ and pnpm, then `pnpm install --frozen-lockfile && pnpm build`.
- `install.sh` supports Apple Silicon macOS and x64/ARM64 Linux. Set `INSTALL_DIR` to change the location.

</details>

Only scan systems you own or are authorized to test. See [Scope & authorization](https://docs.0.security/scope/).

## What can you do with 0?

- **Find vulnerabilities** in source code, web apps and APIs, MCP endpoints and packages
- **Check dependencies** with `0 deps scan` and `0 deps fix` for npm, pnpm, Cargo and PyPI
- **Hunt variants** of a known fix across a codebase
- **Reverse engineer binaries** with Ghidra, plus kernel and memory-safety fuzzing
- **Map your attack surface**: domains, JavaScript, cloud and Entra ID posture
- **Verify and fix**: reproduce findings, generate patches and validate each one
- **Disclose**: assemble GHSA-ready advisory drafts from saved findings
- **Test AI agents** with prompt-injection campaigns
- **Automate** scans in [CI/CD](https://docs.0.security/ci/github-action/) with JSON and SARIF output
- **Extend** it with [plugins and skills](https://docs.0.security/plugins/), or drive it from coding agents over MCP

<p align="center">
  <a href="assets/readme-findings.mp4">
    <picture>
      <img src="assets/readme-findings.gif" alt="0 findings: review the queue, organize the board, and inspect source evidence" width="100%">
    </picture>
  </a>
</p>

## Why 0?

- **Open source**: MIT or Apache-2.0, built in the open
- **Private**: runs on your machine, in your CI or in a container, and only the context you send to your chosen model leaves it
- **Flexible**: any provider key or local OpenAI-compatible server, from the CLI, CI or a coding agent over MCP
- **Evidence first**: every finding links to its source evidence
- **Verified fixes**: patches are reproduced and validated before you apply them
- **Proven in public**: [disclosed vulnerabilities and upstream fixes](https://0.security/research/#disclosures), including in the Linux kernel

## CI and coding agents

```bash
0 automation run --template security-research \
  --target /absolute/path/to/repo --workspace /absolute/path/to/repo
0 mcp-server --automations --workspace /absolute/path/to/repo
```

See the [CI/CD guide](https://docs.0.security/ci/github-action/), [plugins and MCP](https://docs.0.security/plugins/) and the [command reference](https://docs.0.security/commands/).

## Learn more

- [Documentation](https://docs.0.security/)
- [Scan modules](https://docs.0.security/scans/)
- [Supported models and connections](https://docs.0.security/api-keys/)
- [CI/CD guide](https://docs.0.security/ci/github-action/)
- [Plugins and MCP](https://docs.0.security/plugins/)
- [Command reference](https://docs.0.security/commands/)
- [Security research](https://0.security/research/)
- [Enterprise](https://0.security/enterprise/)
- [Product index for AI agents](https://0.security/llms.txt)

## Contributing

**0 is built in the open.** Huge thanks to everyone who has filed a bug, fixed a doc or sent a patch.

- **Report bugs** in [issues](https://github.com/0sec-labs/0/issues)
- **Improve the docs**
- **Write a plugin** or scan module
- **Found a vulnerability in 0?** See [SECURITY.md](.github/SECURITY.md)

Start with the [contributing guide](.github/CONTRIBUTING.md). Run `pnpm install` and `pnpm dev` to work on the engine. Open an issue before large changes.

<a href="https://github.com/0sec-labs/0/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=0sec-labs/0" alt="Contributors to 0sec-labs/0" />
</a>

## License

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE). [Public disclosures and upstream fixes](https://0.security/research/#disclosures).
