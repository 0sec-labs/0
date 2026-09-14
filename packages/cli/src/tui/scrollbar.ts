/**
 * The one sleek scrollbar style, shared by every `<scrollbox>` in the TUI.
 *
 * OpenTUI's default vertical scrollbar paints a full filled TRACK (a solid
 * column the height of the viewport) plus up/down arrow caps — the thick
 * "OpenCode" bar. We want the oh-my-pi look instead: no visible track, no
 * arrows, just a slim thumb that hints at scroll position.
 *
 * The scrollbar's track is a Slider whose `backgroundColor` paints the empty
 * track and whose `foregroundColor` paints the thumb (see ScrollBar.d.ts →
 * SliderOptions). So:
 *   - `trackOptions.backgroundColor` = the surrounding surface, which makes the
 *     track blend into the panel and read as invisible;
 *   - `trackOptions.foregroundColor` = a subtle `BORDER` thumb, present but quiet;
 *   - `showArrows: false` hides the arrow caps entirely (and the arrow colours
 *     are matched to the surface as belt-and-braces for any build that still
 *     reserves the cells).
 *
 * `surface` is the background the scrollbox sits on (CANVAS for screen panes,
 * PANEL for inset cards) so the invisible track matches its host. Defaults to
 * `PANEL`, the most common case.
 */
import type { Theme } from "./themes.js";

export function sleekScrollbar(theme: Theme, surface: string = theme.PANEL) {
  return {
    showArrows: false,
    trackOptions: {
      backgroundColor: surface,
      foregroundColor: theme.BORDER,
    },
    arrowOptions: {
      foregroundColor: surface,
      backgroundColor: surface,
    },
  } as const;
}
