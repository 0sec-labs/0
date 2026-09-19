<p align="center">
  <a href="https://0.security/">
    <img src="assets/readme-cover.png" alt="Software already builds itself. Now it can secure itself, too. Zero looks over a mountain landscape." width="100%">
  </a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/0sec-aperture-white.svg">
    <img src="assets/0sec-aperture-ink.svg" alt="0security" width="320">
  </picture>
</p>

<p align="center">
  <strong>We make software secure itself.</strong><br/>
  Your self-improving, open-source cybersecurity team.
</p>

<p align="center">
  <a href="https://0.security/"><strong>0.security</strong></a><br/>
  <sub>The Swiss Applied AI &amp; Cybersecurity Research Lab</sub>
</p>

<p align="center">
  <a href="https://0.security"><img src="https://img.shields.io/badge/site-0.security-FD802E?style=flat-square&amp;labelColor=1A1815" alt="0.security"></a>
  <a href="https://docs.0.security/"><img src="https://img.shields.io/badge/docs-0.security-1A1815?style=flat-square&amp;labelColor=1A1815" alt="Documentation"></a>
  <a href="https://github.com/0sec-labs/foxguard"><img src="https://img.shields.io/badge/scanner-Foxguard-1A1815?style=flat-square&amp;labelColor=1A1815" alt="Foxguard scanner"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-1A1815?style=flat-square&amp;labelColor=1A1815" alt="License: MIT OR Apache-2.0"></a>
  <a href="https://github.com/0sec-labs/0sec/releases/latest"><img src="https://img.shields.io/github/v/release/0sec-labs/0sec?style=flat-square&amp;labelColor=1A1815&amp;color=1A1815" alt="Latest release"></a>
  <a href="#research-preview"><img src="https://img.shields.io/badge/status-research%20preview-FD802E?style=flat-square&amp;labelColor=1A1815" alt="Status: research preview"></a>
</p>

## How it works

<p align="center">
  <img src="assets/security-cycle-diagram.webp" alt="Illustrative workflow: Zero investigates, proposes fixes and reports the outcome, then repeats." width="100%">
</p>

An illustrated workflow, not an unattended outcome guarantee:

1. **Find.** Investigate code and authorized targets. Reproduce findings with the checks supported by each workflow.
2. **Fix.** Propose scoped source fixes and test candidates against an explicit regression command.
3. **Tell.** Review the findings, evidence and proposed changes.
4. **Repeat.** Run again as your code changes. Retain revision-aware codebase notes for later research.

The local CLI runs on demand. Managed recurring work needs separate service
access and configuration. Slack and GitLab delivery are planned.

## Get started

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0sec/main/install.sh | bash
export PATH="$HOME/.0sec/bin:$PATH"
0
```

Add the `export` line to your shell profile. Run `0` to open the interactive
console, or `0 --help` for commands. Only test systems you own or have permission to assess.

Connect your own model or provider credentials. A 0cloud account isn't required
for local use; model support varies by workflow. See [model connections](https://docs.0.security/api-keys/).

The interactive console defaults to YOLO, without per-action approval prompts.
Set explicit scope and exclusions before starting work. See
[configuration](https://docs.0.security/configuration/) for execution and isolation options.

Alternatively, with Node.js 24 or newer:

```bash
npm install -g 0sec-cli
0sec --help
```

The npm package is `0sec-cli`; its commands are `0sec` and `0`.
The standalone binary includes the full terminal UI. Running that UI from the
npm package or source requires Bun; Node supports the command-line workflows.

## Documentation

- [Getting started](https://docs.0.security/getting-started/): installation, source builds and your first scan.
- [Console](https://docs.0.security/console/) and [scan workflows](https://docs.0.security/scan-workflows/): interactive and command-line use.
- [Commands](https://docs.0.security/commands/) and [configuration](https://docs.0.security/configuration/): reference.
- [Build a Hackstore extension](https://docs.0.security/hackstore/): create a tool, test it locally, and publish it.
- [Integrations and CI](https://docs.0.security/integrations/) · [Troubleshooting](https://docs.0.security/troubleshooting/).

Docs follow the source checkout; use `0sec --version` and command-specific
`--help` when comparing an installed release with newly documented features.

## Research preview

Coverage and verification depth vary by workflow. Review the evidence before
treating an issue as confirmed; generated fixes need review and testing.
See [verification](https://docs.0.security/blind-verification/) for limits and prerequisites.

Agent learning, source evolution and executable plugins are also research-preview
workflows. See the [improvement-plane guide](https://docs.0.security/improvement-plane/).

## Contributing

Build instructions and contribution guidelines are in [CONTRIBUTING.md](CONTRIBUTING.md).
Report security issues through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE).
