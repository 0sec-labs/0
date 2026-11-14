# Dashboard design system

Shared tokens live in `src/styles.css`; shared controls live in `src/components/ui`.
Base UI popups and Dockview use the same tokens. Keep geometry in these shared
layers instead of adding page-specific overrides.

| Surface | Token | Default |
| --- | --- | --- |
| Buttons, fields, tab selectors, menu items | `--radius-control` | 6px |
| Menus, popovers, command palettes | `--radius-menu` | 8px |
| Cards, dialogs, workspace panels | `--radius-panel` | 12px |
| Chat composer | `--radius-composer` | 16px |
| Compact / normal / large controls | `--control-height-sm` / `--control-height` / `--control-height-lg` | 28 / 32 / 40px |

Dark mode uses a neutral charcoal ladder (chroma under .003, hue 286): `--background`
oklch 14%, `--panel` 18%, `--card` 22%, `--card-hover` 24%, `--popover` 25%. Borders are
white at 8/12/16% (`--border-1/2/3`) and secondary text steps through
`--muted-foreground-1/2/3`. No navy tint. Light mode mirrors the same tokens. Workspace panels use
`--workspace-panel` above `--workspace-canvas`, which is a slightly darker neutral in both themes.
Use narrow gutters and clipped content corners to reveal the panel silhouette;
avoid stacking outlines around every layer. Dock tabs have one padding owner,
8px between label and close control, and a 24px close target (28px on mobile).
Menus have 4px outer padding and 8px corners on interactive rows.

Preserve intentional circles and pills for avatars, status badges and toggles.
Hover backgrounds belong to the interactive target; disclosures should not
highlight the full transcript width. Keep visible keyboard focus. Sash resizing stays immediate.

Reference: Capy's public app styles were inspected for the surface ladder, border opacities,
radii and type; the implementation uses our own components and tokens.
The implementation here uses our existing components, theme and accessibility behavior.

The persistent sidebar keeps New chat, Search, and history at the top on every
page. App destinations, Settings, backend selection and account controls sit at
the bottom. Rows share 32px height, 14px type, 16px icons and 8px corners.
Only open conversation views belong in Dockview. Empty tabs say New chat without
a close button; real chat tabs show their title and close the view only.
Sidebar collapse is explicit and animated, retaining mounted content.

Tool feedback shows current calls and recent results while working, then folds
into a compact completion summary. Failed tools do not add a review badge.

Primary actions use the orange brand color (`--primary`, `#fd802e`) with white text
(`--primary-foreground`) in both themes. White on this orange is about 2.4:1, below
WCAG AA for small text, so keep orange-filled labels medium weight or larger.
Hover uses `--primary-hover`. Links use `--primary-text` (`--primary-ink`, darker in light
mode, lighter in dark mode) and keyboard focus uses `--ring`, an orange tint. Warning,
success, and destructive variants keep their semantic colors.

Use the shared Button primitive for actions; its default/small/large heights
follow the control tokens above (extra-small utility targets remain 24px).

Typography is Inter (variable) for text and Geist Mono for code.

Primitives in `src/ui` are built on Base UI (`@base-ui/react`): Dialog, Menu, Popover,
Select, Tabs, Tooltip, Switch, Slider, ScrollArea and Separator. `asChild` is kept as a
compatibility prop and maps to Base UI's `render`. Popups animate through the
`data-starting-style` and `data-ending-style` hooks (`.ui-popup`, `.ui-backdrop`,
`.ui-sheet` in `ui/styles/motion.css`); there is no animation-library dependency.
Radix and Kumo are not used.

Enabled switches use `--switch-on` (the brand orange) with a dark
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
