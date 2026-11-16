# Appearance

One page, Settings > Appearance, owns every look-and-feel preference. Everything else is a shortcut to it.

## Where each control lived before this change

| Control | Where it could be changed | Evidence (before) | Duplicate or dead |
|---|---|---|---|
| Mode (system, light, dark) | Settings > Appearance select | `console-control/appearance-control.tsx` `AppearanceRows` | |
| | Profile menu submenu: System, Light, Dark | `components/team-access.tsx` `AccountMenu` (`themeItem`) | duplicate, removed |
| | Command palette: "Use Light/Dark/System appearance" x3, "Web appearance" | `components/command-palette.tsx` | kept as "Switch to ... mode"; "Web appearance" folded into "Change theme" |
| | `/theme light` and `/theme dark` | `pages/console-page.tsx` | kept; now also `system` |
| Colour theme | Settings > Appearance button that opened a side sheet with a paginated gallery | `appearance-control.tsx` `ColorThemeRow`, `components/appearance/theme-gallery.tsx` | sheet, pager and undo toast removed |
| | `/theme` with no argument opened the Mode row | `console-page.tsx` | now opens Theme |
| Accent | Settings > Appearance swatch row (disabled, unexplained, under any non-Zero theme) | `appearance-control.tsx` `AccentPicker` | now explained and limited to what the theme accepts |
| Font size | Settings > Appearance select | `appearance-control.tsx` | |
| Compact transcript | Engine setting `density` rendered as a generic switch row in the Appearance section | `console-control/web-settings.ts` | now inside Text and layout with a before and after sample |
| Reduce motion | Settings > Appearance select | `appearance-control.tsx` | |
| Background | Settings > Appearance, 10 tiny tiles; Aurora was CSS blobs sized in `vw`, so a tile showed none of them | `appearance-control.tsx` `BackgroundPicker`, `ui/backdrops/aurora.tsx` | |
| | Command palette "Change background" | `command-palette.tsx` | kept |
| Search | Settings search entries for each row | `console-control/settings-index.ts` | anchors unchanged |

## Where things live now

- Settings > Appearance is the only place with every option. `components/appearance/appearance-page.tsx` composes it.
- Profile menu: one "Appearance" item that opens the page. No toggles.
- Command palette: "Change theme" and "Change background" open the page at that section; "Switch to light, dark or system mode" apply at once.
- `/theme light|dark|system` applies at once; `/theme` opens the Theme section.

## The page

A sticky live preview (sidebar strip, the backdrop frame at the opacity the real screen uses, heading, composer) built from the real tokens, so it follows theme, accent, mode and text size at once. Then, in order: Mode (small app thumbnails; System is half light, half dark), Theme (cards with a mini UI in that theme's colours), Accent (named swatches; non-Zero themes bring their own accent, so the row says so), Background (16:10 tiles of real frames; hover or focus plays the live animation; None is an empty frame with a slash), Text and layout (Font size, Compact transcript with a before and after), Motion (System, On, Off).
Each group is a keyboard radiogroup (`ChoiceGroup`). One-line descriptions, plain words.

## Structure

- `lib/appearance-settings.ts`: typed `AppearanceSettings`, defaults, validation, which accents and modes a theme allows, and the migration of the old browser keys (`zero-web-theme`, `-color-theme`, `-accent-v2` with the legacy `-accent`, `-background`, `-font-size`, `-motion`).
- `components/appearance/use-appearance.ts`: one hook that reads and writes the existing stores; `useResolvedMode`.
- `ui/backdrops/still.ts`: `renderStill(ctx, kind, width, height, { ink }, time)` runs the same sketches the live backdrop runs at a fixed time; Aurora and Dither get canvas twins. `BackdropStill` draws it. The CPU, pause and visibility rules and the contrast guard are unchanged; stills run no loop.
- Adding or removing a backdrop: an entry in `kinds.ts` (`BACKDROPS`, `PEAK_ALPHA`) and its sketch in `sketches.ts`. The tiles and preview follow.

## Capy reference

Capy has one Appearance page of card sections, mode tiles at 80x60 with a split System tile, theme cards with a mini UI in the theme's own colours, 8px radius, 12px labels, and a ring on the selected one. This page follows that. Capy has no text size, density or motion control; those stay here as one-line rows.
