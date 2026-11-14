# Plugins: one concept

Status: decided vocabulary; manifest shape below is a PROPOSAL, not implemented.

## Decision

A plugin is the only installable unit in 0. "Extensions", "service plugins",
"connectors" and "MCP & plugins" as a page title are retired. The console page
is called **Plugins**.

## Kinds

| Kind label | What it is |
| --- | --- |
| Tool plugin | Executable plugin that contributes tools (sandboxed, permission-gated) |
| MCP server | A plugin that contributes an MCP server; third-party connectors (GitHub, Slack, ...) are MCP server plugins |
| Skill pack | A plugin that contributes skills only |
| Research pack | First-party plugin bundling research modules (identity, adgraph, xnu-fuzz, later improve/bench) |

A plugin may contribute several things; the kind label names its primary one.

## Proposed manifest `contributes`

```json
{
  "id": "example",
  "contributes": {
    "tools": [],
    "skills": [],
    "mcpServers": [],
    "commands": [],
    "stages": []
  }
}
```

`stages` (pipeline stages) comes last and depends on the playbook runner.
Install, trust, fingerprint approval and permission-hash rules apply uniformly
to every contribution type.

## Editions

Research packs make two editions possible: `core` (small binary, packs fetched
on demand from pinned releases) and `full` (packs bundled). First-party packs
stay trusted-first-party-only until real signature verification ships.

## Unchanged now

File names, API routes (`/api/console/plugins`, `/api/console/service-plugins`,
`/plugins`), `0 plugin` commands and flags, the registry `extensions/<id>/`
directory layout, the `allowModelSelfExtension` setting key, and the existing
manifest format. Only user-facing labels and docs change.
