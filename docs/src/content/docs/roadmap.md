---
title: Roadmap
description: Current product entry points and development priorities.
---

Use the linked guides for current behavior. Check `0 --version` and
`0 <command> --help` when your installed release differs from the source checkout.

## Current workflows

| Work | Guide |
| --- | --- |
| Interactive investigations in the browser | [Console](/console/) |
| Source, web and package assessments | [Scan Workflows](/scan-workflows/) |
| Model connections and role assignments | [Configuration](/configuration/) and [API Keys](/api-keys/) |
| Reproduction, verification and repair | [Verification Results](/verification-result/) and [`scan repair`](/commands/#scan-repair) |
| Findings, retained evidence and triage | [Finding Triage](/triage/) and [Assessment Reports](/assessment-reports/) |
| CI and coding-agent integrations | [Integrations](/integrations/) and [GitHub CI](/ci/github-action/) |
| Binary, kernel and specialist research | [Research Workflows](/research-workflows/) |
| Extensions and evaluated improvements | [Hackstore](/hackstore/) and [Improvement Plane](/improvement-plane/) |

## Development priorities

- **Reliable execution:** preserve results on failure, report cancellation
  truthfully, and make saved work recoverable. Resume behavior depends on the
  producer; an interrupted tool is not automatically safe to replay.
- **Usable evidence:** connect a candidate finding to its reproduction, verdict
  and fix verification. Completion and triage labels do not establish proof.
- **Clear orchestration:** show active tools, background workers and pending
  questions in the browser. Separate worker contexts share the selected
  execution environment and provider restrictions.
- **Measured improvements:** qualify optional routing and research strategies
  against retained controls before changing defaults. See
  [Benchmarks](/benchmark/) and [Methodology](/methodology/) for existing results.

<span id="0cloud"></span>
## Enterprise platform

0 follows an open-core direction: the open-source CLI, local browser console,
CI workflows, and MCP integrations are the starting point. Zero Cloud is retired
as a product direction; there is no separate hosted self-serve signup offer.

The enterprise direction adds organization-wide automation and use-case
extensions around that core. Priorities include reusable assessment and eval
workflows, shared evidence review, policy and integration management, and
specialist workflows for source, binary, and reverse-engineering work.
Commercial packaging, deployment options, and individual enterprise features
require qualification with the team; this direction is not a release claim.
Existing private service implementations do not automatically use the public
engine or establish feature parity.

### Developer experience priorities

- Keep CLI, MCP, and browser work connected through the selected engine's
  sessions, runs, findings, and evidence. See [Engine Connections](/engine-connections/).
- Make trusted CI runs reproducible, with explicit configuration, retained
  outputs, and clear failure handling. See [GitHub CI](/ci/github-action/).
- Make evals and regression checks easy to repeat and compare; qualify changes
  against retained baselines rather than treating a completed run as success.
- Extend specific use cases through tools, templates, skills, and plugins.
  Existing extension support is documented in [Integrations](/integrations/).
- Keep reverse engineering in the same investigation workflow, with explicit
  decompiler/executor prerequisites and evidence limits. See
  [Code & Binary Analysis](/code-and-binary-analysis/).

[Contact the team](https://0.security/contact/?intent=contact) about enterprise
requirements and deployment.

## Desktop

Desktop is a development-only alpha. Public installers, npm packages and native
releases ship the CLI and browser console. Contributors can build desktop from
source; see [Desktop](/desktop/). The interactive terminal UI is retired.

<span id="implemented-pending-release"></span>
<span id="recently-shipped-april-2026"></span>
<span id="now"></span>
<span id="later"></span>
<span id="non-goals-right-now"></span>
<span id="product-direction"></span>
## Earlier plans

Dated planning snapshots remain in this page's Git history. They are not current
release commitments. Historical benchmark records and their limitations are
maintained in the benchmark and methodology guides linked above.
