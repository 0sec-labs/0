<p align="center">
  <a href="https://0.security/">
    <img src="assets/readme-cover.png" alt="Software already builds software. Now it can secure itself, too." width="100%">
  </a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/0sec-aperture-white.svg">
    <img src="assets/0sec-aperture-ink.svg" alt="0security" width="280">
  </picture>
</p>

<p align="center">
  <strong>Open-source cybersecurity research and tooling.</strong><br/>
  <sub>The Swiss Applied AI &amp; Cybersecurity Research Lab</sub><br/>
  <a href="https://0.security/">0.security</a> ·
  <a href="https://docs.0.security/">Documentation</a> ·
  <a href="https://github.com/0sec-labs/foxguard">FoxGuard</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-1A1815?style=flat-square&labelColor=1A1815" alt="License: MIT OR Apache-2.0"></a>
  <a href="https://github.com/0sec-labs/0sec/releases/latest"><img src="https://img.shields.io/github/v/release/0sec-labs/0sec?style=flat-square&labelColor=1A1815&color=1A1815" alt="Latest release"></a>
  <a href="#status"><img src="https://img.shields.io/badge/status-research%20preview-FD802E?style=flat-square&labelColor=1A1815" alt="Status: research preview"></a>
</p>

## Meet Zero

**Your AI security engineer.**

Zero is a multi-model, open-source cybersecurity CLI. Connect a model, run
authorized reviews and scans, inspect the evidence, and decide what happens
next. Local CLI work runs with your credentials and execution environment; this
repository is not a fully managed security service.

## Get started

Install the standalone release on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0sec/main/install.sh | bash
export PATH="$HOME/.0sec/bin:$PATH"
0 console --mode standard
```

In the console, use `/connect` and `/model`. For Node.js 24+ without the
interactive UI:

```bash
npm install -g 0sec-cli
0 --help
```

Run an authorized web scan with an explicit scope:

```bash
printf '%s\n' '{"in_scope":["app.example.com"]}' > scope.json
0 scan --target https://app.example.com --mode web --scope ./scope.json
```

Review a local repository:

```bash
0 review ./my-repository --runtime api --depth quick
```

Only assess systems you own or are authorized to test. Scope defines the target
boundary; it does not provide OS isolation.

## Useful commands

```bash
0 dashboard                 # local dashboard for scans and findings
0 history                   # saved runs
0 timeline <scan-id>        # run events
0 findings list             # findings and triage state
0 resume <scan-id>          # continue a saved run
0 doctor                    # check local setup
```

Use `0 <command> --help` for the installed release's exact options. Specialized
workflows are available through `0 --help` and may require extra engines,
credentials, fixtures, or isolation.

## Evidence and limits

Runs may be incomplete or wrong. Review findings, evidence, verification state,
warnings, and blocked work before treating a result as confirmed. Generated
fixes require review and testing. A completed process is not proof that every
finding was fixed.

Hosted inference and managed security work are separate from the local CLI.
Hosted inference may handle model requests while tools remain in your
configured environment. Recurring scans, organization controls, and service
operations require separate service access and onboarding.

## Documentation and development

- [Getting started](https://docs.0.security/getting-started/)
- [Console](https://docs.0.security/console/)
- [Scan workflows](https://docs.0.security/scan-workflows/)
- [Commands](https://docs.0.security/commands/)
- [Configuration](https://docs.0.security/configuration/)

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md)
to report security issues.

## Status

0sec is a research preview. Agent behavior, provider support, verification
depth, and supported workflows are evolving.

## License

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE).
