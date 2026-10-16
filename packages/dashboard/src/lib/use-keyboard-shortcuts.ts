import { useEffect, useEffectEvent } from "react";
type BrowserCommand = "new-thread" | "open-folder" | "toggle-sidebar" | "settings";

const SHORTCUTS: Readonly<Record<string, BrowserCommand>> = {
  n: "new-thread",
  o: "open-folder",
  b: "toggle-sidebar",
  ",": "settings",
};

export function useKeyboardShortcuts(handler: (command: BrowserCommand) => void): void {
  const onCommand = useEffectEvent(handler);

  useEffect(() => {
    const isMac = navigator.platform.includes("Mac");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
      if (!(isMac ? event.metaKey : event.ctrlKey)) return;
      const command = SHORTCUTS[event.key.toLowerCase()];
      if (!command) return;
      event.preventDefault();
      onCommand(command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
