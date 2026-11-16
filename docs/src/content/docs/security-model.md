---
title: Security model
description: What runs on your computer when you add an extension, an MCP server or a skill, and what protects you.
---

0 runs as you, with bash. The agent can do what you can do in a terminal; the defences are scope, approvals, the sandbox when you use one, and the prompts below. This page covers third-party code and text: extensions, MCP servers and skills.

## Extensions and MCP

An extension or MCP server you add runs other people's code as your user. 0 puts an explicit review in front of it. It does not sandbox it. Setup is in [Extensions](/extensions/) and [MCP](/mcp/).

- **Pinned by commit.** A git extension is fetched without running anything and pinned to a full 40-character commit. Branches, tags and short SHAs are refused. The installed folder is hashed; if it changes on disk, it is blocked until you review it again. Local folders are pinned by content hash.
- **The install prompt.** It shows `repo @ commit`, the licence, the file list, hidden-Unicode flags and what the extension can do: scripts it ships, MCP servers (command or URL, variable names), services it calls (hosts, read or write) and any scope it defines. The click echoes the commit, and the server re-checks that the revision it installs is the one you saw. Approving is the operator's: an agent session or a command without a terminal is refused. The audit log records `extension.install` with the commit and capabilities.
- **Updates re-prompt.** Any change, even one new script, shows the folder diff and a capability delta and asks again. There is no silent auto-update of third-party extensions. Built-ins update with the binary.
- **Per-tool MCP pins.** The first time an MCP server connects you approve its tools; 0 stores a sha256 of each tool's name, description, input schema and annotations. If any tool is changed, new or removed, the whole server is blocked until you approve again. MCP servers start only when the model first loads them, run through `beforeCommand` (your scope and approvals), and their output is labelled untrusted and capped. Details are in [MCP servers in extensions](/mcp/#mcp-servers-in-extensions).
- **Environment allowlist.** A process gets a scrubbed environment plus only the variable names the extension declared and you approved. Provider keys are never passed unless declared and shown in the prompt. Loader variables (`LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS`) are always rejected. A connection token reaches only a declared variable.
- **Repo config is a suggestion.** A repository's `.0/` or `.claude/` files cannot install or enable anything.
- **Network.** Remote MCP servers need https (plain http only to loopback); hosts that resolve to private, loopback, link-local or metadata addresses are refused and redirects are not followed.

### Residual risk

- An approved extension or MCP server can read your files, use your network and run programs as your user. Approval is informed consent, not isolation. Use a Computer or SmolVM when you need isolation.
- A commit pin proves you got the code you reviewed, not that it is safe. Review the repository, not only the manifest.
- There are no signatures or publisher identity. A catalog entry marked verified means 0 curated it and pinned its commit.
- An MCP server sees what the agent sends it, and its tool names, descriptions and results can contain prompt injection.

## Adding skills from GitHub

A skill is text the agent follows with your permissions, so adding one is as sensitive as adding an extension. The **Skills → Browse** directory and **Add from GitHub repository** share one flow:

- **Pinned snapshot.** The server resolves the repository to a full commit SHA, reads the skill folder at exactly that commit with your own `gh` login, and checks every file against its git object id. The browser never talks to GitHub.
- **Preview before adding.** You see the actual `SKILL.md`, the file list, the licence and the commit. Adding is an explicit click that echoes the reviewed SHA; a changed catalog pin is refused until you preview it again. Hidden Unicode, HTML comments and long encoded blocks are flagged.
- **No script execution.** Scripts in a skill folder are stored as files and never run by 0. Symbolic links and submodules are refused, `SKILL.md` is limited to 128 KiB, a folder to 128 files and 4 MiB, and an existing skill is never overwritten.
- **Never auto-update.** A skill stays at the commit you added. A newer commit means a new preview and a new click.
- **Provenance.** Repository, folder, commit, licence and time are stored next to the skill, and each add or removal is written to the audit log (`skill.install`, `skill.remove`).
- **Licences.** Skills under a known permissive licence can be copied, with attribution kept in the provenance record. If no licence is declared, or it has custom terms, the skill is listed with **View on GitHub** and 0 does not copy it.

## Who can approve

Approval routes are browser-only: agent callers get `403 browser_only`, so an agent cannot add or approve its own tools. In team mode only the workspace owner can use them (`403 owner_required`).

Report problems through the [security policy](https://github.com/0sec-labs/0security/blob/main/.github/SECURITY.md).
