# Dashboard design system

Shared tokens live in `src/styles.css`; shared controls live in `src/components/ui`.
Kumo portal surfaces and Dockview use the same tokens. Keep geometry in these shared
layers instead of adding page-specific overrides.

| Surface | Token | Default |
| --- | --- | --- |
| Buttons, fields, tab selectors, menu items | `--radius-control` | 8px |
| Menus, popovers, command palettes | `--radius-menu` | 12px |
| Cards, dialogs, workspace panels | `--radius-panel` | 16px |
| Chat composer | `--radius-composer` | 22px |
| Compact / normal / large controls | `--control-height-sm` / `--control-height` / `--control-height-lg` | 28 / 32 / 40px |

Dark mode uses neutral charcoal only: canvas `#101011`, panels `#19191b`,
and raised surfaces `#222225`. No navy tint. Workspace panels use
`--workspace-panel` above a darker `--workspace-canvas`.
Use narrow gutters and clipped content corners to reveal the panel silhouette;
avoid stacking outlines around every layer. Dock tabs have one padding owner,
8px between label and close control, and a 24px close target (28px on mobile).
Menus have 4px outer padding and 8px corners on interactive rows.

Preserve intentional circles and pills for avatars, status badges and toggles.
Hover backgrounds belong to the interactive target; disclosures should not
highlight the full transcript width. Keep visible keyboard focus and respect
both OS and app reduced-motion settings. Sash resizing stays immediate.

Reference: public UXDuck runtime styles were inspected for geometry and hierarchy.
The implementation here uses our existing components, theme and accessibility behavior.

The persistent sidebar keeps New chat, Search, and history at the top on every
page. App destinations, Settings, backend selection and account controls sit at
the bottom. Rows share 32px height, 14px type, 16px icons and 8px corners.
Only open conversation views belong in Dockview. Empty tabs say New chat without
a close button; real chat tabs show their title and close the view only.
Sidebar collapse is explicit and animated, retaining mounted content.

Tool feedback shows current calls and recent results while working, then folds
into a compact completion summary. Failed tools do not add a review badge.

Primary actions use a white background (`--primary`) and dark text
(`--primary-foreground`) in both themes. Hover uses `--primary-hover`; the
light theme adds `--primary-border` so white actions remain distinct on white
surfaces. Links use `--primary-text` and keyboard focus uses `--ring`, with
neutral values appropriate to each theme. Warning, success, and destructive
variants keep their semantic colors. Do not hardcode orange action colors.

Use the shared Button primitive for actions; its default/small/large heights
follow the control tokens above (extra-small utility targets remain 24px).
Kumo primary buttons use the same action tokens through the shared stylesheet
adapter; Kumo destructive buttons retain their separate danger tokens.

Enabled switches use `--switch-on` (soft orange) with a dark
`--switch-thumb-on` thumb. Reserve this small accent for enabled switch state;
primary action buttons remain white.

Floating controls use the shared `DropdownMenu` and Select adapters. Picker
consumers use `ui-menu-surface` (4px inset), `ui-menu-item` (32px single-line
rows), `ui-menu-item--detail` (44px with 11px secondary text), and
`ui-menu-section` for quiet labels. Model catalogs are 320px wide; forms use
`ui-menu-form` with 12px inset. Keep search fixed while results scroll.
Onboarding is a centered single-column flow outside application navigation.
Settings is one global preferences page; the command center indexes each setting.

Application pages share the same 1600px maximum canvas through `PageContent`.
Skills, Findings, Automations, Hosts, Memory, Settings, and supporting pages use
the available workspace width with the same responsive gutters. The legacy
`readable` and `wide` props remain compatible aliases for this shared width; do
not add page-specific maximum widths. Keep local limits for long prose, focused
forms, dialogs, onboarding, and chat transcripts where they improve readability.

Light mode keeps the shell canvas and navigation black (`#101011`) with a white
workspace. The `.console-sidebar-surface` marker scopes dark text/surface tokens
to the desktop rail and mobile navigation sheets. Menus portalled outside that
subtree retain the root theme so their foreground and surface stay paired.
Choose Settings → Appearance → Theme → Light; Dark retains the existing neutral
charcoal surfaces. Browser appearance offers Light/Dark only and persists in
`zero-web-theme` browser storage, independently of host/account and CLI settings.
The web app neither polls the terminal theme catalog nor applies terminal palettes. Onboarding remains a focused light/dark page without a black
navigation canvas.

Web settings use the reviewed shared-capability allowlist in `web-settings.ts`: agent
coordination, conversation context, runtime selection, updates, and privacy. New
terminal definitions stay hidden until explicitly reviewed. Browser Theme and
Reduce motion are local preferences (`zero-web-theme`, `zero-web-reduce-motion`)
and do not mutate terminal settings. Settings reset targets only shared keys.
Runtime setup is summarized first; technical image/runtime details stay collapsed.
