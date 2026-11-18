---
title: Changelog
description: Where release notes live and the migration note for the 0.36 extension change.
---

The full history is in [`docs/CHANGELOG.md`](https://github.com/0sec-labs/0security/blob/main/docs/CHANGELOG.md), with a summary per release from v0.11.0 on. Each release also has notes on the [GitHub Releases](https://github.com/0sec-labs/0security/releases) page. This page keeps the migration note that people still need.

## Moving to extensions (0.36)

Version 0.36 replaced the old plugin system with [extensions](/extensions/): one installable, commit-pinned unit for skills, scripts, MCP servers, and connectors. The first start imports your old data without changing or deleting it, and `0 skills extensions import` prints the report again. Installed GitHub plugins and model-written plugins appear as disabled entries marked "could not migrate" (re-express them as scripts or MCP servers), custom MCP servers become local extensions that need approval, and token-only service connections become connector extensions that need approval and a new token.
