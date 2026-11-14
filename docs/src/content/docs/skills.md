---
title: Skills
description: Give the agent reusable instructions with standard skill folders.
---

A skill is a folder of instructions the agent loads when a task calls for it. A skill is one kind of [plugin](/plugins/). [Automations](/automations/) define the steps of a run, and a skill can be used in a chat or alongside one.

## Add a skill

1. Run `0` and open **Plugins**, then **Skills**.
2. Press **New skill**, or import one with **Import**.
3. Ask the agent to use it, or let it discover the skill on its own.

The **Built in** tab keeps bundled guides apart from your own collection. The agent finds skills with `list_skills` and loads one with `load_skill`.

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

0 discovers `.agents/skills` folders in the project and in your home directory, and `.claude/skills` for compatibility. **Mount folder** adds another folder on the engine computer without copying it. Changes to the original files show up automatically.

Local users and team owners can edit mounted, personal and project skills in place. Team editors customize a workspace copy instead.

## Edit, import and export

- **New skill** creates a workspace skill. **Edit** changes its instructions.
- **Customize** makes an editable copy of a built-in guide, or of a folder you cannot write to, and keeps its supporting files.
- **Import** takes a `SKILL.md` file, a skill folder (which keeps references, scripts and assets) or an exported skill.
- **Export** downloads `SKILL.md`, or all files as a bundle that another 0 workspace can import. The bundle is a 0 transport format, not one other agents read directly.
- The editor has a chat. It reads the latest skill with `read_skill`, drafts with `create_skill`, and saves with `save_skill` or `copy_skill`. It uses the same permissions and revision checks as the editor.

Saves check the revision. If someone changes a skill while you edit, your draft stays open and the stale save is rejected. **Reload latest** replaces the draft with the current version.

## Teams

In a team workspace, created and imported skills are shared with the team. Editors can create and edit them. Viewers can browse and export. Only owners can mount host folders. Team workspaces do not pick up the host operator's personal skill folders.

## Limits

Folder mounting works with local chat execution. Mounted skills are not copied into SmolVM guests automatically.
