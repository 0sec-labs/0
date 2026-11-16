---
title: Skills
description: Give the agent reusable instructions with standard skill folders.
---

A skill is a folder of instructions the agent loads when a task calls for it. A skill is not code. [Plugins](/plugins/) add tools, and a plugin can bundle skills. [Automations](/automations/) define the steps of a task, and you can use a skill in a thread or alongside an automation.

## Add a skill

1. Run `0` and open **Skills** in the sidebar. **Browse** lists skills from GitHub that you can add.
2. Press **New skill**, or import one with **Import**.
3. Ask the agent to use it, or let it discover the skill on its own.

The **Installed** tab lists your own skills first, then the bundled guides. The agent finds skills with `list_skills` and loads one with `load_skill`.

## From the command line

Everything on the Skills page has a command. With the app running they go through it; otherwise they use the same files directly.

```sh
0 skills list
0 skills list --catalog --search handoff
0 skills add mattpocock~skills~handoff --yes      # shows a review first; --yes installs that commit
0 skills import ./code-review --json              # a folder with SKILL.md, or an exported bundle
0 skills list code-review --edit --file ./SKILL.md
0 skills list code-review --export -o code-review.skill.json
0 skills link ~/team-skills                       # mount a folder without copying it
0 skills list code-review --delete --yes
```

## Folder format

0 reads the [Agent Skills format](https://agentskills.io/specification):

```text
code-review/
  SKILL.md
  scripts/
  references/
  assets/
```

`SKILL.md` has YAML frontmatter with `name` and `description`, then Markdown instructions. The other folders are optional. Resource paths resolve inside the skill folder. Mounting or importing a skill never runs its scripts.

```markdown
---
name: code-review
description: Review application code for security issues. Use for source reviews.
---

Trace input through the application and verify each finding against its caller.
```

## Where skills come from

0 discovers `.agents/skills` folders in the project and in your home directory, and `.claude/skills` for compatibility. **Mount folder** adds another folder on the computer without copying it. Changes to the original files show up automatically.

Local users and team owners can edit mounted, personal and project skills in place. Team editors customize a workspace copy instead.

## Edit, import and export

- **New skill** creates a workspace skill. **Edit** changes its instructions.
- **Customize** makes an editable copy of a built-in guide, or of a folder you cannot write to, and keeps its supporting files.
- **Import** takes a `SKILL.md` file, a skill folder (which keeps references, scripts and assets) or an exported skill.
- **Export** downloads `SKILL.md`, or all files as a bundle that another 0 workspace can import. The bundle is a 0 transport format, not one other agents read directly.
- The editor can open a thread about the skill. The agent reads the latest skill with `read_skill`, drafts with `create_skill`, and saves with `save_skill` or `copy_skill`. It uses the same permissions and revision checks as the editor.

Saves check the revision. If someone changes a skill while you edit, your draft stays open and the stale save is rejected. **Reload latest** replaces the draft with the current version.

## Teams

In a team workspace, created and imported skills are shared with the team. Editors can create and edit them. Viewers can browse and export. Only owners can mount host folders. Team workspaces do not pick up the host operator's personal skill folders.

## Limits

Folder mounting works with local thread execution. Mounted skills are not copied into SmolVM guests automatically.

## Next steps

- [Plugin security](/plugin-trust/#adding-skills-from-github): what to check before adding a skill from GitHub.
- [Agents](/agents/): give a standing agent the skills it should load.
- [Plugins](/plugins/): add tools, not instructions.

## Extensions

An extension is an installable folder, pinned to one git commit, that can bundle skills, scripts, MCP server definitions, a connector, a scope policy and a verifier. Scripts only ever run through bash, under the same scope, approvals and sandbox as any command. There is no second permission system.

### Install

```sh
0 skills add https://github.com/owner/repo@<full commit sha>
0 skills add ./my-extension
```

`0 skills add` looks at what the source contains and shows one prompt:

- `repo @ full commit`, the licence, the file list and any hidden Unicode.
- What it can do: runs commands (the scripts), connects to MCP servers (command or URL and environment variable names), calls a service (hosts and read/write list), defines a scope, receives environment variables.
- Claude `hooks`, `commands` and `agents` are shown as ignored. They never run.

Nothing is installed until you re-run with `--yes`. Add `--enable` to turn it on right away, with `--project <dir>` to limit it to one project. Branches, tags and short SHAs are refused: only the full 40-character SHA is stored. Installs are immutable and live in `~/.0/extensions/<name>/<sha>/`. A folder source has no commit, so its content hash is its version and any change asks again.

An extension can use `extension.json` (preferred), `.claude-plugin/plugin.json`, `plugin.json` with an optional `"0"` object (`connector`, `scope`, `verify`, `requires`), or just a `SKILL.md` folder. The first one found wins. The `connector` block is described in [Connect a service](/connect-a-service/#connector-reference).

### Update, enable, remove

```sh
0 skills extensions list
0 skills extensions info <name>
0 skills extensions update <name>                 # shows the diff and what changed in capabilities
0 skills extensions update <name> --to <sha> --yes
0 skills extensions enable <name> [--project <dir>]
0 skills extensions disable <name>
0 skills extensions remove <name> --yes
```

Third-party extensions never update by themselves. `update` fetches the newer commit, shows the folder diff and any new capability, and waits for you to approve that exact commit with `--yes --to <sha>`. Even one new script asks again. Built-in extensions (`scope`, `github`) ship inside the binary and update with it; they cannot be removed, and disabling one needs `--yes`.

### Safety

- A folder whose content no longer matches its pinned commit refuses to load.
- A repository's own `.0/` or `.claude/` folder can suggest extensions but never installs or enables one. Only approvals in `~/.0` count.
- An extension's scripts get a scrubbed environment plus only the names it declared and you approved. Model provider keys are never passed unless the prompt listed them.

### Moving from plugins

The first time you use the commands above, 0 imports what you already have and prints what it could not migrate. It never deletes anything. Skills you added from GitHub keep their pinned commit and approval. Custom MCP servers become local extensions that you re-approve before first use (secret values stay where they are). Plugins with executable tools and model-written plugins cannot run in the new system: they are listed, kept, and need to be rewritten as scripts or an MCP server. Run `0 skills extensions import` to see the report again.
