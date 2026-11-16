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
| Background | Settings > Appearance, 10 tiny tiles; Aurora was CSS blobs sized in `vw`, so a tile showed none of them | `appearance-control.tsx` `BackgroundPicker` | now six canvas scenes plus None, all with a real still on the tile (see Backgrounds) |
| | Command palette "Change background" | `command-palette.tsx` | kept |
| Search | Settings search entries for each row | `console-control/settings-index.ts` | anchors unchanged |

## Where things live now

- Settings > Appearance is the only place with every option. `components/appearance/appearance-page.tsx` composes it.
- Profile menu: one "Appearance" item that opens the page. No toggles.
- Command palette: "Change theme" and "Change background" open the page at that section; "Switch to light, dark or system mode" apply at once.
- `/theme light|dark|system` applies at once; `/theme` opens the Theme section.

## The page

There is no preview strip (the owner decided on 2026-11-16 that the page does not need one): changes apply to the real console behind the page. In order: Mode (small app thumbnails; System is half light, half dark), Theme (cards with a mini UI in that theme's colours), Accent (named swatches; non-Zero themes bring their own accent, so the row says so), Background (16:10 tiles of real frames; hover or focus plays the live animation; None is an empty frame with a slash), Text and layout (Font size, Compact transcript with a before and after), Motion (System, On, Off).
Each group is a keyboard radiogroup (`ChoiceGroup`). One-line descriptions, plain words.

## Structure

- `lib/appearance-settings.ts`: typed `AppearanceSettings`, defaults, validation, which accents and modes a theme allows, and the migration of the old browser keys (`zero-web-theme`, `-color-theme`, `-accent-v2` with the legacy `-accent`, `-background`, `-font-size`, `-motion`).
- `components/appearance/use-appearance.ts`: one hook that reads and writes the existing stores; `useResolvedMode`.
- `ui/backdrops/still.ts`: `renderStill(ctx, kind, width, height, { ink }, time?)` runs the same sketch the live backdrop runs, fast-forwarded to `time` (default: that scene's own still time). `BackdropStill` draws it. The CPU, pause and visibility rules and the contrast guard are unchanged; stills run no loop.
- Adding or removing a backdrop: an entry in `kinds.ts` (`BACKDROPS`: id, label, peak opacity) and its factory in `sketches.ts` (a missing factory is a type error). The tiles and preview follow.

## Backgrounds

Settings > Appearance > Background offers None plus six scenes. Each is a canvas 2D sketch with its own frame cap, a still frame for tiles and reduced motion, and the same theme-ink colouring and contrast cap.

| Option | What it is | Cap |
| --- | --- | --- |
| None | Nothing behind the thread | |
| Dither (default) | Dither flow v2: a domain-warped noise field, lit by three drifting lights, ordered-dithered in two tones with sparse accent dots | 12 fps |
| Contours | A printed survey map: marching squares on a drifting field, minor, major and index lines, dot-tally elevation marks | 10 fps |
| Glyph contours | A field of monospace punctuation chosen from a density ramp, densest along the ridges of drifting noise | 10 fps |
| Fish school | Three depth layers of boids drawn as tapered fish with trails, dithered | 20 fps |
| Plankton | Drifting plankton with dithered glow halos and four slow jellyfish | 16 fps |
| Ink | Two ink plumes carried by a divergence-free flow, thinning into dithered wisps | 20 fps |

Aurora, Grid, Scanline, Code rain, Waves, Ripple, Constellation and the old Topography were removed. A saved choice of any of them reads as Dither (`REMOVED_BACKDROPS` and `parseBackdrop` in `kinds.ts`); None stays None. Shared modules: `noise.ts` (simplex and value noise), `bayer.ts`, `boids.ts`, `curl.ts`, `pixels.ts` and `pixel-sketch.ts` (the low-resolution dither surface and its fixed-step host). Dither scenes keep the lab's low internal resolution and pixelated upscale. `assets/backdrops/print-sonar.html` is a spare candidate for the marketing site and is not part of the app.

## Capy reference

Capy has one Appearance page of card sections, mode tiles at 80x60 with a split System tile, theme cards with a mini UI in the theme's own colours, 8px radius, 12px labels, and a ring on the selected one. This page follows that. Capy has no text size, density or motion control; those stay here as one-line rows.
