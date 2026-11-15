---
title: Plugin security
description: What runs on your machine when you add an MCP server or install a plugin, and what protects you.
---

Adding a custom MCP server or a plugin from GitHub lets other people's code run
as your user. 0 puts an explicit approval in front of that. It does not sandbox
it. Setup is in [MCP](/mcp/) and [Plugins](/plugins/).

## What runs where

- **stdio MCP server**: 0 starts the command you configured on the computer host
  whenever you press **Test** or a mission uses it. It is arbitrary code with your
  user's permissions. The environment is scrubbed to safe defaults plus the
  variables you declared, and loader variables such as `LD_PRELOAD`,
  `DYLD_*` and `NODE_OPTIONS` are rejected. The working directory is a
  relative path inside the mission workspace.
- **HTTP or SSE MCP server**: 0 connects to an `https` URL. Loopback, private
  and link-local hosts are refused unless allow-listed through
  `ZERO_ALLOWED_LOCAL_ORIGINS`, and DNS results are re-checked.
- **GitHub plugin**: a repository with `plugin.json` and `plugin.js`. Its tools
  run as local child processes after you enable them.
- MCP tools are treated like other network-capable tools and their output is
  untrusted data. They are not offered inside SmolVM missions.

## Approvals and fingerprints

Nothing runs on create or install.

1. **Preview**: the server returns an approval with a fingerprint of the exact
   command, arguments, working directory, environment variable names, URL and
   header names, plus warnings.
2. **Approve**: create, edit and enable requests must send that fingerprint
   back. If the configuration changed in between, the request fails with
   `409 approval_required`.
3. New servers are saved **disabled** unless you also enable them. Disabling
   never needs approval. Editing a code-relevant field resets the status to
   untested.

For GitHub plugins, the repository is fetched shallowly with no hooks,
submodules or LFS, and nothing is executed. 0 pins the **commit SHA**, shows
the manifest, requested capabilities and a **permission hash**, and installs
only if the SHA and hash still match the staged copy (the staged bytes are
re-hashed). The plugin is installed **not enabled**; enabling uses the normal
plugin capability approval. There is no auto-update: updating means running
the flow again, and widened permissions require a new approval.

## Secrets and logos

- Environment values and header values are **write-only**. Lists and previews
  return only the names. Deleting a server also deletes its stored secrets,
  and secrets are redacted from error text.
- Logos are always same-origin `data:` images. Remote icons declared by a
  registry are fetched by the server (https, public host, no redirects, at most
  32 KB, PNG up to 256 px or sanitised SVG) and cached. The browser never loads
  a remote logo.

## Adding skills from GitHub

A skill is text the agent follows with your permissions, so adding one is as
sensitive as adding a plugin. The Explore skills directory and **Add from GitHub
repository** share one flow:

- **Pinned snapshot.** The server resolves the repository to a full commit SHA,
  reads the skill folder at exactly that commit with your own `gh` login, and
  checks every file against its git object id. The browser never talks to GitHub.
- **Preview before adding.** You see the actual `SKILL.md`, the file list, the
  licence and the commit. Adding is an explicit click that echoes the reviewed
  SHA; a changed catalog pin is refused until you preview it again. Hidden
  Unicode, HTML comments and long encoded blocks are flagged in the preview.
- **No script execution.** Scripts in a skill folder are stored as files and
  never run by 0. Symbolic links and submodules are refused, `SKILL.md` is
  limited to 128 KiB, a folder to 128 files and 4 MiB, and an existing skill is
  never overwritten.
- **Never auto-update.** A skill stays at the commit you added. A newer commit
  means a new preview and a new click.
- **Provenance.** The repository, folder, commit, licence and time are stored
  next to the skill (not inside it, so upstream files cannot forge it) and each
  add or removal is written to the audit log (`skill.install`, `skill.remove`).
- **Verified by 0 is a listing, not an endorsement.** The badge on a directory
  entry means 0 curated the entry and pinned its commit. It does not prove who
  the publisher is or that the text is safe. Skills added from a repository you
  type in have no badge and go through the same preview.
- **Licences.** Skills under a known permissive licence (MIT, Apache-2.0, BSD,
  ISC, CC0, CC-BY, CC-BY-SA and similar) can be copied; the attribution is kept
  in the provenance record, and share-alike licences show "Share-alike: keep
  attribution". If no licence is declared, or it has custom terms, the skill is
  listed with **View on GitHub** and 0 does not copy it.

Previewing, adding and removing are browser-only routes (computer callers get
`403 browser_only`); in team mode viewers cannot add skills.

## Who can approve

Approval routes are browser-only: computer-bearer (agent) callers get
`403 browser_only`, so an agent cannot add or approve its own tools. In team
mode only the workspace owner can use them (`403 owner_required`).

## What is not protected

- An approved stdio server or enabled plugin can read your files, use your
  network and run other programs as your user. Approval is informed consent,
  not isolation.
- A GitHub SHA pin proves you got the code you reviewed, not that the code is
  safe. Review the repository, not just the manifest.
- An HTTP MCP server sees whatever the agent sends it, and its tool names,
  descriptions and results can contain prompt injection.
- Provider discovery and registry icon fetches reach out to external hosts.

Model-authored plugins are the exception: they run in a disposable Docker or smolvm guest with no network (see [Plugins](/plugins/#model-authored-plugins)).

## Next steps

- [Agents and MCP](/mcp/): add an MCP server or service connection.
- [Plugins](/plugins/): install, build and submit plugins.
- [Skills](/skills/): skill folders and where they come from.

Report problems through the [security policy](https://github.com/0sec-labs/0security/blob/main/.github/SECURITY.md).
