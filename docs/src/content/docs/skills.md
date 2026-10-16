---
title: Skills
description: Use reusable agent instructions from standard skill folders.
---

Skills teach the agent how to perform a task. Workflows define the steps of a run. Plugins connect tools and services. You can use a skill in a chat or alongside a workflow.

Open **Skills** in the sidebar to browse installed folders and workspace skills. The **Built in** tab keeps bundled guides separate from your installed collection. The agent discovers these through `list_skills` and loads the instructions with `load_skill` when needed.

## Skill folders

0 reads the [Agent Skills format](https://agentskills.io/specification):

```text
code-review/
  SKILL.md
  scripts/
  references/
  assets/
```

`SKILL.md` contains YAML frontmatter with `name` and `description`, followed by Markdown instructions. The other folders are optional. Resource paths resolve relative to the skill folder; mounting or importing a skill does not run its scripts.

```markdown
---
name: code-review
description: Review application code for security issues. Use for source reviews.
---

Trace input through the application and verify each finding against its caller.
```

0 discovers project and personal `.agents/skills` folders, plus `.claude/skills` for compatibility. **Mount folder** adds another folder on the engine computer without copying its files. Local users and team owners can edit mounted, personal, and project skills in place. Changes to the original files are discovered automatically. Team editors can customize a workspace copy instead.

## Create, edit, and share

**New skill** creates a workspace skill. **Edit** updates its instructions; **Customize** creates an editable copy of a built-in guide or a folder you cannot write to, retaining its supporting files. Import and Export sit together in the page toolbar. **Import → SKILL.md file** adds a standalone Markdown skill. **Import → Skill folder** also retains references, scripts, and assets. **Export → SKILL.md** downloads the standard Markdown file; **Export → All files** downloads a portable bundle that another 0 workspace can import with **Import → Exported skill**. The bundle contains the original files; it is a 0 transport format, rather than a format another agent can read directly.

In a team workspace, imported and created skills are shared with that team. Editors can create and edit them; viewers can browse and export. Only owners can mount host folders. Team workspaces do not discover the host operator's personal skill folders automatically.

Use **Edit in chat** to discuss changes with the agent. It reads the latest skill with `read_skill`, creates instructions with `create_skill`, and saves or copies them with `save_skill` or `copy_skill`. Chat uses the same permissions and revision checks as the web editor.

Edits use revision checks. If someone changes a skill while you are editing, your draft stays open and a stale save is rejected. **Reload latest** replaces the draft with the latest version.

Folder mounting is wired to Local chat execution. Custom mounted skills are not automatically copied into SmolVM guests.
