/**
 * The single registry of keyboard shortcuts. The global key handlers match events against it and the Shortcuts
 * settings page and dialog render from it, so the documentation cannot drift from what the app handles.
 */
export type ShortcutGroup = "Navigation" | "Missions" | "Panel" | "Editor";
/** `global` bindings must be unique across every scope; the others only within their own scope. */
export type ShortcutScope = "global" | "mission" | "composer";
/** `mod` is Cmd on macOS and Ctrl elsewhere. Bindings without `mod` are plain keys. */
export type Binding = { key: string; mod?: boolean; shift?: boolean; blockWhenTyping?: boolean };
export type Shortcut = {
  id: string;
  action: string;
  group: ShortcutGroup;
  scope: ShortcutScope;
  /** Shown in the When column. */
  when: string;
  bindings: readonly Binding[];
  /** Name of the handler that reacts to this shortcut. Display-only editor rows point at the native control. */
  handler: string;
};

const mod = (key: string, shift = false, blockWhenTyping = false): Binding => ({ key, mod: true, shift, blockWhenTyping });
const panelView = (id: string, action: string, key: string): Shortcut => ({ id: `panel.${id}`, action, group: "Panel", scope: "mission", when: "Mission workspace", bindings: [mod(key, true)], handler: "panel.open-view" });

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette.open", action: "Search anything", group: "Navigation", scope: "global", when: "Always", bindings: [mod("k"), { key: "/" }], handler: "palette.toggle" },
  { id: "settings.open", action: "Open settings", group: "Navigation", scope: "global", when: "Always", bindings: [mod(",")], handler: "navigation.settings" },
  { id: "sidebar.toggle", action: "Toggle sidebar", group: "Navigation", scope: "global", when: "Not typing in a field", bindings: [mod("b", false, true), mod("s", true)], handler: "sidebar.toggle" },
  { id: "shortcuts.open", action: "Keyboard shortcuts", group: "Navigation", scope: "global", when: "Not typing in a field", bindings: [{ key: "?" }], handler: "shortcuts.open" },
  { id: "mission.new", action: "New mission", group: "Missions", scope: "global", when: "Always", bindings: [mod("o", true)], handler: "navigation.new-mission" },
  { id: "composer.focus", action: "Focus composer", group: "Editor", scope: "global", when: "Always", bindings: [mod("i")], handler: "composer.focus" },
  { id: "mission.stop", action: "Stop running mission", group: "Missions", scope: "global", when: "A mission is running", bindings: [mod(".")], handler: "mission.stop" },
  { id: "composer.upload", action: "Attach files", group: "Editor", scope: "global", when: "Composer visible, not typing in another field", bindings: [mod("/")], handler: "composer.upload" },
  { id: "panel.toggle", action: "Toggle right panel", group: "Panel", scope: "mission", when: "Mission workspace", bindings: [mod("b", true)], handler: "panel.toggle-panel" },
  panelView("findings", "Open Findings", "f"),
  panelView("evidence", "Open Evidence", "e"),
  panelView("fixes", "Open Fixes", "g"),
  panelView("browser", "Open Browser", "l"),
  panelView("visuals", "Open Visuals", "v"),
  { id: "composer.send", action: "Send message", group: "Editor", scope: "composer", when: "Composer focused", bindings: [{ key: "Enter" }], handler: "composer.native" },
  { id: "composer.newline", action: "New line", group: "Editor", scope: "composer", when: "Composer focused", bindings: [{ key: "Enter", shift: true }], handler: "composer.native" },
  { id: "composer.choose", action: "Choose command, mention or plugin", group: "Editor", scope: "composer", when: "Suggestions open", bindings: [{ key: "ArrowUp" }, { key: "ArrowDown" }], handler: "composer.native" },
  { id: "composer.insert", action: "Insert suggestion", group: "Editor", scope: "composer", when: "Suggestions open", bindings: [{ key: "Tab" }], handler: "composer.native" },
  { id: "composer.dismiss", action: "Dismiss suggestions", group: "Editor", scope: "composer", when: "Suggestions open", bindings: [{ key: "Escape" }], handler: "composer.native" },
];

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ["Navigation", "Missions", "Panel", "Editor"];

export type KeyLike = { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean };
export type TargetLike = EventTarget | { tagName?: string; isContentEditable?: boolean; closest?(selector: string): unknown } | null | undefined;

/** True when typing must win: inputs, textareas, selects and contenteditable editors. */
export function isTypingTarget(raw: TargetLike): boolean {
  if (!raw) return false;
  const target = raw as { tagName?: string; isContentEditable?: boolean; closest?(selector: string): unknown };
  const tag = target.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return Boolean(target.isContentEditable || target.closest?.("[contenteditable=''], [contenteditable='true']"));
}

/** Does the key event satisfy this binding? Shift is ignored for symbol keys like "?" that need it. */
export function bindingMatches(binding: Binding, event: KeyLike): boolean {
  if (event.altKey) return false;
  const hasMod = Boolean(event.metaKey || event.ctrlKey);
  if (hasMod !== Boolean(binding.mod)) return false;
  const symbol = binding.key.length === 1 && !/[a-z0-9]/i.test(binding.key);
  if (!symbol && Boolean(event.shiftKey) !== Boolean(binding.shift)) return false;
  return event.key.length === 1 ? event.key.toLowerCase() === binding.key.toLowerCase() : event.key === binding.key;
}

/** Plain keys never fire while typing; modified bindings fire unless they opt out (Cmd+B is bold in editors). */
export function bindingBlocked(binding: Binding, target: TargetLike): boolean {
  return (!binding.mod || Boolean(binding.blockWhenTyping)) && isTypingTarget(target);
}

/** Find the registered shortcut an event triggers, honouring focus gating. `scopes` limits which scopes are live. */
export function matchShortcut(event: KeyLike & { target?: TargetLike }, scopes: readonly ShortcutScope[] = ["global"], registry: readonly Shortcut[] = SHORTCUTS): Shortcut | undefined {
  return registry.find(shortcut => scopes.includes(shortcut.scope) && shortcut.handler !== "composer.native"
    && shortcut.bindings.some(binding => bindingMatches(binding, event) && !bindingBlocked(binding, event.target)));
}

/** Pairs of shortcuts that share a binding in overlapping scopes (global overlaps everything). */
export function findBindingCollisions(registry: readonly Shortcut[] = SHORTCUTS): [string, string][] {
  const signature = (b: Binding) => `${b.mod ? "mod+" : ""}${b.shift ? "shift+" : ""}${b.key.toLowerCase()}`;
  const found: [string, string][] = [];
  registry.forEach((a, index) => registry.slice(index + 1).forEach(b => {
    if (a.scope !== b.scope && a.scope !== "global" && b.scope !== "global") return;
    if (a.bindings.some(x => b.bindings.some(y => signature(x) === signature(y)))) found.push([a.id, b.id]);
  }));
  return found;
}

const isMac = () => typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
const keyName = (key: string) => key === "ArrowUp" ? "↑" : key === "ArrowDown" ? "↓" : key === "Escape" ? "Esc" : key.length === 1 ? key.toUpperCase() : key;

/** Key caps for one binding: ["⇧", "⌘", "S"] on macOS, ["Shift", "Ctrl", "S"] elsewhere. */
export function bindingKeys(binding: Binding, mac: boolean = isMac()): string[] {
  return [...(binding.shift ? [mac ? "⇧" : "Shift"] : []), ...(binding.mod ? [mac ? "⌘" : "Ctrl"] : []), keyName(binding.key)];
}

export function shortcutById(id: string): Shortcut {
  const found = SHORTCUTS.find(shortcut => shortcut.id === id);
  if (!found) throw new Error(`Unknown shortcut ${id}`);
  return found;
}

/** Compact hint for tooltips: "⌘B" on macOS, "Ctrl+B" elsewhere. Uses the first binding. */
export function shortcutHint(id: string, mac: boolean = isMac()): string {
  const keys = bindingKeys(shortcutById(id).bindings[0]!, mac);
  return mac ? keys.join("") : keys.join("+");
}

/** Value for `aria-keyshortcuts`, covering every binding. */
export function shortcutAria(id: string): string {
  return shortcutById(id).bindings.map(binding => [...(binding.mod ? ["Meta"] : []), ...(binding.shift ? ["Shift"] : []), keyName(binding.key)].join("+")).flatMap(combo => withControl(combo)).join(" ");
}
const withControl = (combo: string) => combo.includes("Meta+") ? [combo, combo.replace("Meta+", "Control+")] : [combo];

/** Whether a row matches a search query (action, group, when and key text). */
export function shortcutMatchesQuery(shortcut: Shortcut, query: string, mac: boolean = isMac()): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const keys = shortcut.bindings.flatMap(binding => [bindingKeys(binding, mac).join(" "), bindingKeys(binding, mac).join("")]).join(" ");
  return `${shortcut.action} ${shortcut.group} ${shortcut.when} ${keys}`.toLowerCase().includes(q);
}
