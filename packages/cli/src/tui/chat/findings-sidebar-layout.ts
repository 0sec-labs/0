/**
 * Column + row budgeting for the FINDINGS section of the RIGHT sidebar.
 *
 * The FINDINGS section is a sibling of the AGENTS / PLAN sections in the same
 * narrow, fixed-height column. Each finding is a severity-coloured title that
 * must WRAP across a small number of rows (so a long title reads in full) while
 * the whole section stays inside its granted row budget. This module holds the
 * cell arithmetic the component would otherwise inline — how many cells the
 * severity badge claims on line one, and therefore how wide the title's first
 * line may be — and re-exports the shared wrap/budget helpers so the invariants
 * (a row never exceeds its width; the section never exceeds its rows) are unit
 * tests rather than a code review. The generic helpers live with the PLAN
 * section (todos-sidebar-layout.ts); this module adds only the findings shape.
 */

import {
  budgetWrappedRows,
  buildSidebarSectionHeader,
  sidebarBadgeCells,
  wrapCells,
  DEFAULT_WRAP_LINES,
  SIDEBAR_SECTION_HEADER_ROWS,
  type SidebarRowBudget,
} from "./todos-sidebar-layout.js";

export {
  budgetWrappedRows,
  buildSidebarSectionHeader,
  sidebarBadgeCells,
  wrapCells,
  DEFAULT_WRAP_LINES,
  SIDEBAR_SECTION_HEADER_ROWS,
};
export type { SidebarRowBudget };

/** The minimal finding shape the sidebar renders (a structural subset of the
 * screen's `RunFinding`), kept local so this module does not depend on
 * chat-screen. */
export interface SidebarFinding {
  title: string;
  severity: string;
  /** Persisted finding id; present ⇒ the row is clickable. */
  id?: string;
}

/**
 * Cells the trailing severity badge claims on a finding's FIRST line. A thin
 * naming wrapper over the shared {@link sidebarBadgeCells} rhythm, so the
 * FINDINGS severity badge and the AGENTS status badge are budgeted by exactly
 * the same arithmetic and the two sections line up.
 */
export function findingSeverityCells(severity: string, columnWidth: number): number {
  return sidebarBadgeCells(severity, columnWidth);
}

/**
 * Width available to the title on a finding's FIRST line: the column minus the
 * severity badge and its one-cell gap. Continuation lines use the full column
 * width. Clamped to ≥1 so {@link wrapCells} always has a positive budget.
 */
export function findingTitleFirstWidth(columnWidth: number, severityCells: number): number {
  const width = Math.max(1, Math.floor(columnWidth));
  const badge = Math.max(0, Math.floor(severityCells));
  return Math.max(1, width - (badge > 0 ? badge + 1 : 0));
}

/**
 * A finding wrapped for the sidebar: the title's rows (line one already sized
 * for the trailing badge), the badge's cell width, and the total row cost. The
 * component renders these directly; the budgeter sums `rows` across findings.
 */
export interface WrappedFinding {
  finding: SidebarFinding;
  /** Title rows; `lines[0]` fits alongside the badge, the rest fill the column. */
  lines: string[];
  /** Severity badge width in cells (0 ⇒ no badge drawn). */
  severityCells: number;
  /** Rows this finding occupies (== `lines.length`). */
  rows: number;
}

/**
 * Wrap a finding's title to at most `maxLines` rows for a `columnWidth`-wide
 * sidebar, reserving trailing cells on line one for the severity badge.
 */
export function wrapFinding(
  finding: SidebarFinding,
  columnWidth: number,
  maxLines: number = DEFAULT_WRAP_LINES,
): WrappedFinding {
  const severityCells = findingSeverityCells(finding.severity, columnWidth);
  const firstWidth = findingTitleFirstWidth(columnWidth, severityCells);
  const lines = wrapCells(finding.title, columnWidth, maxLines, firstWidth);
  return { finding, lines, severityCells, rows: lines.length };
}
