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
| Reproduction, verification and repair | [Verification Results](/verification-result/) and [`secure`](/commands/#secure) |
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

## 0cloud

[0cloud](https://cloud.0.security/) provides hosted PR security reviews.
Its accounts, integrations and deployment are separate from local CLI model
connections. See [Integrations](/integrations/) for local automation.

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
