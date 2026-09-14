/**
 * The single source of truth for every keyboard shortcut the chat console
 * (`chat-screen.tsx`) binds.
 *
 * This module is PURE DATA + PURE FUNCTIONS — no React, no OpenTUI, no
 * `@0sec/core` — so it can be imported by the reference view, the settings
 * surface, the settings loader and the runtime resolver alike, and unit-tested
 * without a terminal.
 *
 * ## Accuracy rule
 *
 * Nothing here is invented. Every entry was read off a real `useKeyboard`
 * branch in `chat-screen.tsx`, and each carries a `handler` field quoting the
 * guard it was captured from so the registry can be re-verified against the
 * code. When a single action is reachable by more than one chord (the palette
 * on Ctrl+P *or* Ctrl+K, scrolling on PageUp *or* Ctrl+Up), the alternates are
 * shown together in one `keys` string rather than split into look-alike rows,
 * and every accepted chord appears in {@link Keybinding.defaultChords}.
 *
 * Modal overlays (the command/theme/model picker, the approval and
 * `ask_operator` cards, the secret-entry prompt) reuse Up/Down to move,
 * Enter to confirm and Esc to cancel — the same keys documented here for the
 * base composer, given a modal meaning while the overlay is up. They are not
 * repeated as separate entries; the descriptions below name those meanings.
 *
 * ## Live remapping — the rebindable set
 *
 * A {@link Keybinding} now carries a machine-readable {@link Keybinding.defaultChords}
 * (a canonical `"ctrl+b"` / `"pageup"` string, parseable back to a chord) and a
 * {@link Keybinding.rebindable} flag. Only the flagged bindings may be remapped
 * by an operator; the rest — text entry, Enter/Shift+Enter, Esc, Ctrl+C, the
 * Shift+Tab mode-cycle and the overloaded Up/Down/Tab — are structurally
 * protected and their chords are reserved (see {@link reservedChords}) so a
 * rebind can never steal them. `chat-screen.tsx`'s handlers for the rebindable
 * set consult {@link matchesBinding} against the persisted overrides map rather
 * than their old hard-coded `key.name === …` guards; the protected set keeps
 * its literal guards on purpose.
 */

/** The surface each shortcut belongs to, used to group the reference view. */
export type KeybindingCategory =
  | "Composer"
  | "Navigation"
  | "Session"
  | "View"
  | "Autonomy";

export interface Keybinding {
  /**
   * A stable, unique identifier — the key the overrides store uses. Never shown
   * to the operator; safe to rely on across releases.
   */
  readonly id: string;
  /** The chord(s), formatted for display, e.g. "Ctrl+B" or "PageUp / Ctrl+Up". */
  readonly keys: string;
  /**
   * Every chord this action answers to, in canonical machine form (e.g.
   * `["ctrl+b"]`, `["pageup", "ctrl+up"]`). The parseable counterpart of the
   * display-only {@link Keybinding.keys}: this is what the resolver, the
   * conflict detector and the load-time validator compare against. A rebindable
   * binding always has exactly one entry here (the thing the override replaces).
   */
  readonly defaultChords: readonly string[];
  /**
   * Whether an operator may remap this binding. `false` for the structurally
   * protected set (text entry, submit/newline, escape, quit, the mode-cycle and
   * the overloaded arrows/Tab); `true` only for the self-contained View toggles.
   * Both the editor and the resolver refuse to touch a `false` binding, and its
   * chords are reserved so nothing can be rebound onto them.
   */
  readonly rebindable: boolean;
  /** One line describing what the chord does. */
  readonly description: string;
  readonly category: KeybindingCategory;
  /**
   * The `chat-screen.tsx` guard this binding was captured from, quoted verbatim
   * so the registry can be checked against the handler that implements it. Not
   * rendered — this is provenance for maintainers, not operator-facing help.
   */
  readonly handler: string;
}

/**
 * Every keyboard shortcut the chat console binds, in reading order by category.
 *
 * The order within a category is roughly by how often an operator reaches for
 * the key, not alphabetical, so the reference reads top-to-bottom like a
 * cheat-sheet.
 */
export const KEYBINDINGS: readonly Keybinding[] = [
  // ── Composer ──────────────────────────────────────────────────────────────
  {
    id: "composer.send",
    keys: "Enter",
    defaultChords: ["return"],
    rebindable: false,
    description:
      "Send the message or run the highlighted slash command; queues the line when a turn is already in flight.",
    category: "Composer",
    handler: 'if (key.name === "return") { … send / queue / dequeue }',
  },
  {
    id: "composer.newline",
    keys: "Shift+Enter",
    defaultChords: ["shift+return"],
    rebindable: false,
    description:
      "Insert a newline instead of sending (terminals without the kitty protocol fall through to send).",
    category: "Composer",
    handler: 'if (key.name === "return" && key.shift) setComposerText(`${…}\\n`)',
  },
  {
    id: "composer.complete-command",
    keys: "Tab",
    defaultChords: ["tab"],
    rebindable: false,
    description: "Complete the highlighted slash command in the command menu.",
    category: "Composer",
    handler:
      'if (key.name === "tab") setComposerText(completionFor(selectedSlashCommand, …))',
  },
  {
    id: "composer.edit-queued",
    keys: "Ctrl+Y",
    defaultChords: ["ctrl+y"],
    rebindable: false,
    description:
      "Pull the most recently queued message back into the composer to edit, re-send, or drop.",
    category: "Composer",
    handler:
      'if (key.ctrl && key.name === "y" && queuedRef.current.length > 0) …',
  },
  {
    id: "composer.delete-word",
    keys: "Ctrl+W / Alt+Backspace",
    defaultChords: ["ctrl+w", "option+backspace"],
    rebindable: false,
    description: "Delete the word before the cursor.",
    category: "Composer",
    handler:
      'if (key.ctrl && key.name === "w") / if (key.name === "backspace" && (key.meta || key.option || key.ctrl)) → deletePreviousWord',
  },
  {
    id: "composer.delete-to-start",
    keys: "Ctrl+U",
    defaultChords: ["ctrl+u"],
    rebindable: false,
    description: "Delete from the cursor to the start of the line.",
    category: "Composer",
    handler: 'if (key.ctrl && key.name === "u") → deleteToLineStart',
  },

  // ── Navigation ──────────────────────────────────────────────────────────────
  {
    id: "nav.palette",
    keys: "Ctrl+P / Ctrl+K",
    defaultChords: ["ctrl+p", "ctrl+k"],
    rebindable: false,
    description: "Open the slash-command palette.",
    category: "Navigation",
    handler: 'if (key.ctrl && (key.name === "p" || key.name === "k")) setComposerText("/")',
  },
  {
    id: "nav.history-prev",
    keys: "Up",
    defaultChords: ["up"],
    rebindable: false,
    description:
      "Recall the previous submitted message into the composer (also moves the selection in menus and overlays).",
    category: "Navigation",
    handler: 'if (key.name === "up") recallComposerHistory("up")',
  },
  {
    id: "nav.history-next",
    keys: "Down",
    defaultChords: ["down"],
    rebindable: false,
    description:
      "Recall the next message, or — on an empty composer with workers running — drop into the active-subagents list.",
    category: "Navigation",
    handler:
      'if (key.name === "down") { setAgentNavIndex(0) | recallComposerHistory("down") }',
  },
  {
    id: "nav.escape",
    keys: "Esc",
    defaultChords: ["escape"],
    rebindable: false,
    description:
      "Step back one level: close the command menu, then clear the draft, then interrupt a running turn, then leave the screen.",
    category: "Navigation",
    handler: 'if (key.name === "escape") { … interruptTurn() … onGoBack() }',
  },
  {
    id: "nav.scroll-up",
    keys: "PageUp / Ctrl+Up",
    defaultChords: ["pageup", "ctrl+up"],
    rebindable: false,
    description: "Scroll the transcript up by half a viewport.",
    category: "Navigation",
    handler:
      'if (key.name === "pageup" || (key.ctrl && key.name === "up")) transcriptRef.current?.scrollBy(-0.5, "viewport")',
  },
  {
    id: "nav.scroll-down",
    keys: "PageDown / Ctrl+Down",
    defaultChords: ["pagedown", "ctrl+down"],
    rebindable: false,
    description: "Scroll the transcript down by half a viewport.",
    category: "Navigation",
    handler:
      'if (key.name === "pagedown" || (key.ctrl && key.name === "down")) transcriptRef.current?.scrollBy(0.5, "viewport")',
  },
  {
    id: "nav.focus-subagent",
    keys: "Enter",
    defaultChords: ["return"],
    rebindable: false,
    description:
      "In the active-subagents list, drill into the highlighted subagent's live focus view.",
    category: "Navigation",
    handler: 'if (agentNavIndex >= 0) { if (key.name === "return") setFocusAgentId(agent.agent_id) }',
  },
  {
    id: "nav.leave-subagent",
    keys: "Left / Esc",
    defaultChords: ["left", "escape"],
    rebindable: false,
    description:
      "Return from the active-subagents list or a subagent focus view back to the composer.",
    category: "Navigation",
    handler:
      'if (focusAgentId) / if (agentNavIndex >= 0) { if (key.name === "escape" || key.name === "left") … }',
  },

  // ── Session ─────────────────────────────────────────────────────────────────
  {
    id: "session.quit",
    keys: "Ctrl+C",
    defaultChords: ["ctrl+c"],
    rebindable: false,
    description: "Press twice within 3 seconds to quit; the first press arms and warns.",
    category: "Session",
    handler: 'if (key.ctrl && key.name === "c") requestExitRef.current()',
  },

  // ── View ────────────────────────────────────────────────────────────────────
  // The only rebindable set: self-contained, stateless toggles that call
  // `updateSetting(...)` and take no part in text entry or modal cycles.
  {
    id: "view.left-sidebar",
    keys: "Ctrl+B",
    defaultChords: ["ctrl+b"],
    rebindable: true,
    description: "Toggle the left sidebar (persists across the session).",
    category: "View",
    handler: 'if (matchesBinding(key, "view.left-sidebar", …)) updateSetting("showLeftSidebar", …)',
  },
  {
    id: "view.right-sidebar",
    keys: "Ctrl+L",
    defaultChords: ["ctrl+l"],
    rebindable: true,
    description: "Toggle the right sidebar (persists across the session).",
    category: "View",
    handler: 'if (matchesBinding(key, "view.right-sidebar", …)) updateSetting("showRightSidebar", …)',
  },
  {
    id: "view.transcript-detail",
    keys: "Ctrl+R",
    defaultChords: ["ctrl+r"],
    rebindable: true,
    description:
      "Toggle the whole transcript between collapsed and expanded tool/reasoning detail (persists across the session).",
    category: "View",
    handler:
      'if (matchesBinding(key, "view.transcript-detail", …)) updateSetting("transcriptDetail", …)',
  },

  // ── Autonomy ─────────────────────────────────────────────────────────────────
  {
    id: "autonomy.cycle-mode",
    keys: "Shift+Tab",
    defaultChords: ["shift+tab"],
    rebindable: false,
    description:
      "Cycle the autonomy mode: Standard → Co-pilot → YOLO → Recon; no preconfigured scope is required.",
    category: "Autonomy",
    handler: 'if (isAutonomyCycleKey(key)) routeSlashCommand(`/mode ${next}`)',
  },
] as const;

/** The category order the reference view renders in. */
export const KEYBINDING_CATEGORIES: readonly KeybindingCategory[] = [
  "Composer",
  "Navigation",
  "Session",
  "View",
  "Autonomy",
];

/**
 * Group the registry by category, preserving both the category order in
 * {@link KEYBINDING_CATEGORIES} and each binding's order within its category.
 *
 * Only categories that actually have bindings appear in the returned map, so a
 * consumer can iterate it directly without emitting an empty heading. Any
 * binding whose category is somehow outside the known list is still included,
 * appended after the known ones, so nothing is silently dropped.
 */
export function keybindingsByCategory(
  bindings: readonly Keybinding[] = KEYBINDINGS,
): Map<KeybindingCategory, Keybinding[]> {
  const grouped = new Map<KeybindingCategory, Keybinding[]>();
  const push = (binding: Keybinding) => {
    const existing = grouped.get(binding.category);
    if (existing) existing.push(binding);
    else grouped.set(binding.category, [binding]);
  };

  // Emit in the canonical category order first…
  for (const category of KEYBINDING_CATEGORIES) {
    for (const binding of bindings) {
      if (binding.category === category) push(binding);
    }
  }
  // …then anything with an unknown category, so it is surfaced rather than lost.
  for (const binding of bindings) {
    if (!KEYBINDING_CATEGORIES.includes(binding.category)) push(binding);
  }

  return grouped;
}

// ===========================================================================
// Chord model — a machine-readable, parseable representation of a key combo
// ===========================================================================

/**
 * A single key combination, decomposed into its modifiers and OpenTUI key name.
 * `name` is the lower-cased `key.name` OpenTUI reports (e.g. `"b"`, `"pageup"`,
 * `"up"`, `"escape"`, `"return"`). This is what {@link chordFromKey} produces
 * from a live keypress and what {@link parseChord} produces from a stored
 * string, so the two can be compared with {@link formatChord}.
 */
export interface Chord {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly option: boolean;
  readonly name: string;
}

/** The subset of an OpenTUI `ParsedKey` the chord model reads. */
export interface KeyLike {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
}

/** Modifier tokens accepted on input, mapped to the canonical modifier. */
const MODIFIER_ALIASES: Readonly<Record<string, "ctrl" | "shift" | "meta" | "option">> = {
  ctrl: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  option: "option",
  opt: "option",
  alt: "option",
};

/** Key-name tokens accepted on input, mapped to the canonical OpenTUI name. */
const NAME_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  escape: "escape",
  enter: "return",
  return: "return",
  ret: "return",
  pgup: "pageup",
  pageup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  pagedown: "pagedown",
  del: "delete",
  ins: "insert",
  space: "space",
  spacebar: "space",
};

/**
 * Canonical string for a chord: modifiers in a fixed order (ctrl, shift, meta,
 * option) then the key name, lower-case, joined by `+`. This is the ONLY string
 * the overrides map ever stores and the ONLY string comparisons happen on, so a
 * chord read from disk and a chord captured from a keypress collapse to the same
 * text regardless of how they were spelled.
 */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.shift) parts.push("shift");
  if (chord.meta) parts.push("meta");
  if (chord.option) parts.push("option");
  parts.push(chord.name);
  return parts.join("+");
}

/**
 * Parse a chord string ("ctrl+b", "Ctrl+B", "Alt+Backspace", "pageup") into a
 * {@link Chord}, tolerating case, modifier aliases and surrounding whitespace.
 * Returns `null` for anything it cannot make sense of — an empty string, a
 * modifier with no key, or two key names — rather than throwing. Version
 * tolerant: an unknown modifier token makes the whole chord invalid (dropped)
 * rather than being silently ignored, because a chord we cannot faithfully
 * round-trip must not be trusted as a binding.
 */
export function parseChord(input: unknown): Chord | null {
  if (typeof input !== "string") return null;
  const tokens = input
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;

  let ctrl = false;
  let shift = false;
  let meta = false;
  let option = false;
  let name: string | undefined;

  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token];
    if (modifier) {
      if (modifier === "ctrl") ctrl = true;
      else if (modifier === "shift") shift = true;
      else if (modifier === "meta") meta = true;
      else option = true;
      continue;
    }
    // A second bare token means two key names in one chord — unparseable.
    if (name !== undefined) return null;
    // A real key name is a single word; internal whitespace ("not a chord")
    // is free text, not a chord, and must be reported unparseable so callers
    // render it verbatim rather than capitalising a sentence.
    if (/\s/.test(token)) return null;
    name = NAME_ALIASES[token] ?? token;
  }

  if (name === undefined || name.length === 0) return null;
  return { ctrl, shift, meta, option, name };
}

/** Build a {@link Chord} from a live keypress, or `null` when it carries no name. */
export function chordFromKey(key: KeyLike): Chord | null {
  const name = typeof key.name === "string" ? key.name.toLowerCase() : "";
  if (name.length === 0) return null;
  return {
    ctrl: Boolean(key.ctrl),
    shift: Boolean(key.shift),
    meta: Boolean(key.meta),
    option: Boolean(key.option),
    name,
  };
}

/**
 * Whether a live keypress matches a chord string ("ctrl+a", "Ctrl+Space", …).
 * Pure and total: an unparseable chord, or a keypress carrying no name, never
 * matches (returns `false`) rather than throwing. Both sides collapse to the
 * canonical {@link formatChord} text, so spelling/case/alias differences do not
 * matter. Used by the roster views to detect the optional `leaderKey` prefix
 * chord without re-deriving the modifier logic.
 */
export function keyMatchesChord(key: KeyLike, chord: unknown): boolean {
  if (typeof chord !== "string" || chord.length === 0) return false;
  const parsed = parseChord(chord);
  if (!parsed) return false;
  const pressed = chordFromKey(key);
  if (!pressed) return false;
  return formatChord(pressed) === formatChord(parsed);
}

/**
 * Whether a chord may be *assigned* to a rebindable action. A chord must carry
 * at least one of Ctrl / Meta / Option so it cannot collide with plain typing
 * (the composer's catch-all appends any un-modified printable sequence), and it
 * must name a key. This is deliberately conservative: plain and Shift-only keys
 * are refused so a rebind can never steal a character from the composer.
 */
export function isAssignableChord(chord: Chord | null): boolean {
  if (!chord || chord.name.length === 0) return false;
  return chord.ctrl || chord.meta || chord.option;
}

// ===========================================================================
// Resolver, reserved chords and conflict detection
// ===========================================================================

/** The ids an operator may remap — the rebindable set, derived from the registry. */
export const REBINDABLE_IDS: ReadonlySet<string> = new Set(
  KEYBINDINGS.filter((binding) => binding.rebindable).map((binding) => binding.id),
);

/** True when `id` names a binding an operator may remap. */
export function isRebindableId(id: string): boolean {
  return REBINDABLE_IDS.has(id);
}

/**
 * The effective chords for one binding: the operator's override when the
 * binding is rebindable and the override parses to an assignable chord,
 * otherwise the binding's own defaults. A rebindable binding resolves to a
 * single chord; a protected multi-chord binding keeps all of its defaults.
 */
export function effectiveChords(
  binding: Keybinding,
  overrides: Record<string, string> | undefined,
): string[] {
  if (binding.rebindable && overrides) {
    const raw = overrides[binding.id];
    const parsed = parseChord(raw);
    if (parsed && isAssignableChord(parsed)) return [formatChord(parsed)];
  }
  return [...binding.defaultChords];
}

/**
 * The set of chords that are reserved because a NON-rebindable (protected)
 * binding owns them: Ctrl+C, Esc, Enter, Shift+Tab, the arrows, Tab, and the
 * composer edit chords. Nothing may be rebound onto one of these.
 */
export function reservedChords(bindings: readonly Keybinding[] = KEYBINDINGS): Set<string> {
  const reserved = new Set<string>();
  for (const binding of bindings) {
    if (binding.rebindable) continue;
    for (const chord of binding.defaultChords) reserved.add(chord);
  }
  return reserved;
}

/**
 * Does a live keypress match the effective chord of the binding `id`?
 *
 * This is the runtime authority the chat-screen handlers call in place of their
 * old `key.name === …` literals: it reads the override map, falls back to the
 * default, and compares canonical forms. An unknown id, a nameless key or a
 * binding with no chord all resolve to `false` rather than throwing.
 */
export function matchesBinding(
  key: KeyLike,
  id: string,
  overrides?: Record<string, string>,
  bindings: readonly Keybinding[] = KEYBINDINGS,
): boolean {
  const binding = bindings.find((entry) => entry.id === id);
  if (!binding) return false;
  const chord = chordFromKey(key);
  if (!chord) return false;
  return effectiveChords(binding, overrides).includes(formatChord(chord));
}

export interface KeybindingConflict {
  /** The canonical chord two or more actions want. */
  chord: string;
  /** The ids fighting over it (the rebindable overrides plus any reserved owner). */
  ids: string[];
}

/**
 * Which id owns a reserved chord, for naming it in a conflict message. Returns
 * the first protected binding whose defaults include `chord`, or `undefined`.
 */
function reservedOwner(bindings: readonly Keybinding[], chord: string): Keybinding | undefined {
  return bindings.find((binding) => !binding.rebindable && binding.defaultChords.includes(chord));
}

/**
 * Detect two-actions-on-one-chord conflicts, given a pending overrides map.
 *
 * Only rebindable bindings are bucketed against each other (the protected set
 * legitimately reuses Enter/Esc across contexts, so it is never bucketed with
 * itself); a rebindable chord that lands on a RESERVED chord is also reported,
 * naming the protected owner. With the default map (`{}`) there are no
 * conflicts — every rebindable default is unique and none is reserved — so the
 * editor and the loader can both treat a non-empty result as "reject".
 */
export function detectConflicts(
  bindings: readonly Keybinding[],
  overrides: Record<string, string>,
): KeybindingConflict[] {
  const byChord = new Map<string, string[]>();
  for (const binding of bindings) {
    if (!binding.rebindable) continue;
    const chord = effectiveChords(binding, overrides)[0];
    if (!chord) continue;
    const existing = byChord.get(chord);
    if (existing) existing.push(binding.id);
    else byChord.set(chord, [binding.id]);
  }

  const reserved = reservedChords(bindings);
  const conflicts: KeybindingConflict[] = [];
  for (const [chord, ids] of byChord) {
    const owner = reserved.has(chord) ? reservedOwner(bindings, chord) : undefined;
    if (ids.length > 1 || owner) {
      conflicts.push({ chord, ids: owner ? [...ids, owner.id] : [...ids] });
    }
  }
  return conflicts;
}

export type ChordAssessment =
  | { kind: "ok"; chord: string }
  | { kind: "unassignable"; chord: string }
  | { kind: "conflict"; chord: string; conflictId: string; conflictLabel: string };

/**
 * Assess assigning a captured keypress to the rebindable binding `id`, against
 * the CURRENT overrides map. The editor calls this the instant a chord is
 * captured: `ok` means it is safe to write, `unassignable` means it would steal
 * plain typing (no Ctrl/Meta/Option), and `conflict` names the other action —
 * rebindable or protected — that already owns the chord. Returns `null` for a
 * non-rebindable / unknown id or a nameless key.
 */
export function assessChordAssignment(
  id: string,
  key: KeyLike,
  overrides: Record<string, string>,
  bindings: readonly Keybinding[] = KEYBINDINGS,
): ChordAssessment | null {
  const target = bindings.find((entry) => entry.id === id);
  if (!target || !target.rebindable) return null;
  const chord = chordFromKey(key);
  if (!chord) return null;
  const canonical = formatChord(chord);

  if (!isAssignableChord(chord)) return { kind: "unassignable", chord: canonical };

  const owner = reservedOwner(bindings, canonical);
  if (owner) {
    return { kind: "conflict", chord: canonical, conflictId: owner.id, conflictLabel: owner.description };
  }
  for (const binding of bindings) {
    if (binding.id === id || !binding.rebindable) continue;
    if (effectiveChords(binding, overrides)[0] === canonical) {
      return { kind: "conflict", chord: canonical, conflictId: binding.id, conflictLabel: binding.description };
    }
  }
  return { kind: "ok", chord: canonical };
}

/**
 * Total, pure, never-throwing coercion of a persisted `keybindings` value into
 * a clean overrides map — the load-time defensive twin of the editor's
 * edit-time guard.
 *
 * A hand-edited settings file can carry anything: this keeps only entries whose
 * id is rebindable, whose value parses to an ASSIGNABLE chord, that do not land
 * on a reserved (protected) chord, and that do not fight another accepted entry
 * for the same chord (a conflicting override is dropped — reverting that action
 * to its unique default — rather than resolved arbitrarily). Every kept value
 * is stored in canonical form, so what lands in memory and back on disk is
 * already normalised.
 */
export function sanitizeKeybindingOverrides(
  raw: unknown,
  bindings: readonly Keybinding[] = KEYBINDINGS,
): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const reserved = reservedChords(bindings);
  const candidates: Record<string, string> = {};

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!REBINDABLE_IDS.has(id)) continue;
    const parsed = parseChord(value);
    if (!parsed || !isAssignableChord(parsed)) continue;
    const canonical = formatChord(parsed);
    if (reserved.has(canonical)) continue;
    candidates[id] = canonical;
  }

  // Drop any override that collides with another rebindable binding's effective
  // chord (override or default). The loser reverts to its own default, which is
  // guaranteed unique, so the result is always conflict-free.
  const occupied = new Map<string, string[]>();
  for (const binding of bindings) {
    if (!binding.rebindable) continue;
    const chord = candidates[binding.id] ?? binding.defaultChords[0];
    if (!chord) continue;
    const existing = occupied.get(chord);
    if (existing) existing.push(binding.id);
    else occupied.set(chord, [binding.id]);
  }
  for (const [, ids] of occupied) {
    if (ids.length <= 1) continue;
    for (const id of ids) delete candidates[id];
  }

  return candidates;
}
