# Design tokens

One place defines them: `packages/web/src/styles.css` (`:root` is light, `.dark` overrides) and `packages/web/src/lib/color-themes.ts` (palettes; `color-themes.css` is generated from it). Components read tokens, never literal colours. "Capy" is the read-only capture of capy.ai 0.9.0 (dark, 1440x900, 2026-11-16) in `/tmp/capy-ref/DESIGN.md`. Capy has no light theme, so the light column keeps our existing structure with the same hue.

## Colour

| Token | Dark | Light | Source in Capy capture |
| --- | --- | --- | --- |
| `--background` | oklch(14.03% .0022 286.1) | oklch(96.2% .0025 290) | bg/chrome .1403 |
| `--panel` | oklch(18.26% .002 286.2) | oklch(98.5% .0015 290) | panel .1826 |
| `--card`, `--input` | oklch(21.82% .0019 286.2) | oklch(100% 0 0) | card/input .2182 |
| `--card-hover` | oklch(23.97% .0019 286.3) | oklch(97.8% .0015 290) | card-hover .2397 |
| `--popover` | oklch(25.24% .0019 286.3) | oklch(100% 0 0) | popover .2524 |
| `--foreground` | oklch(94.04% .0013 286.4) | oklch(23.5% .0038 290) | text .9404 |
| `--muted-foreground-1/2/3` | mix 68 / 52 / 38% of foreground in background | mix 62 / 63 / 36% | muted-1/2/3 (light 2 raised so it reads at 4.5:1) |
| `--border-1/2/3` | white 8 / 12 / 16% | black 8 / 11 / 15% | border-1/2/3 |
| `--secondary`, `--accent` | white 8% | black 5% | secondary white .08 |
| `--secondary-hover` | white 11% | black 8% | secondary-hover .11 |
| `--popover-hover` | white 6.5% | black 4% | popover-hover .065 |
| `--section` | white 3.5% | black 4% | section .035 |
| `--primary` | oklch(58% .213 267.8) | same | primary #456af6 |
| `--primary-foreground` | #ffffff | #ffffff | text on a filled primary |
| `--primary-ink` (links, "needs you") | oklch(70% .15 267.8) | oklch(49% .2 267.8) | primary-ink .70 .15 (light darkened to read on white) |
| `--primary-soft` / `-hover` | primary 20% / 24% | primary 12% / 16% | primary-soft 20% |
| `--ring` | `--primary` | `--primary` | focus ring = primary |
| selection | primary 20% bg, primary-ink text | same | selection |
| `--success`, `--warning`, `--destructive` | oklch(61.7% .208 142.85), oklch(85% .155 96), oklch(55% .185 27) | light-tuned | semantic |
| `--diff-add` / `--diff-del` | oklch(68% .14 142.85) / oklch(66% .14 25), 10% wash | 56% / 55%, 6% wash | diff add/del |

The accent is a preset: Blue is the default (no `data-accent`), Neutral, Orange, Green, Violet and Rose override the primary tokens in `styles.css`. Other colour themes (Dracula, Nord, ...) bring their own primary through `--t-primary`.

## Type, radius, controls

| Token | Value | Source |
| --- | --- | --- |
| Font | Inter Variable (450 / 500 / 560), Geist Mono Variable for code | type |
| `--responsive-text-2xs..2xl` | 11 / 12 / 13 / 14 / 18 / 22 / 26 px (desktop) | scale |
| tracking | -0.02em at 14px, -0.01em at 13px | body 14/21, markdown 13/19.5 |
| `--radius-kbd`, `--radius-sm` | 3px | radius sm |
| `--radius-button`, `--radius-md` | 6px | controls, rows |
| `--radius-card`, `--radius-lg` | 8px | card, composer, tiles |
| `--radius-panel`, `--radius-xl` | 12px | panel, palette |
| `--h-control-xs/sm/base/lg` | 24 / 28 / 32 / 44 px | control heights |
| `--h-menu-row`, `--h-palette-row` | 28 / 40 px | menu, palette |
| `--icon-xs/sm/base/lg` | 12 / 14 / 16 / 18 px; buttons default to 14 | icons |
| control border | 0.8px | buttons |

## Shadow and motion

| Token | Value | Source |
| --- | --- | --- |
| `--sh-composer` (dark) | 0 3px 8px /.09, 0 2px 5px /.09, 0 1px 1px /.1 black | shadow-composer |
| `--sh-card` (dark) | 0 0 0 1px black/.3 | card ring |
| primary button | inset 0 1px white/.12, `--sh-plate` (0 .5px 1px 1px black/.3), border 20% darker | primary button |
| controls and rows | 100ms colour-only transition, no press dim or scale | motion |
| default / base / slow | 150 / 200 / 300 ms, `cubic-bezier(.4,0,.2,1)` | motion |
| layout (sidebar, panels) | `--ease-out-quint` cubic-bezier(.23,1,.32,1) | motion |

## Utilities

`no-scrollbar` hides a list's scrollbar (Capy hides them on lists); `scroll-fade-y`, `scroll-fade-top`, `scroll-fade-x` add 24px edge masks; `press` is the 100ms colour transition; `ui-row-hover` is the row wash.

## Checks

`test/token-contrast.test.ts` resolves the tokens above from `styles.css` and requires 4.5:1 for foreground, muted-1/2, primary-ink on every surface and for primary-foreground on primary, in both modes. `test/appearance-accents.test.ts` does the same for every accent preset.
