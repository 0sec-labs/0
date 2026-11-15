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
| Team workspace with owner, editor and viewer roles and OIDC sign-in | Yes, see [Computers and teams](/engines/) |
| Remote computers on your own servers | Yes, with limits listed on that page |
| Docker image | Yes, see [Docker](/docker/) |

Scans run on your computer, in your CI or on your servers. Model calls go to the provider you choose with your own key. 0security does not run scans or model calls for you.

## What leaves your computer

Nothing is uploaded with your findings, source code or model keys. The one automatic upload is the anonymous telemetry described below.

- **Findings, evidence and reports** stay in the local database under `~/.0/` and in files you export. Sharing a report is something you do.
- **Model calls** go to your configured provider.
- **Anonymous usage counts and crash reports** are sent automatically by official release builds. They hold finite counters and categories only, never targets, findings, code, prompts or error messages. Set `ZERO_NO_TELEMETRY=1` (or `DO_NOT_TRACK` or `ZERO_OFFLINE`) to turn both off, or use `0 config set analyticsLevel off` and `0 config set diagnosticReporting off`. Source and pull-request builds contain no destination and send nothing. See [Telemetry](/configuration/#telemetry) for the exact fields.
- **Updates and plugins** are fetched from GitHub when you install, upgrade or add a registry plugin.

## What the team workspace does not do

A team workspace shares one computer between members. It is not a multi-tenant service. Sessions are held in memory, so members sign in again after a restart, and results from several computers are not merged. See [Computers and teams](/engines/) for the exact limits.

## Enterprise

Enterprise is for organization-wide automation and use-case integrations around the same open-source engine. It is arranged with us rather than self-served. [Book a demo](https://0.security/contact/?intent=enterprise) to discuss your requirements.

This page describes what exists today. It does not list planned features.
