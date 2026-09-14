/**
 * Selectable glyph presets for the interactive console.
 *
 * The console's icons, status marks, checkboxes, row markers and field bullets
 * used to be loose literals scattered across a dozen layout modules. Commit
 * 40ea22d2 ("feat(cli): unify operator dialogs…") swapped the original Nerd
 * Font PUA icons (`\u{f07c}` folder-open, `\u{f111}` circle, …) for thin
 * geometric Unicode approximations (`▦ ● ◈ ◐ ▥ ▤ ✦ ✚ ◇ ↗`). That fixed the
 * missing-glyph tofu on stock terminals, but the outline glyphs draw hairline
 * and small — the "super small / thin" complaint. It also left three facts
 * un-expressed: there is no single place the glyph set lives, no way to offer
 * the real Nerd icons to an operator who has a patched font, and no ASCII
 * fallback for a terminal that can render neither.
 *
 * So the glyph set becomes a *table* — one column per preset — keyed by role,
 * with the key set expressed as a type so a glyph cannot be added to one preset
 * and forgotten in another. This mirrors `themes.ts`: a pure, React-free data
 * module; the live-selection/subscription layer is `symbol-context.ts`.
 *
 * Three presets, an explicit operator choice — there is NO runtime font
 * detection here:
 *
 *   - `unicode` (default): width-safe glyphs, preferring *filled / heavier*
 *     forms over thin outlines wherever a single-cell one exists (`●` over `◇`,
 *     `▸` over `▷`, heavy `✓`/`✗`). This is the highest-leverage answer to
 *     "super small" and needs no font and no qualification.
 *   - `nerd`: the real Nerd Font PUA icons (U+E000–F8FF) — full-cell, hinted,
 *     crisp in a patched-font terminal. The codepoints restore the pre-40ea22d2
 *     source; the `// nf-fa-…` names the old comments carried are the map.
 *   - `ascii`: single printable-ASCII, terminal-safe everywhere. Lossy by
 *     design; a title always accompanies an icon at the call sites, so no
 *     information is lost when the glyph degrades to `#`.
 *
 * Width discipline (the one correctness invariant): every Unicode and ASCII
 * cell is a single terminal column. In particular the pre-existing fullwidth
 * `＋` (U+FF0B) launcher glyph and the EAW-Ambiguous `⚙`/`⌨` are replaced with
 * single-cell forms in the Unicode column — several call sites size a header by
 * `glyph.length`, and a fullwidth char is `.length === 1` but two cells wide, so
 * it silently drifts a row. Bracketed forms (`[✓]`, `(●)`) are declared by the
 * box the call site reserves, not by the glyph string, so their multi-char
 * width is intentional and stable across presets.
 *
 * `getSymbols` is total: an unknown or hand-corrupted preset name degrades to
 * `unicode`, the same contract `getTheme` holds, so nothing downstream needs to
 * guard the name.
 */

export type SymbolPreset = "unicode" | "nerd" | "ascii";

/**
 * The role keys. Grouped by where they are consumed. A key names a *role*, not
 * a glyph — so a preset can pick whatever form fits the role best.
 */
export type SymbolKey =
  // status marks (semantic, tone-coloured at the call site)
  | "check"
  | "cross"
  | "warning"
  | "info"
  | "running"
  | "parked"
  | "stopped"
  | "queued"
  // bullets / step dots
  | "bulletFilled"
  | "bulletHollow"
  | "bulletActive"
  // radio / checkbox (bracketed — width declared by the reserved box)
  | "radioOn"
  | "radioOff"
  | "checkboxOn"
  | "checkboxOff"
  // markers / carets / chrome
  | "rowMarker"
  | "caretOpen"
  | "caretClosed"
  | "foldMore"
  | "treeBranch"
  | "roleGlyph"
  // meters
  | "meterFilled"
  | "meterEmpty"
  // screen icons (operator-icons.ts)
  | "iconNew"
  | "iconOps"
  | "iconDoctor"
  | "iconHistory"
  | "iconFindings"
  | "iconReplay"
  | "iconSettings"
  | "iconHarness"
  | "iconAgents"
  | "iconAudits"
  | "iconMarket"
  | "iconConnect"
  | "iconOnboard"
  | "iconModels"
  | "iconUsage"
  | "iconShortcuts"
  // field icons (finding-detail / usage / status / model / resume)
  | "fieldFolderOpen"
  | "fieldFolder"
  | "fieldStatus"
  | "fieldTags"
  | "fieldInfo"
  | "fieldFile"
  | "fieldEye"
  | "fieldGavel"
  | "fieldDiamond"
  | "fieldLink"
  | "fieldContext"
  | "fieldInput"
  | "fieldOutput"
  | "fieldReason"
  | "fieldCost"
  | "fieldModel"
  | "fieldHost"
  | "fieldCwd"
  | "fieldBranch"
  | "fieldDirty"
  | "fieldTokens"
  | "fieldPlan"
  | "fieldSearch"
  | "fieldProtected"
  | "fieldEffort"
  | "fieldMode";

/** A complete glyph set: every role key resolved to one glyph string. */
export type SymbolTable = Readonly<Record<SymbolKey, string>>;

/**
 * Default. Width-safe, filled-over-outline. No fullwidth or EAW-Ambiguous
 * glyphs: `iconNew` is `+` (not fullwidth `＋`), `iconSettings`/`fieldHost` are
 * single-cell substitutes for the ambiguous `⚙`/`⌨`.
 */
const UNICODE: SymbolTable = {
  check: "✓",
  cross: "✗",
  warning: "⚠",
  info: "ℹ",
  running: "▸",
  parked: "◌",
  stopped: "■",
  queued: "·",
  bulletFilled: "●",
  bulletHollow: "○",
  bulletActive: "◉",
  radioOn: "(●)",
  radioOff: "( )",
  checkboxOn: "[✓]",
  checkboxOff: "[ ]",
  rowMarker: "›",
  caretOpen: "▾",
  caretClosed: "▸",
  foldMore: "▸",
  treeBranch: "↳",
  roleGlyph: "▌",
  meterFilled: "▰",
  meterEmpty: "▱",
  iconNew: "+",
  iconOps: "▦",
  iconDoctor: "✚",
  iconHistory: "◷",
  iconFindings: "◇",
  iconReplay: "▷",
  iconSettings: "*",
  iconHarness: "⌘",
  iconAgents: "♙",
  iconAudits: "▣",
  iconMarket: "⊞",
  iconConnect: "↗",
  iconOnboard: "✦",
  iconModels: "◈",
  iconUsage: "▥",
  iconShortcuts: "=",
  fieldFolderOpen: "▦",
  fieldFolder: "▥",
  fieldStatus: "●",
  fieldTags: "◈",
  fieldInfo: "◐",
  fieldFile: "▤",
  fieldEye: "✦",
  fieldGavel: "✚",
  fieldDiamond: "◇",
  fieldLink: "↗",
  fieldContext: "◫",
  fieldInput: "↓",
  fieldOutput: "↑",
  fieldReason: "✦",
  fieldCost: "$",
  fieldModel: "◈",
  fieldHost: "=",
  fieldCwd: "⌂",
  fieldBranch: "⑂",
  fieldDirty: "±",
  fieldTokens: "↕",
  fieldPlan: "▣",
  fieldSearch: "⌕",
  fieldProtected: "⊘",
  fieldEffort: "✦",
  fieldMode: "◐",
};

/**
 * Nerd Font PUA. Restores the pre-40ea22d2 icons; the finding-detail set uses
 * the exact codepoints the old `// nf-fa-…` comments name. Each glyph is a
 * single cell in a Nerd Font terminal. Bracketed forms wrap a PUA glyph.
 * Glyphs with no natural Nerd counterpart (meters, role rail) keep the Unicode
 * form on purpose — they render identically well in a patched font.
 */
const NERD: SymbolTable = {
  check: "\u{f00c}", // nf-fa-check
  cross: "\u{f00d}", // nf-fa-times
  warning: "\u{f071}", // nf-fa-warning
  info: "\u{f05a}", // nf-fa-info-circle
  running: "\u{f04b}", // nf-fa-play
  parked: "\u{f04c}", // nf-fa-pause
  stopped: "\u{f04d}", // nf-fa-stop
  queued: "\u{f111}", // nf-fa-circle
  bulletFilled: "\u{f111}", // nf-fa-circle
  bulletHollow: "\u{f10c}", // nf-fa-circle-o
  bulletActive: "\u{f192}", // nf-fa-dot-circle-o
  radioOn: "(\u{f192})",
  radioOff: "( )",
  checkboxOn: "[\u{f14a}]", // nf-fa-check-square
  checkboxOff: "[\u{f0c8}]", // nf-fa-square
  rowMarker: "\u{f054}", // nf-fa-chevron-right
  caretOpen: "\u{f078}", // nf-fa-chevron-down
  caretClosed: "\u{f054}", // nf-fa-chevron-right
  foldMore: "\u{f142}", // nf-fa-ellipsis-v
  treeBranch: "\u{f148}", // nf-fa-level-up (corner)
  roleGlyph: "▌",
  meterFilled: "▰",
  meterEmpty: "▱",
  iconNew: "\u{f067}", // nf-fa-plus
  iconOps: "\u{f0e4}", // nf-fa-dashboard
  iconDoctor: "\u{f0f0}", // nf-fa-user-md
  iconHistory: "\u{f017}", // nf-fa-clock-o
  iconFindings: "\u{f0eb}", // nf-fa-lightbulb-o
  iconReplay: "\u{f04b}", // nf-fa-play
  iconSettings: "\u{f013}", // nf-fa-cog
  iconHarness: "\u{f085}", // nf-fa-cogs
  iconAgents: "\u{f0c0}", // nf-fa-users
  iconAudits: "\u{f0ca}", // nf-fa-list-ul
  iconMarket: "\u{f07a}", // nf-fa-shopping-cart
  iconConnect: "\u{f0c1}", // nf-fa-link
  iconOnboard: "\u{f005}", // nf-fa-star
  iconModels: "\u{f0e7}", // nf-fa-bolt
  iconUsage: "\u{f080}", // nf-fa-bar-chart
  iconShortcuts: "\u{f11c}", // nf-fa-keyboard-o
  fieldFolderOpen: "\u{f07c}", // nf-fa-folder-open
  fieldFolder: "\u{f07b}", // nf-fa-folder
  fieldStatus: "\u{f111}", // nf-fa-circle
  fieldTags: "\u{f0ae}", // nf-fa-tasks (tags family)
  fieldInfo: "\u{f05a}", // nf-fa-info-circle
  fieldFile: "\u{f15c}", // nf-fa-file-text
  fieldEye: "\u{f06e}", // nf-fa-eye
  fieldGavel: "\u{f0e3}", // nf-fa-gavel
  fieldDiamond: "\u{f0c4}", // nf-fa-scissors (diamond family)
  fieldLink: "\u{f0c1}", // nf-fa-link
  fieldContext: "\u{f0db}", // nf-fa-columns
  fieldInput: "\u{f063}", // nf-fa-arrow-down
  fieldOutput: "\u{f062}", // nf-fa-arrow-up
  fieldReason: "\u{f0eb}", // nf-fa-lightbulb-o
  fieldCost: "\u{f155}", // nf-fa-dollar
  fieldModel: "\u{f0e7}", // nf-fa-bolt
  fieldHost: "\u{f085}", // nf-fa-cogs
  fieldCwd: "\u{f015}", // nf-fa-home
  fieldBranch: "\u{f126}", // nf-fa-code-fork
  fieldDirty: "\u{f069}", // nf-fa-asterisk
  fieldTokens: "\u{f0ec}", // nf-fa-exchange
  fieldPlan: "\u{f0ca}", // nf-fa-list-ul
  fieldSearch: "\u{f002}", // nf-fa-search
  fieldProtected: "\u{f023}", // nf-fa-lock
  fieldEffort: "\u{f0e7}", // nf-fa-bolt
  fieldMode: "\u{f042}", // nf-fa-adjust
};

/**
 * ASCII. Single printable-ASCII per cell (bracketed forms keep their brackets).
 * Lossy but terminal-safe everywhere; a title always accompanies the icon at
 * the call site.
 */
const ASCII: SymbolTable = {
  check: "+",
  cross: "x",
  warning: "!",
  info: "i",
  running: ">",
  parked: "=",
  stopped: "#",
  queued: ".",
  bulletFilled: "*",
  bulletHollow: "o",
  bulletActive: "@",
  radioOn: "(*)",
  radioOff: "( )",
  checkboxOn: "[x]",
  checkboxOff: "[ ]",
  rowMarker: ">",
  caretOpen: "v",
  caretClosed: ">",
  foldMore: "+",
  treeBranch: "\\",
  roleGlyph: "|",
  meterFilled: "#",
  meterEmpty: "-",
  iconNew: "+",
  iconOps: "#",
  iconDoctor: "+",
  iconHistory: "h",
  iconFindings: "*",
  iconReplay: ">",
  iconSettings: "%",
  iconHarness: "&",
  iconAgents: "&",
  iconAudits: "#",
  iconMarket: "#",
  iconConnect: ">",
  iconOnboard: "*",
  iconModels: "#",
  iconUsage: "#",
  iconShortcuts: "=",
  fieldFolderOpen: "#",
  fieldFolder: "#",
  fieldStatus: "*",
  fieldTags: "#",
  fieldInfo: "i",
  fieldFile: "=",
  fieldEye: "*",
  fieldGavel: "+",
  fieldDiamond: "<",
  fieldLink: ">",
  fieldContext: "#",
  fieldInput: "v",
  fieldOutput: "^",
  fieldReason: "*",
  fieldCost: "$",
  fieldModel: "#",
  fieldHost: "=",
  fieldCwd: "~",
  fieldBranch: "Y",
  fieldDirty: "*",
  fieldTokens: "=",
  fieldPlan: "#",
  fieldSearch: "/",
  fieldProtected: "!",
  fieldEffort: "*",
  fieldMode: "%",
};

/**
 * The glyph table a preset names. Total: an unknown or hand-corrupted name
 * degrades to the default `unicode` set, so callers never need to guard it.
 */
export function getSymbols(preset: unknown): SymbolTable {
  return preset === "nerd" ? NERD : preset === "ascii" ? ASCII : UNICODE;
}
