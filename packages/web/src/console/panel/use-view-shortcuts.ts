import { useEffect, useRef } from "react";
import { isTypingTarget, matchShortcut } from "@/lib/shortcuts";
import { panelViews } from "./registry";
import type { StaticViewId } from "./types";

export type ViewShortcutAction = { type: "toggle-panel" } | { type: "open-view"; id: StaticViewId };
type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/** True when the keyboard event came from a field where typing must win (composer, inputs). */
export const isEditableTarget = isTypingTarget;

/** Map a key event to a panel action (Shift+Cmd/Ctrl+key), or undefined. Pure, so it is testable without a DOM. */
export function matchViewShortcut(event: KeyLike): ViewShortcutAction | undefined {
  const hit = matchShortcut(event, ["mission"]);
  if (hit?.id === "panel.toggle") return { type: "toggle-panel" };
  const view = hit && panelViews.find(item => `panel.${item.id}` === hit.id);
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
