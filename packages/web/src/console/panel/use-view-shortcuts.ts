import { useEffect, useRef } from "react";
import { panelViews, type ViewShortcut } from "./registry";
import type { StaticViewId } from "./types";

export type ViewShortcutAction = { type: "toggle-panel" } | { type: "open-view"; id: StaticViewId };
type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;
type TargetLike = { tagName?: string; isContentEditable?: boolean; closest?(selector: string): unknown } | null;

const TOGGLE: ViewShortcut = { key: "b", mod: true, shift: true };

/** True when the keyboard event came from a field where typing must win (composer, inputs). */
export function isEditableTarget(target: TargetLike): boolean {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return Boolean(target.isContentEditable || target.closest?.("[contenteditable=''], [contenteditable='true']"));
}

/** Map a key event to a panel action (Shift+Cmd/Ctrl+key), or undefined. Pure, so it is testable without a DOM. */
export function matchViewShortcut(event: KeyLike): ViewShortcutAction | undefined {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return undefined;
  const key = event.key.toLowerCase();
  const hit = (shortcut: ViewShortcut) => shortcut.key === key && event.shiftKey === shortcut.shift;
  if (hit(TOGGLE)) return { type: "toggle-panel" };
  const view = panelViews.find(item => item.shortcut && hit(item.shortcut));
  return view ? { type: "open-view", id: view.id } : undefined;
}

/**
 * Register the panel shortcuts once per workspace. Every shortcut needs Cmd/Ctrl, so it is safe (and wanted)
 * while the composer has focus; plain typing never matches.
 */
export function useViewShortcuts(onAction: (action: ViewShortcutAction) => void, enabled = true) {
  const latest = useRef(onAction);
  latest.current = onAction;
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = matchViewShortcut(event);
      if (!action) return;
      event.preventDefault();
      latest.current(action);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);
}
