/**
 * Layout, navigation and windowing arithmetic for the `/model` pop-up dialog.
 *
 * The screen is a dialog body — an icon+title row, the shared grouped and
 * searchable picker with a detail column beside it, and a status line inside a
 * panel someone else drew. Every width and row count it renders comes out of
 * `computeModelDialogLayout` below, measured against the *surface* box
 * (`useSurfaceDimensions`) rather than the terminal, so the same arithmetic
 * serves the dialog and a bare full-screen route.
 *
 * This is `settings-layout.ts` for `/model`, and it exists for the same reason
 * spelled out in `PRIMITIVES.md`: OpenTUI lays rows out with Yoga, and Yoga
 * *shrinks* siblings rather than clipping them. Two `<text>` nodes that
 * together want more cells than their row has are both painted in full into
 * boxes that are now too small, and the terminal shows the two strings
 * interleaved character by character — `runs12`, `target:cnone`. The same
 * failure on the vertical axis makes a bordered box paint its own bottom
 * border through its last content row. So the component reads widths and row
 * counts off a `ModelLayout` and never computes one, and a sweep hammers every
 * number in here across widths 0..200 and heights 0..80.
 *
 * ## Why the screen exists at all
 *
 * `/model` used to open a compact picker floating above the composer: a flat
 * list of 43 ids with a `provider · price` caption each. That shape has no
 * room for the one thing an operator actually needs before switching model,
 * which is whether this machine holds credentials for the vendor at all. A
 * turn started against a dark provider dies with zero tokens and a message
 * about a key nobody knew they needed.
 *
 * ## The accuracy rule this module is built around
 *
 * Credential state is reported **per provider**, never per model.
 *
 * A previous attempt annotated each row "no credentials" using the provider
 * that `model-catalog.ts` carries. That was wrong and was reverted. The
 * catalogue's provider comes from the pricing table (`modelProvider`, a
 * prefix match on the id), while the runtime resolves a model's provider
 * through its own detection and failover order — `providerForModel` in
 * `packages/core/src/runtime/llm-api.ts`, which core does not export. Those
 * two disagree in practice: an OpenAI-named model can in fact be served by the
 * ChatGPT/Codex backend, so a per-row verdict flags working models as broken,
 * which is the worst possible failure for a screen whose whole selling point
 * is telling the truth about reachability.
 *
 * What is verifiable from here is which *providers* hold credentials in the
 * environment, and that is all this module claims: a state on each provider
 * heading, the full env-var and setup detail in the detail pane, and — when
 * the highlighted model's nominal provider is dark while some other provider
 * is lit — a line naming the lit ones, so the operator can judge. There is no
 * "you cannot use this model" anywhere, by design.
 *
 * ## Reuse
 *
 * `shellChromeRows` and `wrapCells` are imported from `settings-layout.ts`
 * rather than copied. `shellChromeRows` in particular is the *corrected*
 * mirror of `run.tsx`'s `getShellChromeHeight`: the original assumes a
 * one-row footer, but `FooterBar` stacks to three rows below 64 content
 * cells, and a screen that fills its column — as this one does — overflows by
 * two rows on every narrow terminal if it believes the original. Neither
 * helper is settings-specific; the honest long-term home for both is a shared
 * `shell-geometry.ts`, and this import is the marker for that move.
 */

import { computeDialogPanel, type DialogPanel } from "./dialog-select-layout.js";
import { buildModelCatalog, type CatalogModel } from "./model-catalog.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { PROVIDERS, providerStates, type ProviderState } from "./provider-status.js";
import { shellChromeRows, wrapCells } from "./settings-layout.js";
import { getSymbols, type SymbolTable } from "./symbols.js";
import { sanitizeTuiText } from "./text.js";

/** Module-default table (Unicode) for callers that pass no `symbols`. */
const DEFAULT_SYMBOLS = getSymbols("unicode");

export { shellChromeRows, wrapCells };

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------
//
// The title glyph and label come from the shared `operator-icons.ts` registry
// so every dialog in the console is stamped the same way, and the label is
// always rendered beside the glyph — there is no icon font, and a bare glyph
// names nothing. Field markers share the plain-text status/usage vocabulary.

export const ICON_CONTEXT = "◫";
export const ICON_PRICE = "$";
export const ICON_PROVIDER = "⌨";
export const ICON_MODEL = "◈";
export const ICON_WARN = "!";
export const ICON_SEARCH = "⌕";

// ---------------------------------------------------------------------------
// Numeric hygiene
// ---------------------------------------------------------------------------

/**
 * Cell and row counts are non-negative integers.
 *
 * Terminal geometry arrives from `useTerminalDimensions`, which reports 0 on a
 * detached tty and can report a fractional or `NaN` size mid-resize. Yoga
 * accepts all of those and lays out sub-cell boxes that round inconsistently
 * between siblings, which is itself an overlap.
 */
function cells(value: unknown, fallback = 0): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const truncated = Math.trunc(raw);
  return truncated > 0 ? truncated : 0;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * What can be said about a provider without lying.
 *
 * - `ready`   — an env var listed in `PROVIDERS` holds a credential.
 * - `missing` — the runtime knows how to reach this provider, but nothing in
 *               the environment authenticates it. Note that `providerStates`
 *               never stats the filesystem, so a provider with a `fileSource`
 *               can read `missing` here while the runtime still finds an
 *               on-disk token; the detail pane says so rather than pretending.
 * - `unmapped` — the pricing table names a vendor the runtime has no direct
 *               env path for at all (`google`, `meta`, `mistral`, `unknown`).
 *               These are reachable, if at all, through an aggregator such as
 *               OpenRouter, which is a routing question this module cannot
 *               answer.
 */
export type ProviderCredential = "ready" | "missing" | "unmapped";

export interface ModelProviderGroup {
  /** Provider id exactly as the catalogue reports it, e.g. "z-ai". */
  readonly id: string;
  /** Human label from `PROVIDERS`, or the id title-cased when unmapped. */
  readonly label: string;
  readonly credential: ProviderCredential;
  /** The env var that actually held the credential, when `ready`. */
  readonly via?: string;
  /** One-line setup instruction from `PROVIDERS`, when the runtime knows one. */
  readonly hint?: string;
  /** On-disk credential location, for providers that have one. */
  readonly fileSource?: string;
  readonly envVars: readonly string[];
}

/** `z-ai` -> `Z Ai`. Only ever reached for providers `PROVIDERS` omits. */
function titleCase(id: string): string {
  return sanitizeTuiText(id)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Everything sayable about the provider behind a catalogue entry. */
export function providerGroupFor(
  id: string,
  states: readonly ProviderState[],
): ModelProviderGroup {
  const state = states.find((candidate) => candidate.id === id);
  if (!state) {
    return {
      id,
      label: titleCase(id) || id,
      credential: "unmapped",
      envVars: [],
    };
  }
  return {
    id: state.id,
    label: state.label,
    credential: state.configured ? "ready" : "missing",
    via: state.via,
    hint: state.hint,
    fileSource: state.fileSource,
    envVars: state.envVars,
  };
}

/** How a provider's credential state reads on its group heading. */
export function credentialLabel(credential: ProviderCredential): string {
  switch (credential) {
    case "ready":
      return "ready";
    case "missing":
      return "no credentials";
    default:
      return "no setup path";
  }
}

/** Labels of every provider that currently holds a credential. */
export function configuredProviderLabels(states: readonly ProviderState[]): string[] {
  return states.filter((state) => state.configured).map((state) => state.label);
}

/**
 * The always-on status line under the panes.
 *
 * This is the screen's one unconditional statement of fact, and it is a
 * provider-level one. It matters most for the operator whose only credential
 * is ChatGPT Codex: every group heading on this screen will read "no
 * credentials", because the catalogue has no chatgpt-codex models to group
 * under, and without this line that reads as "nothing works".
 */
export function credentialSummary(states: readonly ProviderState[]): string {
  const labels = configuredProviderLabels(states);
  if (labels.length === 0) {
    return "credentials: none detected in this environment - see /doctor";
  }
  return `credentials: ${labels.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

export type ModelRow =
  | { readonly kind: "heading"; readonly group: ModelProviderGroup; readonly count: number }
  | {
      readonly kind: "model";
      readonly group: ModelProviderGroup;
      readonly model: CatalogModel;
      readonly active: boolean;
    };

export interface ModelRowsInput {
  /** Defaults to the live catalogue; a test may pass its own. */
  catalog?: readonly CatalogModel[];
  /** Defaults to an empty environment, i.e. nothing configured. */
  states?: readonly ProviderState[];
  filter?: string;
  /** The model the session is currently running. */
  activeModel?: string;
}

/** Byte-order compare: locale-independent so the order never shifts. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const PROVIDER_ORDER = new Map(PROVIDERS.map((info, index) => [info.id, index]));

/**
 * Group ordering: the active model's provider, then the providers that hold
 * credentials, then the ones the runtime could reach if configured, then the
 * vendors it has no direct path to.
 *
 * This is a statement about providers, not about models — the ordering says
 * "these vendors are authenticated", which is verifiable, and never "this
 * model will not run", which is not. Within each band the order is the
 * `PROVIDERS` table's own priority (which mirrors the runtime's env-priority
 * chain), with unmapped vendors falling to the end alphabetically, so the list
 * is stable across renders and across sessions.
 */
function groupRank(group: ModelProviderGroup, activeProvider: string | undefined): number {
  if (activeProvider !== undefined && group.id === activeProvider) return 0;
  switch (group.credential) {
    case "ready":
      return 1;
    case "missing":
      return 2;
    default:
      return 3;
  }
}

/**
 * Flattens the catalogue into provider headings and model rows, honouring an
 * optional filter.
 *
 * A heading is only emitted when at least one model under it survived the
 * filter: a heading with nothing beneath it is a row of noise, and on this
 * screen it would also be a credential claim about a vendor the operator did
 * not ask about.
 *
 * The filter is AND-over-terms across the model id, the provider id, the
 * provider label and the formatted price. Matching the provider label is what
 * makes "anthropic" and "Moonshot" both work, and matching the price is what
 * makes "free" a usable query.
 */
export function buildModelRows({
  catalog = buildModelCatalog(),
  states = providerStates({}),
  filter = "",
  activeModel,
}: ModelRowsInput = {}): ModelRow[] {
  const terms = sanitizeTuiText(filter).toLowerCase().split(" ").filter(Boolean);
  const groups = new Map<string, ModelProviderGroup>();
  const byProvider = new Map<string, CatalogModel[]>();

  for (const model of catalog) {
    if (!model || typeof model.id !== "string" || model.id.length === 0) continue;
    const providerId = typeof model.provider === "string" && model.provider.length > 0
      ? model.provider
      : "unknown";
    let group = groups.get(providerId);
    if (!group) {
      group = providerGroupFor(providerId, states);
      groups.set(providerId, group);
    }
    const haystack = `${model.id} ${group.id} ${group.label} ${model.price}`.toLowerCase();
    if (terms.length > 0 && !terms.every((term) => haystack.includes(term))) continue;
    const bucket = byProvider.get(providerId);
    if (bucket) bucket.push(model);
    else byProvider.set(providerId, [model]);
  }

  const activeProvider = [...byProvider.entries()].find(([, models]) =>
    models.some((model) => model.id === activeModel),
  )?.[0];

  const order = [...byProvider.keys()].sort((a, b) => {
    const left = groups.get(a);
    const right = groups.get(b);
    if (!left || !right) return compareStrings(a, b);
    return (
      groupRank(left, activeProvider) - groupRank(right, activeProvider) ||
      (PROVIDER_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (PROVIDER_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER) ||
      compareStrings(a, b)
    );
  });

  const rows: ModelRow[] = [];
  for (const providerId of order) {
    const group = groups.get(providerId);
    const models = byProvider.get(providerId);
    if (!group || !models || models.length === 0) continue;
    // The active model floats to the top of its own group: it is the row the
    // operator most often opened the screen to confirm, and it doubles as the
    // initial highlight.
    const sorted = [...models].sort((a, b) => {
      if (a.id === activeModel) return b.id === activeModel ? 0 : -1;
      if (b.id === activeModel) return 1;
      return compareStrings(a.id, b.id);
    });
    rows.push({ kind: "heading", group, count: sorted.length });
    for (const model of sorted) {
      rows.push({ kind: "model", group, model, active: model.id === activeModel });
    }
  }
  return rows;
}

/** Index of a model by id, or -1. Used to open the screen on the active row. */
export function indexOfModel(rows: readonly ModelRow[], id: string | undefined): number {
  if (!id) return -1;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row?.kind === "model" && row.model.id === id) return index;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

/**
 * `ok` is the one tone this screen needs that the settings detail pane does
 * not: a configured provider is worth saying in green rather than in the
 * accent colour used for "changed from the default".
 */
export type ModelDetailTone = "title" | "text" | "muted" | "accent" | "ok" | "warn" | "blank";

export interface ModelDetailLine {
  readonly text: string;
  readonly tone: ModelDetailTone;
}

export interface ModelDetailInput {
  row?: ModelRow;
  /**
   * Labels of every provider that does hold credentials.
   *
   * Rendered only when the highlighted model's own provider is dark. This is
   * the honest substitute for the per-row verdict this module refuses to make:
   * the runtime may well serve this model through one of these instead, and
   * naming them lets the operator judge rather than being told "no".
   */
  configured?: readonly string[];
  /** Omit the blank separator rows. Set when the pane is short of rows. */
  compact?: boolean;
  /**
   * The context window in tokens, exactly as the synced catalogue reported it.
   *
   * `undefined` and `null` both mean "the catalogue does not say", and the pane
   * then renders `unknown`. Nothing here derives, rounds up from a sibling
   * model, or assumes a vendor default: a context window the operator plans a
   * run around is the last field that may be guessed.
   */
  contextTokens?: number | null;
}

// ---------------------------------------------------------------------------
// Context windows
// ---------------------------------------------------------------------------

/**
 * The minimum shape a synced catalogue row needs to answer "what context
 * window does this model have". Structural on purpose: the concrete row type
 * lives in `model-catalog-sync.ts`, which this module has no business
 * depending on, and `model-catalog.ts` is not this lane's to widen.
 */
export interface ContextWindowSource {
  id: string;
  provider: string;
  /** Context window in tokens, when the feed reported one. */
  contextTokens?: number;
}

/**
 * The index key for catalogue metadata: **provider and id together**.
 *
 * Keying on the model id alone is unsafe. The same id is served by more than
 * one provider (a vendor id re-exposed by an aggregator, a fork under a new
 * roof), and those rows can carry different context windows. An id-only
 * lookup silently returns whichever row happened to be stored first, which on
 * this screen means reporting another provider's window as this model's — a
 * number the operator sizes a run against. The NUL separator cannot occur in
 * either field, so no two distinct pairs can collide into one key.
 */
export function catalogContextKey(provider: string, id: string): string {
  return `${provider}\0${id}`;
}

/**
 * A provider+id -> context-window index over a synced catalogue.
 *
 * A row with no reported window is not indexed at all, and two rows that claim
 * the *same* provider and id with *different* windows cancel each other out
 * and are removed: there is no basis for preferring one, and an arbitrary
 * winner is exactly the silent wrong answer this key exists to prevent. Both
 * cases surface as "unknown", which is the honest answer.
 */
export function buildContextWindowIndex(
  models: readonly ContextWindowSource[],
): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  const conflicted = new Set<string>();
  for (const model of models) {
    if (typeof model?.id !== "string" || model.id.length === 0) continue;
    if (typeof model.provider !== "string" || model.provider.length === 0) continue;
    const tokens = model.contextTokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) continue;
    const key = catalogContextKey(model.provider, model.id);
    if (conflicted.has(key)) continue;
    const seen = index.get(key);
    if (seen !== undefined && seen !== Math.trunc(tokens)) {
      index.delete(key);
      conflicted.add(key);
      continue;
    }
    index.set(key, Math.trunc(tokens));
  }
  return index;
}

/**
 * The context window for one catalogue row, or `null` when the index cannot
 * answer for that exact provider+id pair.
 *
 * `null` is returned for an unknown provider, an unindexed model, and a
 * conflicting pair alike. Nothing falls back to an id-only lookup: a miss is
 * "unknown", never "some other provider's number".
 */
export function contextWindowFor(
  index: ReadonlyMap<string, number>,
  provider: string | undefined,
  id: string | undefined,
): number | null {
  if (typeof provider !== "string" || provider.length === 0) return null;
  if (typeof id !== "string" || id.length === 0) return null;
  return index.get(catalogContextKey(provider, id)) ?? null;
}

/**
 * A token count as the catalogue reported it, abbreviated but never rounded
 * into a different number: 200000 -> "200K", 1048576 -> "1048576" (it is not a
 * whole number of thousands, so the exact figure is printed rather than a
 * tidier lie).
 */
export function formatContextTokens(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "unknown";
  const tokens = Math.trunc(value);
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M tokens`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K tokens`;
  return `${tokens} tokens`;
}

/**
 * The catalogue's price string, with its "no rate published" sentinel spelled
 * out.
 *
 * `catalogExtras` writes `"—"` for a Models.dev row the pricing table has no
 * rates for. Rendered raw that reads as a dash-shaped price; rendered as
 * "not published" it reads as the absence it is. `"free"` is left exactly as
 * `formatModelPrice` produced it — that is the pricing table stating both
 * rates are zero, not a claim this module invented.
 */
export function modelPriceText(price: unknown): string {
  const text = sanitizeTuiText(price ?? "");
  if (text.length === 0 || text === "—" || text === "-") return "not published";
  return text;
}

/**
 * The detail pane's body, as flat tone-tagged lines.
 *
 * Content is decided here and colour is decided by the component, so the pane
 * can be asserted on without a renderer. Every field uses a `": "` separator
 * rather than alignment columns: `sanitizeTuiText` collapses runs of
 * whitespace, so a padded literal would be trimmed away and the label would
 * fuse to its value.
 */
export function modelDetailLines(
  { row, configured = [], compact = false, contextTokens }: ModelDetailInput,
  width: number,
  symbols: SymbolTable = DEFAULT_SYMBOLS,
): ModelDetailLine[] {
  const limit = cells(width);
  if (!row || limit <= 0) return [];
  const ICON_PROVIDER = symbols.fieldHost;
  const ICON_PRICE = symbols.fieldCost;
  const ICON_CONTEXT = symbols.fieldContext;

  const lines: ModelDetailLine[] = [];
  const push = (value: string, tone: ModelDetailTone) => {
    for (const text of wrapCells(value, limit)) lines.push({ text, tone });
  };
  const separate = () => {
    if (!compact) lines.push({ text: "", tone: "blank" });
  };

  const group = row.group;

  if (row.kind === "heading") {
    push(group.label, "title");
    separate();
    push(`${row.count} model${row.count === 1 ? "" : "s"} in this group`, "text");
  } else {
    push(row.model.id, "title");
    separate();
    push(`${ICON_PROVIDER} Provider: ${group.label}`, "text");
    // Both of the next two fields are reported, never derived. A price the
    // pricing table has no row for reads "not published"; a context window the
    // synced catalogue never carried reads "unknown". Neither is filled in
    // from a sibling model or a vendor default.
    const priceText = modelPriceText(row.model.price);
    push(`${ICON_PRICE} Price: ${priceText}`, priceText === "not published" ? "muted" : "text");
    const contextText = formatContextTokens(contextTokens);
    push(`${ICON_CONTEXT} Context: ${contextText}`, contextText === "unknown" ? "muted" : "text");
    if (row.active) push("Currently active", "accent");
    else push("Enter stages this model for the next audit", "accent");
  }

  separate();

  switch (group.credential) {
    case "ready":
      push(`Credentials: found in ${group.via ?? "the environment"}`, "ok");
      break;
    case "missing":
      push("Credentials: not found · /connect to set up", "warn");
      if (group.envVars.length > 0) push(`Reads: ${group.envVars.join(", ")}`, "muted");
      if (group.hint) push(`Setup: ${group.hint}`, "muted");
      if (group.fileSource) {
        // `providerStates` is pure over env and never stats the filesystem, so
        // this provider can read as unconfigured while the runtime still finds
        // an on-disk token. Say that rather than let the pane assert a
        // reachability it did not check.
        push(`Also read from ${group.fileSource}, which is not checked here.`, "muted");
      }
      if (configured.length > 0) {
        push(`Providers with credentials: ${configured.join(", ")}`, "muted");
      }
      break;
    default:
      push("Credentials: no direct provider path", "muted");
      push(
        "Use a gateway such as OpenRouter or OpenCode Zen.",
        "muted",
      );
      if (configured.length > 0) {
        push(`Providers with credentials: ${configured.join(", ")}`, "muted");
      }
      break;
  }

  separate();
  // The caveat that keeps every line above honest. The provider shown is the
  // pricing table's, and the runtime resolves the backend independently
  // (`providerForModel`), so the two can legitimately disagree.
  push(
    "Provider labels do not determine routing; configured credentials do.",
    "muted",
  );

  return lines;
}

/**
 * Trims detail lines to the rows the pane actually has.
 *
 * Rendering more rows than the box holds is what pushes a border through the
 * content, so the overflow has to be cut — but it is marked rather than cut
 * silently, because a hint that stops mid-sentence with no sign it was
 * truncated reads as a bug in the hint.
 *
 * Given a width, the marker is appended to the last surviving line instead of
 * taking a row of its own. On the terminals where clipping actually happens
 * the pane has three rows, and spending one of them on a lone `...` throws
 * away a third of the text to say the text was thrown away.
 *
 * This is `clipDetailLines` from `settings-layout.ts` re-implemented rather
 * than imported: that one is typed to its own tone union, which has no `ok`,
 * and widening a module this change does not own to save fifteen lines is the
 * wrong trade.
 */
export function clipModelDetailLines(
  lines: readonly ModelDetailLine[],
  rows: number,
  width = 0,
): ModelDetailLine[] {
  const limit = cells(rows);
  if (limit <= 0) return [];
  if (lines.length <= limit) return [...lines];

  const kept = lines.slice(0, limit);
  const last = kept[limit - 1];
  const room = cells(width);
  // Four cells: a space and the three dots. Below eight there is nothing left
  // of the line once the marker is paid for, so it takes the row instead.
  if (room >= 8 && last && last.text.length > 0) {
    const head = last.text.slice(0, Math.max(0, room - 4)).trimEnd();
    kept[limit - 1] = { text: `${head} ...`, tone: last.tone };
  } else {
    kept[limit - 1] = { text: "...", tone: "muted" };
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Hosted detail pane
// ---------------------------------------------------------------------------

/**
 * Tone-tags and wraps the hosted service's own description of a model.
 *
 * The strings come from `hostedModelDetails` in `model-catalog.ts`, which is
 * the authoritative projection of what the account's catalogue and allowance
 * actually reported. Nothing is added here and nothing is rewritten: this
 * function only decides which rows read as a heading, which read as an absent
 * value, and which read as a failure, then wraps them to the pane.
 *
 * An absent value is muted rather than hidden, because on this screen "the
 * hosted service did not report a context window" is itself the fact the
 * operator needs; dropping the row would leave a gap that reads as though the
 * field were never asked for.
 */
const HOSTED_ABSENT = /\b(unknown|none reported|not established|no evidence reference|unavailable)\b/i;

export function hostedDetailLines(
  details: readonly string[],
  width: number,
  compact = false,
): ModelDetailLine[] {
  const limit = cells(width);
  if (limit <= 0) return [];
  const lines: ModelDetailLine[] = [];
  details.forEach((detail, index) => {
    const value = sanitizeTuiText(detail);
    if (value.length === 0) return;
    const tone: ModelDetailTone =
      index === 0
        ? "title"
        : /^State: available$/i.test(value)
          ? "ok"
          : /^State:/i.test(value)
            ? "warn"
            : HOSTED_ABSENT.test(value)
              ? "muted"
              : "text";
    for (const text of wrapCells(value, limit)) lines.push({ text, tone });
    if (!compact && index === 0) lines.push({ text: "", tone: "blank" });
  });
  return lines;
}

// ---------------------------------------------------------------------------
// Dialog geometry
// ---------------------------------------------------------------------------

/**
 * Rows the host frame keeps for itself *inside* the dialog panel.
 *
 * This is the settled host contract, not an estimate. Inside a
 * `DialogSurface` the route renders `ShellFrame` with `dialogContent`, which
 * draws no header, no horizontal padding and no top padding —
 * `useSurfaceDimensions()` is then the full panel interior and no shell chrome
 * comes off it. What the route does put in that interior alongside this
 * screen's body is exactly two rows: the "selections apply to the next audit"
 * staging line above it, and a `FooterBar` below it which is exactly one row
 * in a dialog. Reserving fewer paints the list through the footer, and
 * OpenTUI does not clip (see PRIMITIVES.md).
 *
 * Outside a dialog the legacy shell still draws its header and padding, so
 * that path keeps subtracting `shellChromeRows` instead of this constant.
 */
export const MODEL_DIALOG_HOST_CHROME_ROWS = 2;

export interface ModelDialogLayoutInput {
  /** The surface's inner width — the dialog panel's box, or the terminal. */
  width: number;
  /** The surface's inner height. */
  height: number;
  /** Display rows (provider headings interleaved) the list would render. */
  totalRows: number;
  /** True when the screen is mounted inside a `DialogSurface` panel. */
  inDialog?: boolean;
  /** Override the rows reserved for the host frame inside a dialog panel. */
  hostChromeRows?: number;
  /**
   * How many meta lines the caller actually wants to show above the list — the
   * focus/target line, the single-model policy line, the agent roster and the
   * curated/all line, already wrapped to `contentWidth`. The layout hands out
   * as many rows as height allows without starving the picker; when omitted it
   * falls back to the historical two-row budget.
   */
  metaLineCount?: number;
}

/**
 * The cells every body row may occupy, from the surface box. Pure and stable —
 * it depends only on width and whether we are inside a dialog panel, never on
 * how many meta or body rows there are — so a caller can size its wrapped meta
 * content with this *before* asking `computeModelDialogLayout` how many of those
 * rows fit, and the two are guaranteed to agree.
 */
export function dialogContentWidth(width: number, inDialog = false): number {
  return Math.max(0, cells(width) - (inDialog ? 0 : 4));
}

/** The most meta rows the dialog will ever spend, however tall the surface. */
const MAX_META_ROWS = 8;
/** Rows the picker body always keeps before any meta line is affordable. */
const META_BODY_FLOOR = 6;

export interface ModelDialogLayout {
  /** Cells every row of the body may occupy. */
  contentWidth: number;
  /** 1 when there is room for the icon+title row, else 0. */
  titleRows: number;
  /** 0, 1 or 2 rows of target / single-model context under the title. */
  metaRows: number;
  /** 1 when there is room for the notice/connection line, else 0. */
  statusRows: number;
  /** Rows the picker body (search line + list + detail) may occupy. */
  bodyRows: number;
  /** Rows of stacked detail below the list when the pane could not sit beside it. */
  stackedRows: number;
  /** Geometry for `DialogSelectBody`, in inline `bodyRows` mode. */
  panel: DialogPanel;
}

/** A picker body narrower than this cannot host a stacked detail block. */
const STACKED_MIN_WIDTH = 24;
/** Rows the list keeps for itself before a stacked detail block is affordable. */
const STACKED_MIN_LIST_ROWS = 6;
/** A stacked detail block never grows past this. */
const STACKED_MAX_ROWS = 8;

/**
 * Every width and row count the model dialog renders, from the surface box.
 *
 * The rows are handed out in priority order — the picker first, then the
 * status line, the title, and the target/policy context last — so a very short
 * surface degrades to "just the list" rather than to "chrome with no list".
 * The parts sum to at most the rows available, which is the property that
 * keeps the body from painting through whatever the frame drew below it.
 */
export function computeModelDialogLayout({
  width,
  height,
  totalRows,
  inDialog = false,
  hostChromeRows,
  metaLineCount,
}: ModelDialogLayoutInput): ModelDialogLayout {
  const surfaceWidth = cells(width);
  const surfaceHeight = cells(height);
  // Inside a dialog the panel already paid for its border and padding; on a
  // bare terminal the shell's own horizontal padding still has to come off.
  const contentWidth = dialogContentWidth(surfaceWidth, inDialog);
  const chrome = inDialog
    ? cells(hostChromeRows ?? MODEL_DIALOG_HOST_CHROME_ROWS)
    : shellChromeRows(surfaceWidth);
  const available = Math.max(0, surfaceHeight - chrome);

  const titleRows = available >= 5 ? 1 : 0;
  const statusRows = available >= 4 ? 1 : 0;
  // Meta rows (focus line, single-model policy, agent roster, curated/all) are
  // handed out last so a short surface degrades to "just the list", never to
  // "chrome with no list". A caller that wants more than the historical two
  // rows says how many lines it has; the body keeps `META_BODY_FLOOR` rows
  // whatever the demand, and nothing below eight rows tall shows meta at all.
  const desiredMeta = cells(metaLineCount ?? 2);
  const metaCeiling = available >= 10 ? MAX_META_ROWS : available >= 8 ? 1 : 0;
  const metaBudget = Math.max(0, available - titleRows - statusRows - META_BODY_FLOOR);
  const metaRows = Math.min(desiredMeta, metaCeiling, metaBudget);
  const bodyRows = Math.max(0, available - titleRows - statusRows - metaRows);

  const panelFor = (rows: number): DialogPanel =>
    computeDialogPanel({
      width: contentWidth,
      height: surfaceHeight,
      size: "large",
      totalRows,
      withDetail: true,
      bodyRows: rows,
    });

  let panel = panelFor(bodyRows);
  let stackedRows = 0;
  if (
    !panel.showDetail &&
    contentWidth >= STACKED_MIN_WIDTH &&
    bodyRows >= STACKED_MIN_LIST_ROWS + 3
  ) {
    stackedRows = Math.min(STACKED_MAX_ROWS, bodyRows - STACKED_MIN_LIST_ROWS);
    panel = panelFor(bodyRows - stackedRows);
  }

  return { contentWidth, titleRows, metaRows, statusRows, bodyRows, stackedRows, panel };
}

// ---------------------------------------------------------------------------
// Title, scope and hints
// ---------------------------------------------------------------------------

/** Which catalogue the screen is actually looking at. */
export type ModelCatalogScope = "hosted" | "byok" | "unknown";

export interface ModelDialogTitleInput {
  scope: ModelCatalogScope;
  /** The BYOK connection id, when there is one. Never invented. */
  providerId?: string;
  /** BYOK only: whether the full synced superset is on show. */
  showAll?: boolean;
  /**
   * BYOK only: whether 0sec Cloud routes are being folded in as an extra group.
   * Reflected in the title so an operator can see the list is not BYOK-only.
   */
  cloudMerged?: boolean;
}

/**
 * The dialog's title row: the shared glyph, the shared label, then which
 * catalogue is on screen.
 *
 * The glyph and label come from `operator-icons.ts` so this dialog is stamped
 * exactly like every other one, and the label is always beside the glyph —
 * there is no icon font behind these code points.
 */
export function modelDialogTitle({ scope, providerId, showAll = false, cloudMerged = false }: ModelDialogTitleInput): string {
  const head = `${operatorIcon("models")} ${operatorTitle("models")}`;
  if (scope === "hosted") return `${head} · Hosted catalog`;
  if (scope === "unknown") return `${head} · no connection`;
  const connection = sanitizeTuiText(providerId ?? "");
  const source = cloudMerged
    ? `${connection.length > 0 ? connection : "BYOK"} + 0sec Cloud`
    : connection.length > 0 ? connection : "BYOK";
  return `${head} · ${source} · ${showAll ? "all synced" : "curated"}`;
}

/**
 * The right-aligned counter beside the title.
 *
 * It counts the rows actually on screen — the filtered list — and says
 * "loading" while a refresh is in flight, so a short list during a reload is
 * never mistaken for a short catalogue.
 */
export function modelDialogCount(matched: number, refreshing: boolean): string {
  const count = cells(matched);
  return `${count} model${count === 1 ? "" : "s"}${refreshing ? " · loading" : ""}`;
}

export interface ModelDialogHintInput {
  scope: ModelCatalogScope;
  /** Null when the parent model is the target; otherwise the role being set. */
  role?: string | null;
  hasFilter?: boolean;
  /**
   * Whether Ctrl+R reloads a live hosted catalogue. True on the hosted lane,
   * and on the BYOK lane while 0sec Cloud routes are merged (a dark cloud is
   * retried without disturbing the BYOK list). Defaults to `scope === "hosted"`.
   */
  canReload?: boolean;
}

/**
 * The footer hints, naming only bindings this screen actually implements.
 *
 * `Ctrl+R` exists only on the hosted path and `Tab` only on the BYOK path, so
 * each is named only where it works; `Ctrl+Backspace` is named only while a
 * role is targeted, because that is the only state in which it does anything.
 */
export function modelDialogHint({ scope, role = null, hasFilter = false, canReload }: ModelDialogHintInput): string {
  const reload = canReload ?? scope === "hosted";
  return [
    "↑↓ model",
    "enter stage",
    "ctrl+←/→ target",
    "ctrl+s single",
    role !== null ? "ctrl+backspace inherit" : undefined,
    scope === "byok" ? "tab curated/all" : undefined,
    reload ? "ctrl+r reload" : undefined,
    hasFilter ? "ctrl+u clear" : "type to filter",
    hasFilter ? "esc clear" : "esc back",
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

/**
 * The "what am I about to change" line under the title.
 *
 * It states the target (the parent model, or one role) and the model that
 * target resolves to today, and it says outright when a role has no assignment
 * of its own — an unconfigured role inherits, and showing the inherited id
 * without that word would read as an assignment that was never made.
 */
export function modelTargetLine(
  role: string | null,
  activeModel: string | undefined,
  assigned: boolean,
  symbols: SymbolTable = DEFAULT_SYMBOLS,
  singleModel = false,
): string {
  const target = role === null ? "parent (base) model" : `${sanitizeTuiText(role)} agent`;
  const model = sanitizeTuiText(activeModel ?? "");
  const value = model.length > 0 ? model : "not selected";
  const inherits = role !== null && !assigned ? " (inherits the parent)" : "";
  // When single-model is on, a role pick is staged but the runtime ignores it
  // (llm-api pins every role to the base model), so the focus line says so
  // outright rather than letting Enter look like it took effect.
  const inert = singleModel && role !== null ? " · single-model on: this pick is inert" : "";
  return `${symbols.fieldModel} Selecting for ${target} → ${value}${inherits}${inert}`;
}

/**
 * The at-a-glance roster of every assignment target — the parent (base) model
 * plus each subagent role — and the model each resolves to today, so an
 * operator sees the whole per-agent mapping without cycling the target blindly.
 *
 * One token per target, `role → model`, with a role that has no assignment of
 * its own reading `→ inherits parent` rather than borrowing the parent's id (a
 * shown id would read as an assignment that was never made). The target
 * currently in focus is bracketed so the roster doubles as a "you are here".
 *
 * Single-model mode is stated in the header and every role token is marked
 * inert, because in that mode the runtime pins every role to the base model
 * and an unmarked `attack → opus` would read as a live override it is not.
 *
 * Wrapped to the pane, tone-tagged for the component: the header warns while
 * single-model is on, and reads muted otherwise.
 */
export interface AgentRosterInput {
  /** Every target in display order: `null` (parent) first, then each role. */
  roles: readonly (string | null)[];
  /** The parent/base model the session runs, when there is one. */
  parentModel?: string;
  /** Per-role assignments staged for the next audit. */
  agentModels?: Readonly<Record<string, string>>;
  /** The target currently in focus, bracketed in the roster. */
  activeRole: string | null;
  /** Whether single-model mode is staged, which makes role picks inert. */
  singleModel?: boolean;
}

/** One `role → model` token for the roster; `focused` brackets it. */
export function agentRosterToken(
  role: string | null,
  parentModel: string | undefined,
  agentModels: Readonly<Record<string, string>>,
  focused: boolean,
): string {
  let token: string;
  if (role === null) {
    const model = sanitizeTuiText(parentModel ?? "");
    token = `parent → ${model.length > 0 ? model : "not selected"}`;
  } else {
    const assigned = agentModels[role];
    token = assigned !== undefined
      ? `${sanitizeTuiText(role)} → ${sanitizeTuiText(assigned)}`
      : `${sanitizeTuiText(role)} → inherits parent`;
  }
  return focused ? `[${token}]` : token;
}

export function agentRosterLines(
  { roles, parentModel, agentModels = {}, activeRole, singleModel = false }: AgentRosterInput,
  width: number,
  _symbols: SymbolTable = DEFAULT_SYMBOLS,
): ModelDetailLine[] {
  const limit = cells(width);
  if (limit <= 0 || roles.length === 0) return [];
  const tokens = roles.map((role) => agentRosterToken(role, parentModel, agentModels, role === activeRole));
  const header = singleModel
    ? "Agents (single-model on — role picks inert): "
    : "Agents: ";
  const lines: ModelDetailLine[] = [];
  wrapCells(`${header}${tokens.join("   ")}`, limit).forEach((text, index) => {
    lines.push({ text, tone: index === 0 && singleModel ? "warn" : "muted" });
  });
  return lines;
}

/** The single-model policy line, stating the policy and how to change it. */
export function singleModelLine(enabled: boolean): string {
  return enabled
    ? "Single model: on — role overrides are inactive for the next audit"
    : "Single model: off — explicit role overrides are honoured";
}

// ---------------------------------------------------------------------------
// Hints and keys
// ---------------------------------------------------------------------------

export type ModelMode = "browse" | "filter";

/** Contextual shortcuts for the model picker. */
export function modelFooterHint(mode: ModelMode, hasFilter = false): string {
  return [
    "↑↓ select",
    "enter select for new chat",
    "tab curated/all",
    mode === "filter" || hasFilter ? "esc clear" : "esc back",
  ].join(" · ");
}

/** Printable search text, including multi-character input; controls are excluded. */
export function isFilterKey(sequence: unknown): boolean {
  return typeof sequence === "string" && sequence.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(sequence);
}
