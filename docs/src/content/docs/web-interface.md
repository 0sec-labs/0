---
title: Browser interface
description: The sidebar cards, top bar, keyboard shortcuts, notifications, Explore, and the Settings pages of the 0 browser console.
---

This page describes what the browser console (`0 web`) shows and where its
settings live. Missions, Findings, Automations, Plugins, Skills, Engines, and
Memory are covered by their own pages; see [Concepts](/concepts/) for the
vocabulary. Preferences marked "this browser" are stored in the browser and
never sent to the engine.

## Sidebar cards

Two optional cards appear above the account row. They are shown to local users
and to team owners, not to editors or viewers.

- **Finish setting up** lists two steps: connect a model provider and start your
  first mission. A connected provider gets its default model automatically, so
  there is no model step. Each step is derived from state the console can observe.
  The card stays hidden until all of that state has loaded, hides itself once both
  steps are done, and can be dismissed with the close button. There is no
  onboarding page; `/onboarding` and `/setup` redirect to Missions.
- **Update available** appears when a newer 0 release exists. It shows the latest
  and current versions, links to what changed, and **Copy update command** copies
  `0 upgrade`. Dismissing the card hides that version only; a later release shows it again.

## Top bar and breadcrumbs

Pages other than the mission conversation show a top bar with breadcrumbs, for
example **Plugins > Cloudflare** or **Settings > Notifications**. The last crumb
names the open record (a finding, automation, sentinel, or plugin). A page can
add actions on the right. Missions own their header and show no top bar.

## Keyboard shortcuts

Press `?` outside a text field to open the shortcuts dialog, or open
**Settings → Shortcuts** for a searchable list. Both are generated from the same
registry the console uses to handle keys, so they list exactly what works.
`⌘` is `Ctrl` outside macOS.

| Shortcut | Action |
| --- | --- |
| `⌘K` or `/` | Search anything |
| `⌘,` | Open settings |
| `⌘B` or `⌘⇧S` | Toggle the sidebar (`⌘B` is ignored while typing, where it means bold) |
| `⌘⇧B` | Toggle the right panel in a mission |
| `⌘⇧O` | New mission |
| `⌘.` | Stop the running mission |
| `⌘I` | Focus the composer |
| `⌘/` | Attach files |
| `⌘⇧F`, `⌘⇧E`, `⌘⇧G`, `⌘⇧L`, `⌘⇧V` | Open Findings, Evidence, Fixes, Browser, or Visuals in the mission panel |
| `Enter`, `⇧Enter` | Send, or insert a new line |

## Missions

**Saved missions open in the live conversation.** Opening a saved mission shows
its transcript in the same conversation view as a live one, with the work log,
toolbar, and panels. Opening never starts an engine: the mission is read-only until
you send a message, which resumes it once. Actions that need a live mission, such as
rename, clear, close, and model change, are hidden or explained until then.

## Explore

**Explore** (`/plugins/explore`) is the catalogue for adding capabilities, with
three tabs: **Plugins**, **Skills**, and **Themes**. Plugin and skill entries
open a detail page (`/plugins/<id>`) with install and approval controls.
The **Themes** tab is a placeholder ("coming soon"); choose appearance under
**Settings → Appearance** instead.

## Toasts

Page-level notices appear as toasts at the bottom right. Status toasts close
after 5 seconds and errors after 8 seconds; some, such as connection states,
stay until dismissed. A toast can carry one action. Errors inside a form or an
embedded pane stay local to that form or pane.

## Settings pages

Open **Settings** and use the sidebar or the search box, which looks inside
pages as well as at their titles.

| Page | What it controls |
| --- | --- |
| General | Update policy and engine updates, and a reset for shared preferences. |
| Appearance | **Theme**: light, dark, or follow the system (existing installs stay on dark until changed). **Accent**: orange, blue, green, violet, rose, or neutral. **Font size**: small, default, or large. **Reduce motion**: follow the system, always reduce, or always animate. This browser only. |
| Missions | Messages while working (queue or interrupt), summarizing long missions, **Mission title instructions** (guidance for automatic titles, such as a language or style; credentials are still redacted), **Archive idle missions after** (off, 7, 14, 30, or 90 days; applies when the engine starts, archived missions stay searchable), and the subagent limits: **Concurrent subagents**, **Nested subagent depth**, and **Subagents per call**. The same page holds the transcript options (expand the work log, show tool calls, agent list, message times, elapsed time) and what the chat header shows (cost, token counts, context meter). Ranges and the `ZERO_SUBAGENT_*` overrides are in [Configuration](/configuration/). |
| Instructions | Operator-owned `AGENTS.md` text, global and per workspace folder, added to each mission's system prompt in a trusted block. `AGENTS.md` or `CLAUDE.md` inside a target repository is never loaded. See [Operator instructions](/console/#operator-instructions). |
| Notifications | Browser notifications for mission finished, mission needs approval, mission asked a question, scan finished, and fix ready or pull request opened. Off by default. Options: only while the tab is hidden (default), play a sound (default), send a test. Requires browser permission; nothing leaves this browser. |
| Shortcuts | The searchable shortcut list above. |
| Agents and privacy | Agent collaboration and messages, model-authored plugins, where tools run, usage metrics and problem reports. |
| Usage | Estimated spend and tokens, by model and by mission, for the missions open on this engine. |
| Git and pull requests | The GitHub connection, the repositories the signed-in `gh` account can reach (with the sentinels that use them; needs the GitHub CLI on the engine computer, cached for five minutes), and the pull requests this engine opened. A published fix goes to a new branch and opens a pull request against the repository's current branch. Whether a pull request is merged is not tracked. |
| Audit log | The local, append-only record of privileged actions (approvals, denials, settings, plugin and connection changes), searchable, with JSON export. |

Connections, Models, Workspace and Diagnostics are in the same sidebar. Plugins and Skills live under **Explore** and **Plugins**, and team members under the account menu. Older `/settings?section=` links for removed pages (Profile, Experiments, Activity, Finding states, Repositories, Integrations, Skills, Members, Transcript, Cost & context, Data & privacy) redirect to the closest page.
