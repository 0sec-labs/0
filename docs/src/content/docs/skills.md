---
title: Skills
description: Give the agent reusable instructions with standard skill folders.
---

A skill is a folder of instructions the agent loads when a task calls for it. A skill is not code. [Extensions](/extensions/) add scripts, MCP servers and connections, and an extension can bundle skills. [Automations](/agents/#automations) define the steps of a task. The nine CLI commands are fixed entry points, not skills; see [Threads](/threads/#commands-skills-and-workflows).

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

## Adding skills from GitHub

A skill is text the agent follows with your permissions, so adding one is as sensitive as adding an extension. **Skills → Browse** and **Add from GitHub repository** resolve the repository to a full commit SHA, read the skill folder at exactly that commit with your own `gh` login, and check every file against its git object id. You see the actual `SKILL.md`, the file list, the licence and the commit before an explicit click adds it; hidden Unicode, HTML comments and long encoded blocks are flagged. Scripts in a skill folder are stored but never run by 0. Symbolic links and submodules are refused, `SKILL.md` is limited to 128 KiB, a folder to 128 files and 4 MiB, and an existing skill is never overwritten. A skill stays at the commit you added until you preview and add a newer one. Provenance is stored next to the skill and each add or removal is written to the audit log. Skills without a permissive licence are listed with **View on GitHub** and are not copied.

Folder mounting works with local thread execution; mounted skills are not copied into SmolVM guests automatically.

## Next steps

- [Security model](/configuration/#security-model): what protects you from third-party code and text.
- [Agents](/agents/): give a standing agent the skills it should load.
- [Extensions](/extensions/): add tools, not only instructions.
