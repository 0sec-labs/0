<p align="center">
  <a href="https://0.security/">
    <img src="assets/readme-cover.png" alt="Software already builds software. Now it can secure itself, too." width="100%">
  </a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/0-aperture-white.svg">
    <img src="assets/0-aperture-ink.svg" alt="0security" width="280">
  </picture>
</p>

<p align="center">
  <strong>The open-source, self-evolving, multi-model harness for security research.</strong><br/>
  <sub>The Swiss Applied AI &amp; Cybersecurity Research Lab</sub><br/>
  <a href="https://0.security/">0.security</a> ·
  <a href="https://docs.0.security/">Documentation</a> ·
  <a href="https://github.com/0sec-labs/foxguard">FoxGuard</a>
</p>


<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-1A1815?style=flat-square&labelColor=1A1815" alt="License: MIT OR Apache-2.0"></a>
  <a href="https://github.com/0sec-labs/0/releases/latest"><img src="https://img.shields.io/github/v/release/0sec-labs/0?style=flat-square&labelColor=1A1815&color=1A1815" alt="Latest release"></a>
  <a href="#status"><img src="https://img.shields.io/badge/status-research%20preview-FD802E?style=flat-square&labelColor=1A1815" alt="Status: research preview"></a>
</p>

<p align="center">
  <img src="assets/security-cycle-diagram.webp" alt="Zero studies, finds, fixes, reports, and improves." width="100%">
</p>


## The harness behind our research breakthroughs.

Find novel vulnerabilities in the deepest layers of software. Explore our
[public disclosures and upstream fixes](https://0.security/research/#disclosures),
including research in the Linux kernel.

## Get started

### Docs for your agent

Copy this prompt into your coding agent:

> Set up the 0.security harness using https://0.security/harness/setup.md and read https://0.security/llms.txt for the documentation index. Confirm my targets and scope before testing, and ask before changing files.

### Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | bash
0
```

Bring your model access and configure connections in the terminal. Run locally
or through the CLI in CI/CD, inspect findings and verification results, and
export reports as JSON, Markdown or SARIF.

[Setup guide](https://0.security/harness/setup.md) ·
[Research workflows](https://docs.0.security/research-workflows/) ·
[Documentation](https://docs.0.security/)

## Built for security research

- **Open research.** Benchmark-led agent design and A/B-tested attack strategies,
  with public findings that others can inspect.
- **Extensible tools.** Use the in-house security linter, connect your own tools,
  and let agents write and run tools for the investigation.
- **Adaptive agents.** Delegate focused investigations to subagents with fresh
  context and bounded budgets, then collect their findings. See the
  [agent loop](https://docs.0.security/agent-loop/) and
  [worker monitoring](https://docs.0.security/console/#monitoring-subagents).
- **Multi-model harness.** Bring the models you prefer into one security workflow.
  Combine deterministic steps with adaptive investigations.
- **Evaluated self-improvement.** Propose changes, evaluate them, and select better
  versions for future runs. Learn more about the
  [improvement plane](https://docs.0.security/improvement-plane/).

### Available on 0.security

**Optimized Model Routing: The best LLM for each step**

The managed service adds model routing, non-public frontier cyber models,
a purpose-built attack runtime and a curated offensive toolchain. These hosted
capabilities are separate from running the open-source harness with your own
model access. [Explore 0.security](https://0.security/).

## Make software secure itself.

The world's best security should belong to everyone. Software already writes
itself; we believe it should secure itself, too. Our goal is security that
finds and fixes vulnerabilities as software changes, so people can focus on
what they want to create.

Research comes first. Public disclosures, upstream fixes and reproducible
results let people check our work. Open tools let them question it, extend it
and build something better. Self-securing software is the future we're working
toward.

[Read our manifesto](https://0.security/about/) ·
[Explore our research](https://0.security/research/)

## Status

This is a research preview. Coverage and verification depth vary by workflow;
inspect the evidence and review generated fixes before applying them.
Tool making and evaluated self-improvement are developing research workflows.
Only test systems you own or are authorized to assess.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) to build and extend the harness.
Report security issues through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE).
