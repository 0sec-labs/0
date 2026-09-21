import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { AppContext } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import type { ShellNav } from "./shell-nav.js";

const RouteHistoryBlocks = createContext<Set<symbol> | null>(null);

/** Legacy screen-local overlays own input just like stack-based popups. */
export function useBlockRouteHistory() {
  const blocks = useContext(RouteHistoryBlocks);
  useLayoutEffect(() => {
    const id = Symbol();
    blocks?.add(id);
    return () => { blocks?.delete(id); };
  }, [blocks]);
}

/** Mounted inside PopupStackProvider: nested popups suspend these shortcuts too.
 * Escape remains screen-owned so it can unwind an edit/filter before a route.
 */
export function RouteHistoryKeys({ shell, enabled, children }: { shell: ShellNav; enabled: boolean; children: ReactNode }) {
  const { keyHandler } = useContext(AppContext);
  const blocks = useRef(new Set<symbol>());
  useEffect(() => {
    if (!enabled || !keyHandler) return;
    const handle = (key: KeyEvent) => {
      if (blocks.current.size) return;
      if (!(key.option || key.meta) || key.ctrl || key.shift) return;
      if (key.name !== "left" && key.name !== "right") return;
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "left") shell.goBack();
      else shell.goForward();
    };
    keyHandler.prependListener("keypress", handle);
    return () => { keyHandler.off("keypress", handle); };
  }, [enabled, keyHandler, shell]);
  return <RouteHistoryBlocks.Provider value={blocks.current}>{children}</RouteHistoryBlocks.Provider>;
}
