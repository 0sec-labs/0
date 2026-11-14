/**
 * Validation of persisted keybinding overrides. Only the rebindable ids and
 * their default chords are kept; the interactive TUI that consumed the rest of
 * the registry no longer exists.
 */

interface Binding {
  readonly id: string;
  readonly rebindable: boolean;
  readonly defaultChords: readonly string[];
}

const BINDINGS: readonly Binding[] = [
  { id: "composer.send", rebindable: false, defaultChords: ["return"] },
  { id: "composer.newline", rebindable: false, defaultChords: ["shift+return"] },
  { id: "composer.complete-command", rebindable: false, defaultChords: ["tab"] },
  { id: "composer.edit-queued", rebindable: true, defaultChords: ["ctrl+y"] },
  { id: "composer.delete-word", rebindable: false, defaultChords: ["ctrl+w","option+backspace"] },
  { id: "composer.delete-to-start", rebindable: false, defaultChords: ["ctrl+u"] },
  { id: "composer.accept-suggestion", rebindable: false, defaultChords: ["right"] },
  { id: "nav.palette", rebindable: true, defaultChords: ["ctrl+p","ctrl+k"] },
  { id: "nav.history-prev", rebindable: false, defaultChords: ["up"] },
  { id: "nav.history-next", rebindable: false, defaultChords: ["down"] },
  { id: "nav.jump-agents", rebindable: true, defaultChords: ["ctrl+g"] },
  { id: "nav.open-comms", rebindable: true, defaultChords: ["ctrl+t"] },
  { id: "nav.escape", rebindable: false, defaultChords: ["escape"] },
  { id: "nav.scroll-up", rebindable: true, defaultChords: ["pageup","ctrl+up"] },
  { id: "nav.scroll-down", rebindable: true, defaultChords: ["pagedown","ctrl+down"] },
  { id: "nav.focus-subagent", rebindable: false, defaultChords: ["return"] },
  { id: "nav.leave-subagent", rebindable: false, defaultChords: ["left","escape"] },
  { id: "session.quit", rebindable: false, defaultChords: ["ctrl+c"] },
  { id: "view.transcript-detail", rebindable: true, defaultChords: ["ctrl+r"] },
  { id: "autonomy.cycle-mode", rebindable: false, defaultChords: ["shift+tab"] },
];

interface Chord {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly option: boolean;
  readonly name: string;
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

function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.shift) parts.push("shift");
  if (chord.meta) parts.push("meta");
  if (chord.option) parts.push("option");
  parts.push(chord.name);
  return parts.join("+");
}


function parseChord(input: unknown): Chord | null {
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


/** A chord must carry Ctrl, Meta or Option so it cannot steal plain typing. */
function isAssignableChord(chord: Chord | null): boolean {
  if (!chord || chord.name.length === 0) return false;
  return chord.ctrl || chord.meta || chord.option;
}

const REBINDABLE_IDS: ReadonlySet<string> = new Set(
  BINDINGS.filter((binding) => binding.rebindable).map((binding) => binding.id),
);

function effectiveChords(binding: Binding, overrides: Record<string, string> | undefined): string[] {
  if (binding.rebindable && overrides) {
    const parsed = parseChord(overrides[binding.id]);
    if (parsed && isAssignableChord(parsed)) return [formatChord(parsed)];
  }
  return [...binding.defaultChords];
}

function reservedChords(bindings: readonly Binding[]): Set<string> {
  const reserved = new Set<string>();
  for (const binding of bindings) {
    if (binding.rebindable) continue;
    for (const chord of binding.defaultChords) reserved.add(chord);
  }
  return reserved;
}

/**
 * Total, never-throwing coercion of a persisted `keybindings` value into a
 * clean, conflict-free overrides map of canonical chords.
 */
export function sanitizeKeybindingOverrides(
  raw: unknown,
  bindings: readonly Binding[] = BINDINGS,
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
    // An accepted candidate replaces with its single chord; an un-overridden
    // binding still occupies ALL of its default chords, so bucket every one.
    for (const chord of effectiveChords(binding, candidates)) {
      if (!chord) continue;
      const existing = occupied.get(chord);
      if (existing) {
        if (!existing.includes(binding.id)) existing.push(binding.id);
      } else occupied.set(chord, [binding.id]);
    }
  }
  for (const [, ids] of occupied) {
    if (ids.length <= 1) continue;
    for (const id of ids) delete candidates[id];
  }

  return candidates;
}
