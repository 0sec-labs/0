import type { ViewShortcut } from "./registry";

const isMac = () => typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** "⇧⌘F" on macOS, "Ctrl+Shift+F" elsewhere. */
export function shortcutLabel(shortcut: ViewShortcut, mac: boolean = isMac()): string {
  const key = shortcut.key.toUpperCase();
  return mac ? `${shortcut.shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shortcut.shift ? "Shift+" : ""}${key}`;
}
