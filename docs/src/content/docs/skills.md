---
title: Skills
description: Use reusable agent instructions from standard skill folders.
---

Skills teach the agent how to perform a task. Workflows define the steps of a run. Plugins connect tools and services. You can use a skill in a chat or alongside a workflow.

Open **Skills** in the sidebar to browse built-in guides, installed folders, and workspace skills. The agent discovers these through `list_skills` and loads the instructions with `load_skill` when needed.

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

0 discovers project and personal `.agents/skills` folders, plus `.claude/skills` for compatibility. **Mount folder** adds another folder on the engine computer without copying its files. Mounted skills are read only in the web editor; changes to the original files are discovered automatically.

## Create and share

**New skill** creates a workspace skill. **Import → Skill folder** copies a standard folder from your browser, including references, scripts, and assets. **Export** downloads a portable bundle that another 0 workspace can import with **Import → Exported skill**. The bundle contains the original files; it is a 0 transport format, rather than a format another agent can read directly.

In a team workspace, imported and created skills are shared with that team. Editors can create and edit them; viewers can browse and export. Only owners can mount host folders. Team workspaces do not discover the host operator's personal skill folders automatically.

Edits use revision checks. If someone changes a skill while you are editing, your draft stays open and a stale save is rejected. **Reload latest** replaces the draft with the latest version.

Folder mounting is wired to Local chat execution. Custom mounted skills are not automatically copied into SmolVM guests.
