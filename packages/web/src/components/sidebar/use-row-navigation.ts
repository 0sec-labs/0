import type { KeyboardEvent } from "react";

/** Arrow keys, Home and End move focus between rows (`data-sidebar-row`); Enter activates the focused link natively. */
export function rowNavigation(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-sidebar-row]"));
  if (!rows.length) return;
  const current = rows.findIndex(row => row === document.activeElement || row.contains(document.activeElement));
  const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : event.key === "ArrowDown" ? Math.min(rows.length - 1, current + 1) : Math.max(0, current < 0 ? 0 : current - 1);
  event.preventDefault();
  rows[next]?.focus();
}
