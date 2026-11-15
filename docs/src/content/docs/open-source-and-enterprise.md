---
title: Open source and Enterprise
description: What is open source in 0, what you can run on your own, what leaves your computer, and what Enterprise adds.
---

0 is open source under MIT OR Apache-2.0. The CLI, the engine, the browser app, the GitHub Action and the team workspace are all in the [`0sec-labs/0security`](https://github.com/0sec-labs/0security) repository. Nothing in them needs an account, a license key or a 0security-hosted service.

## What you get in the open-source version

| | Included |
|---|---|
| Scans of source, web targets and packages, with verification and fixes | Yes, with your own model keys |
| Browser app, automations, agents and skills | Yes |
| Findings and reports (JSON, SARIF, Markdown, HTML, PDF) | Yes |
| GitHub Action and CI reports, `0 reports import` | Yes, see [CI/CD](/ci/github-action/) |
| Findings API for your own tools | Yes, read-only, see [Findings API](/findings-api/) |
| Team workspace with owner, editor and viewer roles and OIDC sign-in | Yes, see [Remote engines and teams](/engines/) |
| Remote engines on your own servers | Yes, with limits listed on that page |
| Docker image | Yes, see [Docker](/docker/) |

Scans run on your computer, in your CI or on your servers. Model calls go to the provider you choose with your own key. 0security does not run scans or model calls for you.

## What leaves your computer

By default, nothing is uploaded with your findings, source code or model keys.

- **Findings, evidence and reports** stay in the local database under `~/.0/` and in files you export. Sharing a report is something you do.
- **Model calls** go to your configured provider.
- **Usage analytics** are only sent when a 0security cloud token is configured (`ZERO_CLOUD_TOKEN` or `~/.0/cloud.env`). Without one, nothing is sent. With one, the default level is usage counts only. Set `ZERO_ANALYTICS_LEVEL=off`, or set `ZERO_OFFLINE`, `ZERO_NO_TELEMETRY` or `DO_NOT_TRACK`, to turn it off. Any of the last three overrides the level.
- **Updates and plugins** are fetched from GitHub when you install, upgrade or add a registry plugin.

## What the team workspace does not do

A team workspace shares one engine between members. It is not a multi-tenant service. Sessions are held in memory, so members sign in again after a restart, and results from several engines are not merged. See [Remote engines and teams](/engines/) for the exact limits.

## Enterprise

Enterprise is for organization-wide automation and use-case integrations around the same open-source engine. It is arranged with us rather than self-served. [Book a demo](https://0.security/contact/?intent=enterprise) to discuss your requirements.

This page describes what exists today. It does not list planned features.
