---
title: Extensions
description: Add skills, scripts, MCP servers and connections to 0 as one reviewed, commit-pinned extension.
---

An extension is a git folder pinned to one commit. It can bundle [skills](/skills/), scripts the agent runs through bash, MCP servers, a [connection](/connect-a-service/) to a service, a scope policy and a verifier. There is no second runtime: its scripts and MCP servers are ordinary commands under the same approvals, [scope](/scope/) and sandbox as anything the agent runs. Themes are not extensions. Read [Security model](/security-model/#extensions-and-mcp) before adding third-party code.

## Add one

```sh
0 skills add owner/repo@<full 40-character commit>
0 skills extensions add ./my-extension
0 skills extensions mcp docs --url https://example.com/mcp
0 skills extensions mcp docs -- npx some-mcp-server@1.2.3
```

You always see one prompt first: the repository at the full commit, the licence, the files, hidden-Unicode flags and what it can do (commands it can run, MCP servers it connects to, services it calls, scope it defines). Nothing is installed without `--yes` from your own terminal, and a flag alone never approves. Without a pinned commit, `--yes` is refused. The browser app has the same flow on **Extensions**: **Add extension** takes a git source, **Add MCP server** takes a command or an https URL and creates a local extension that goes through the same prompt.

## Manage them

```sh
0 skills extensions list
0 skills extensions info <name>
0 skills extensions enable <name>
0 skills extensions disable <name>
0 skills extensions update <name>
0 skills extensions remove <name> --yes
```

An extension is installed disabled; enabling asks you to approve the exact revision once. `update` shows the folder diff and what it can now do, and asks again: any change re-prompts, even one new script, and nothing updates on its own. Built-in extensions (such as `scope`) update with the 0 binary.

`0 skills extensions info` also shows each MCP server's tools with the approved and last-seen hash. See [MCP servers](/mcp/#mcp-servers-in-extensions).

## Repo files are suggestions

A repository's `.0/` or `.claude/` folder (settings, `.mcp.json`, skills) never installs or enables an extension or MCP server. On first open the app shows what the repo asks for, with the install prompt for each; ignored means nothing runs. A plain `SKILL.md` is still read as instructions.

## From earlier plugins

The first start of this version imports your old data without changing or deleting it: installed GitHub plugins and model-authored plugins appear as disabled entries marked "could not migrate" (the executable `plugin.js` format is gone; re-express them as scripts or MCP servers), custom MCP servers become local extensions that need approval, token-only service connections become connector extensions, and your scope settings are kept. See `0 skills extensions import` for the report. The old plugin commands print where each one went.
