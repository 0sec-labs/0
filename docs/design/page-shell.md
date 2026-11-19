# Page shell

One layout primitive, `PageShell` (`packages/web/src/components/page-shell.tsx`), with three variants. Routes declare their variant in `PAGE_ROUTES` (`lib/workspace-navigation.ts`); `RoutedPageShell` is a layout route in `operations-app.tsx` that applies it, so a page renders only its `PageHeader` and content and never sets its own max-width, centring or horizontal padding. `PageHeader` is the one title component (22px/500, summary 13px, actions top right). A page whose layout depends on its own state calls `usePageVariant`.

| Variant | Width | Used by |
|---|---|---|
| `list` (default) | 872px, centred, 24px gutters, title at a fixed offset | Agents and Agent detail, Skills (Installed, Browse, detail), Memory, Computers, Extensions, doctor, tools, project, fix, models, connections, Members, API keys, not-found |
| `form` | 672px, same gutters and offset | Settings sections |
| `full` | edge to edge, header keeps the gutter and offset | Findings (list and board), finding page, thread view |

The widths are the CSS variables `--page-width-list` and `--page-width-form` (styles.css), mirrored by `PAGE_WIDTHS`; `test/page-shell.test.ts` asserts they match, and `test/design-guards.test.ts` fails when a file under `pages/` sets `max-w-*`/`mx-auto` or when a route is outside the shell or the route table.

## Why these numbers

Capy's Explore > Skills page has an 872px column, a 22px/500 H1 and search top right (/tmp/capy-ref/SPEC.md). Capy has no measured form page or agent detail, so `form` is one step narrower (672px = 42rem, the width forms read well at) and the Agent detail is a `list` page (profile header, tabs, content) rather than an editor. At 1024px and 768px viewports the sidebar leaves 774px and 768px, so every page is the same width there (below 872px the column is the available width).

## Before (light theme, content column width, left offset, horizontal padding, h1 top/left, h1 font size)

Measured with headless Chromium against a console started from the worktree (`HOME=/tmp/page-shell-home`). Detail pages were measured on the not-found state of a missing id, so they show no h1 or column; "no column" means the page had no max-width container.

| Page | 1440 | 1024 | 768 |
|---|---|---|---|
| agents | 1024 (max 1024), x324, pad 24; h1 101/348 26px | 774 (max 1024), x241, pad 24; h1 101/265 26px | 768 (max 1024), x0, pad 24; h1 92/24 26px |
| agent-detail | 768 (max 768), x452, pad 24; no h1 | 768 (max 768), x244, pad 24; no h1 | 768 (max 768), x0, pad 24; no h1 |
| skills-installed | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| skills-browse | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| skill-catalog-detail | 768 (max 768), x452, pad 24; no h1 | 768 (max 768), x244, pad 24; no h1 | 768 (max 768), x0, pad 24; no h1 |
| memory | 768 (max 768), x452, pad 24; h1 101/476 26px | 768 (max 768), x244, pad 24; h1 101/268 26px | 768 (max 768), x0, pad 24; h1 92/24 26px |
| computers | 768 (max 768), x452, pad 24; h1 101/476 26px | 768 (max 768), x244, pad 24; h1 101/268 26px | 768 (max 768), x0, pad 24; h1 92/24 26px |
| extensions | 768 (max 768), x452, pad 24; h1 101/476 26px | 768 (max 768), x244, pad 24; h1 101/268 26px | 768 (max 768), x0, pad 24; h1 92/24 26px |
| settings-general | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| settings-appearance | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| settings-threads | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| settings-notifications | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| settings-shortcuts | 1024 (max 1024), x324, pad 24; h1 101/348 22px | 774 (max 1024), x241, pad 24; h1 101/265 22px | 768 (max 1024), x0, pad 24; h1 92/24 22px |
| settings-instructions | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| settings-helpers | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| settings-git | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| settings-usage | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| settings-audit-log | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| findings-list | no column; no h1 | no column; no h1 | no column; no h1 |
| findings-board | no column; no h1 | no column; no h1 | no column; no h1 |
| finding-detail | 1190 (max none), x241, pad 0; no h1 | 774 (max none), x241, pad 0; no h1 | 768 (max none), x0, pad 0; no h1 |
| new-thread | no column; no h1 | no column; no h1 | no column; no h1 |
| thread-view | no column; no h1 | no column; no h1 | no column; no h1 |
| doctor | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| tools | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| project | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| fix | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| models | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| connections | 768 (max 768), x452, pad 24; h1 101/476 22px | 768 (max 768), x244, pad 24; h1 101/268 22px | 768 (max 768), x0, pad 24; h1 92/24 22px |
| members | 768 (max 768), x452, pad 24; h1 101/476 26px | 768 (max 768), x244, pad 24; h1 101/268 26px | 768 (max 768), x0, pad 24; h1 92/24 26px |
| api-keys | 768 (max 768), x452, pad 24; h1 101/476 26px | 768 (max 768), x244, pad 24; h1 101/268 26px | 768 (max 768), x0, pad 24; h1 92/24 26px |
| not-found | no column; no h1 | no column; no h1 | no column; no h1 |

## After

| Page | 1440 | 1024 | 768 |
|---|---|---|---|
| agents | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| agent-detail | 872 (max 872), x400, pad 24; no h1 | 774 (max 872), x241, pad 24; no h1 | 768 (max 872), x0, pad 24; no h1 |
| skills-installed | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| skills-browse | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| skill-catalog-detail | 872 (max 872), x400, pad 24; no h1 | 774 (max 872), x241, pad 24; no h1 | 768 (max 872), x0, pad 24; no h1 |
| memory | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| computers | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| extensions | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| settings-general | 672 (max 672), x500, pad 24; h1 101/524 22px | 672 (max 672), x292, pad 24; h1 101/316 22px | 672 (max 672), x48, pad 24; h1 92/72 22px |
| settings-appearance | 672 (max 672), x500, pad 24; h1 101/524 22px | 672 (max 672), x292, pad 24; h1 101/316 22px | 672 (max 672), x48, pad 24; h1 92/72 22px |
| settings-threads | 672 (max 672), x500, pad 24; h1 101/524 22px | 672 (max 672), x292, pad 24; h1 101/316 22px | 672 (max 672), x48, pad 24; h1 92/72 22px |
| settings-notifications | 672 (max 672), x500, pad 24; h1 101/524 22px | 672 (max 672), x292, pad 24; h1 101/316 22px | 672 (max 672), x48, pad 24; h1 92/72 22px |
| settings-shortcuts | 672 (max 672), x500, pad 24; h1 101/524 22px | 672 (max 672), x292, pad 24; h1 101/316 22px | 672 (max 672), x48, pad 24; h1 92/72 22px |
| settings-instructions | 672 (max 672), x500, pad 24; h1 101/524 22px | 672 (max 672), x292, pad 24; h1 101/316 22px | 672 (max 672), x48, pad 24; h1 92/72 22px |
| settings-helpers | 672 (max 672), x500, pad 24; h1 101/524 22px | 672 (max 672), x292, pad 24; h1 101/316 22px | 672 (max 672), x48, pad 24; h1 92/72 22px |
| settings-git | 672 (max 672), x500, pad 24; h1 101/524 22px | 672 (max 672), x292, pad 24; h1 101/316 22px | 672 (max 672), x48, pad 24; h1 92/72 22px |
| settings-usage | 672 (max 672), x500, pad 24; h1 101/524 22px | 672 (max 672), x292, pad 24; h1 101/316 22px | 672 (max 672), x48, pad 24; h1 92/72 22px |
| settings-audit-log | 672 (max 672), x500, pad 24; h1 101/524 22px | 672 (max 672), x292, pad 24; h1 101/316 22px | 672 (max 672), x48, pad 24; h1 92/72 22px |
| findings-list | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| findings-board | 1190 (max none), x241, pad 0; h1 101/265 22px | 774 (max none), x241, pad 0; h1 101/265 22px | 768 (max none), x0, pad 0; h1 92/24 22px |
| finding-detail | 1190 (max none), x241, pad 0; no h1 | 774 (max none), x241, pad 0; no h1 | 768 (max none), x0, pad 0; no h1 |
| new-thread | 1190 (max none), x241, pad 0; no h1 | 774 (max none), x241, pad 0; no h1 | 768 (max none), x0, pad 0; no h1 |
| thread-view | 1190 (max none), x241, pad 0; no h1 | 774 (max none), x241, pad 0; no h1 | 768 (max none), x0, pad 0; no h1 |
| doctor | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| tools | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| project | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| fix | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| models | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| connections | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| members | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| api-keys | 872 (max 872), x400, pad 24; h1 101/424 22px | 774 (max 872), x241, pad 24; h1 101/265 22px | 768 (max 872), x0, pad 24; h1 92/24 22px |
| not-found | 872 (max 872), x400, pad 24; no h1 | 774 (max 872), x241, pad 24; no h1 | 768 (max 872), x0, pad 24; no h1 |

Screenshots (before and after, 1440/1024/768, light and dark): /tmp/page-shell-shots/{before,after}/.
