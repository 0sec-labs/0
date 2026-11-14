---
title: "Plugins and MCP servers: trust model"
description: What runs on your machine when you add a custom MCP server or install a plugin from GitHub, and what protects you.
---

Adding a custom MCP server or a plugin from a GitHub repository gives other
people's code a way to run as your user. 0 puts an explicit approval in front
of that, but it does not sandbox it.

## What runs where

- **stdio MCP server**: 0 starts the command you configured on the engine host
  whenever you press **Test** or a chat uses it. It is arbitrary code with your
  user's permissions. The environment is scrubbed to safe defaults plus the
  variables you declared, and loader variables such as `LD_PRELOAD`,
  `DYLD_*` and `NODE_OPTIONS` are rejected. The working directory is a
  relative path inside the chat workspace.
- **HTTP or SSE MCP server**: 0 connects to an `https` URL. Loopback, private
  and link-local hosts are refused unless allow-listed through
  `ZERO_ALLOWED_LOCAL_ORIGINS`, and DNS results are re-checked.
- **GitHub plugin**: a repository with `plugin.json` and `plugin.js`. Its tools
  run as local child processes after you enable them.
- MCP tools are treated like other network-capable tools and their output is
  untrusted data. They are not offered inside SmolVM chats.

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

## Who can do it

These routes are browser-only: engine-bearer (agent) callers get
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

Report problems through the [security policy](https://github.com/0sec-labs/0/blob/main/.github/SECURITY.md).
