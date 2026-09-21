import { VERSION } from "@0/shared"

export const SHELL_HORIZONTAL_PADDING = 2;
export const PANEL_HORIZONTAL_CHROME = 4;
const OVERLAY_MIN_GUTTER = 2;
const OVERLAY_MAX_WIDTH = 84;
export const SESSION_LAYOUT_GAP = 2;
// A scrollbox reveals its vertical scrollbar the moment its content
// overflows, and the bar takes a column out of the viewport. That is exactly
// the case a list has to survive, so every scrolled column budgets for it.
export const SCROLLBAR_COLUMN = 1;
const SESSION_MIN_TRANSCRIPT_WIDTH = 56;
const SESSION_MIN_SIDEBAR_WIDTH = 28;
const SESSION_MAX_SIDEBAR_WIDTH = 40;
const SESSION_MIN_SIDEBAR_HEIGHT = 22;
// BrandStamp paints "0sec" and " v<version>" as two adjacent auto-width
// <text> nodes. VERSION is a build-time string, so a prerelease suffix
// silently widens the stamp; without reserving those cells up front the
// footer hint next to it is shrunk and the two fuse.
/** The build-channel badge shown after the version, e.g. " [dev]" / " [beta]". */
export const CHANNEL_BADGE_WIDTH = " [beta]".length;
export const BRAND_STAMP_WIDTH = "0sec".length + " v".length + VERSION.length + CHANNEL_BADGE_WIDTH;
// Below this HeaderBar stacks its two columns, which costs two extra rows.
const HEADER_COMPACT_WIDTH = 88;
// Overlays are anchored at 12% of the terminal height.
const OVERLAY_TOP_RATIO = 0.12;

/**
 * Rows ShellFrame spends before a screen's own content: one row of top
 * padding, the single-row colored HeaderBar strip and its bottom margin
 * (no divider row, no leading rail anymore — two rows fewer than the old
 * title + gap + divider + margin stack), and FooterBar's single row. Screens that render a
 * bordered list need this to know how many rows they may actually claim —
 * a box that asks for more is shrunk by Yoga and then draws its own bottom
 * border straight through its last row.
 */
export function getShellChromeHeight(terminalWidth: number): number {
  const headerContentWidth = terminalWidth - SHELL_HORIZONTAL_PADDING * 2 - PANEL_HORIZONTAL_CHROME;
  const headerContentRows = headerContentWidth < HEADER_COMPACT_WIDTH ? 4 : 2;
  return 1 + (headerContentRows + 1) + 1;
}

/** Rows an overlay may fill between its title row and its footer row. */
export function getOverlayBodyRows(terminalHeight: number): number {
  // 2 border rows + title row + footer row.
  return Math.max(1, terminalHeight - Math.floor(terminalHeight * OVERLAY_TOP_RATIO) - 4);
}

export function getOverlayLayout(terminalWidth: number): {
  left: number;
  width: number;
  contentWidth: number;
} {
  const availableWidth = Math.max(1, terminalWidth - OVERLAY_MIN_GUTTER * 2);
  const width = Math.min(OVERLAY_MAX_WIDTH, availableWidth);
  return {
    left: Math.max(0, Math.floor((terminalWidth - width) / 2)),
    width,
    contentWidth: Math.max(1, width - PANEL_HORIZONTAL_CHROME),
  };
}

export function getSessionLayout(terminalWidth: number, terminalHeight: number): {
  contentWidth: number;
  transcriptWidth: number;
  sidebarWidth: number;
  sidebarCanFit: boolean;
} {
  const contentWidth = Math.max(1, terminalWidth - SHELL_HORIZONTAL_PADDING * 2);
  const sidebarWidth = Math.max(
    SESSION_MIN_SIDEBAR_WIDTH,
    Math.min(SESSION_MAX_SIDEBAR_WIDTH, Math.floor(contentWidth * 0.3)),
  );
  const transcriptWidth = Math.max(1, contentWidth - SESSION_LAYOUT_GAP - sidebarWidth);

  return {
    contentWidth,
    transcriptWidth,
    sidebarWidth,
    sidebarCanFit: terminalHeight >= SESSION_MIN_SIDEBAR_HEIGHT
      && transcriptWidth >= SESSION_MIN_TRANSCRIPT_WIDTH,
  };
}

/**
 * Cell budget for the footer row. The brand stamp is the one sibling that
 * must never be clipped, so it is reserved first and everything else is
 * derived from the remainder. The previous budget subtracted a flat 30
 * cells for the status but then handed the status text `contentWidth - 12`
 * to fill, so a long counter was painted straight through the wordmark.
 */
export function getFooterLayout(terminalWidth: number, hasStatus: boolean): {
  inline: boolean;
  contentWidth: number;
  hintWidth: number;
  statusWidth: number;
  statusGap: number;
} {
  const contentWidth = Math.max(1, terminalWidth - SHELL_HORIZONTAL_PADDING * 2);
  const inline = contentWidth >= 64;
  const statusGap = hasStatus ? 2 : 0;
  // Inline, the hint keeps at least eight cells; stacked, the status owns a
  // row of its own and only has to leave room for the stamp beside it.
  const statusRoom = Math.max(1, contentWidth - BRAND_STAMP_WIDTH - statusGap - (inline ? 8 : 0));
  const statusWidth = hasStatus
    ? Math.max(1, Math.min(Math.floor(contentWidth * 0.4), statusRoom))
    : 0;
  const hintWidth = inline
    ? Math.max(1, contentWidth - BRAND_STAMP_WIDTH - statusWidth - statusGap)
    : contentWidth;

  return { inline, contentWidth, hintWidth, statusWidth, statusGap };
}
