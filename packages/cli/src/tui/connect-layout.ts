/**
 * The provider model and text of the connect / login dialog (`/connect`,
 * alias `/login`).
 *
 * The shared picker owns list/detail geometry; this module supplies provider
 * grouping, supported authentication instructions, credential presence and
 * masking. A configured credential is never presented as checked API access.
 * Standalone navigation is budgeted here; embedded navigation belongs to the
 * onboarding window.
 */

import { PROVIDER_DEVICE_AUTH } from "./device-auth.js";
import { PROVIDERS, type ProviderState } from "./provider-status.js";
import type { DialogItem } from "./dialog-select-layout.js";
import {
  DIALOG_HOST_FOOTER_ROWS,
  computeDialogScreenLayout,
  shellChromeRows,
  titleColumns,
  wrapCells,
  type DialogScreenLayout,
  type DialogScreenLayoutOptions,
} from "./settings-layout.js";
import { sanitizeTuiText } from "./text.js";

export { shellChromeRows, wrapCells };

/**
 * Rows the host spends around this screen inside a dialog.
 *
 * The settled contract: the shell renders with `dialogContent` (no header, no
 * padding, the surface IS the panel interior) and draws exactly one footer row
 * from the `hint` the screen returns through `frame`. The connect route adds
 * nothing of its own, so the footer is the whole allowance — and the screen
 * must not draw a hint row itself.
 */
export const CONNECT_DIALOG_HOST_ROWS = DIALOG_HOST_FOOTER_ROWS;

// ---------------------------------------------------------------------------
// Numeric hygiene (mirrors model-layout.ts)
// ---------------------------------------------------------------------------

/** Cell and row counts are non-negative integers; garbage geometry degrades to 0. */
function cells(value: unknown, fallback = 0): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const truncated = Math.trunc(raw);
  return truncated > 0 ? truncated : 0;
}

// ---------------------------------------------------------------------------
// Provider model
// ---------------------------------------------------------------------------

/**
 * The provider table owns the protocol taxonomy. OAuth entries launch their
 * provider sign-in flow; only API-key entries can enter the generic secret field.
 */
export type AuthKind = "api-key" | "oauth";



/**
 * Providers surfaced in the "Popular" group, in the order shown. Membership is
 * a curation decision, not a runtime fact, so it lives here and nowhere else.
 */
export const RECOMMENDED_IDS: readonly string[] = ["anthropic", "openai"];

/** Short acquisition instructions shown in the selected provider's detail. */
const PROVIDER_SUBTITLE: Record<string, string> = {
  "chatgpt-codex": "Sign in with your ChatGPT subscription.",
  anthropic: "Get a key at console.anthropic.com.",
  openai: "Get a key at platform.openai.com/api-keys.",
};

/** The auth method for a provider id comes from the runtime provider table. */
export function authKindFor(id: string): AuthKind {
  return PROVIDERS.find((provider) => provider.id === id)?.auth ?? "api-key";
}

/** The short, right-aligned auth hint on a provider row. */
export function authHintLabel(auth: AuthKind): string {
  return auth === "oauth" ? "OAuth" : "API key";
}

export interface ConnectGroup {
  /** Stable group id, e.g. "popular" or "all". */
  readonly id: string;
  /** Heading label, e.g. "Popular". */
  readonly label: string;
}

const POPULAR_GROUP: ConnectGroup = { id: "popular", label: "Popular API providers" };
const ALL_GROUP: ConnectGroup = { id: "all", label: "Other API providers" };
const SUBSCRIPTION_GROUP: ConnectGroup = { id: "subscription", label: "Account sign-in" };

export interface ConnectProvider {
  readonly id: string;
  readonly label: string;
  readonly auth: AuthKind;
  /** True when an env var OR the credential store holds a credential. */
  readonly connected: boolean;
  /** Credential presence, not a successful authentication or API validity check. */
  readonly source?: "env" | "stored";
  /** The env var that actually held the credential, when connected via env. */
  readonly via?: string;
  /** One-line setup instruction from `PROVIDERS`. */
  readonly hint: string;
  /** Plain-language subtitle, for recommended providers. */
  readonly subtitle?: string;
  /** On-disk credential location, for providers that have one. */
  readonly fileSource?: string;
  readonly envVars: readonly string[];
}

export interface ConnectSources {
  /** Provider states over the environment (from `providerStates`). */
  states: readonly ProviderState[];
  /** Provider ids that have a value in the on-disk credential store. */
  stored?: ReadonlySet<string> | readonly string[];
}

/** Does any provider hold a real credential? Drives the onboarding nudge. */
export function hasAnyConnection({ states, stored }: ConnectSources): boolean {
  if (states.some((state) => state.configured)) return true;
  const storedSet = stored instanceof Set ? stored : new Set(stored ?? []);
  return storedSet.size > 0;
}

/** Everything sayable about one provider, folding env and stored credentials. */
function connectProviderFor(
  info: ProviderState,
  storedSet: ReadonlySet<string>,
): ConnectProvider {
  // Env wins: an explicit export is the credential the runtime will actually
  // use, so it is the one the screen must report as the live source.
  const source: ConnectProvider["source"] = info.configured
    ? "env"
    : storedSet.has(info.id)
      ? "stored"
      : undefined;
  return {
    id: info.id,
    label: info.label,
    auth: authKindFor(info.id),
    connected: source !== undefined,
    source,
    via: info.via,
    hint: info.hint,
    subtitle: PROVIDER_SUBTITLE[info.id],
    fileSource: info.fileSource,
    envVars: info.envVars,
  };
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

export type ConnectRow =
  | { readonly kind: "heading"; readonly group: ConnectGroup }
  | {
      readonly kind: "provider";
      readonly group: ConnectGroup;
      readonly provider: ConnectProvider;
    };

export interface ConnectRowsInput extends Partial<ConnectSources> {
  filter?: string;
}

/** Byte-order compare: locale-independent so the order never shifts. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Flattens the provider table into a "Popular" group followed by "All
 * providers" and subscriptions, each a heading then its provider rows.
 * A recommended provider with a subtitle emits a non-selectable subtitle row.
 * A heading is only emitted when at least one provider under it survives the
 * filter, and groups are disjoint. The filter is AND-over-terms across the
 * provider id, its label and its auth hint.
 */
export function buildConnectRows({
  states = [],
  stored,
  filter = "",
}: ConnectRowsInput = {}): ConnectRow[] {
  const storedSet = stored instanceof Set ? stored : new Set(stored ?? []);
  const terms = sanitizeTuiText(filter).toLowerCase().split(" ").filter(Boolean);

  const resolvedStates = states;

  const byId = new Map<string, ConnectProvider>();
  for (const state of resolvedStates) {
    if (!state || typeof state.id !== "string" || state.id.length === 0) continue;
    byId.set(state.id, connectProviderFor(state, storedSet));
  }

  const matches = (provider: ConnectProvider): boolean => {
    if (terms.length === 0) return true;
    const haystack =
      `${provider.id} ${provider.label} ${authHintLabel(provider.auth)}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };

  const recommended = RECOMMENDED_IDS.map((id) => byId.get(id)).filter(
    (provider): provider is ConnectProvider => provider !== undefined,
  );
  const recommendedIds = new Set(recommended.map((provider) => provider.id));
  const rest = [...byId.values()]
    .filter((provider) => provider.auth === "api-key" && !recommendedIds.has(provider.id))
    .sort((a, b) => compareStrings(a.id, b.id));

  const rows: ConnectRow[] = [];

  const pushGroup = (group: ConnectGroup, providers: readonly ConnectProvider[]) => {
    const shown = providers.filter(matches);
    if (shown.length === 0) return;
    rows.push({ kind: "heading", group });
    for (const provider of shown) {
      rows.push({ kind: "provider", group, provider });
    }
  };

  pushGroup(POPULAR_GROUP, recommended);
  pushGroup(ALL_GROUP, rest);
  pushGroup(SUBSCRIPTION_GROUP, [...byId.values()].filter((provider) => provider.auth === "oauth"));
  return rows;
}


// ---------------------------------------------------------------------------
// Projection onto the shared picker
// ---------------------------------------------------------------------------

export interface ConnectItemsInput {
  /** The rows `buildConnectRows` produced. */
  rows: readonly ConnectRow[];
  /**
   * The provider this screen was opened to REPAIR, if any. A provider being
   * reconnected is never drawn as connected, however the store reads, because
   * the credential it holds is the one that just failed.
   */
  recoveryProviderId?: string;
  /**
   * Lifecycle colours for the row, supplied by the component because this
   * module never sees a theme. They restore exactly the two colours the old
   * hand-rolled list carried — a connected provider read green, a provider
   * awaiting reconnection read as an error — and nothing more. A tone is only
   * ever attached to a state the row model already verified.
   */
  tones?: {
    /** A verified credential exists (env or store). */
    readonly connected?: string;
    /** This provider is the one being repaired. */
    readonly recovering?: string;
  };
}

/**
 * Projects providers onto the shared picker without repeated setup prose.
 * Configured status comes only from credential presence, minus providers
 * being repaired. Secrets never reach the visible item model.
 */
export function connectDialogItems({
  rows,
  recoveryProviderId,
  tones,
}: ConnectItemsInput): DialogItem[] {
  const items: DialogItem[] = [];

  for (const row of rows) {
    if (row.kind !== "provider") continue;
    const provider = row.provider;
    const recovering = recoveryProviderId === provider.id;
    const connected = provider.connected && !recovering;
    items.push({
      id: provider.id,
      label: provider.label,
      meta: recovering ? "reconnect" : connected ? "configured" : authHintLabel(provider.auth),
      category: row.group.label,
      current: connected,
      tone: recovering ? tones?.recovering : connected ? tones?.connected : undefined,
    });
  }
  return items;
}

/** Display rows (category headings interleaved) the picker would render. */
export function connectDisplayRowCount(items: readonly DialogItem[]): number {
  let count = 0;
  let group = "";
  for (const item of items) {
    if (item.category && item.category !== group) {
      group = item.category;
      count += 1;
    }
    count += 1;
  }
  return count;
}

/** The row for an item id, so the detail column can reach the full facts. */
export function connectRowForId(
  rows: readonly ConnectRow[],
  id: string | undefined,
): ConnectRow | undefined {
  if (!id) return undefined;
  return rows.find((row) => row.kind === "provider" && row.provider.id === id);
}

// ---------------------------------------------------------------------------
// Dialog geometry
// ---------------------------------------------------------------------------

export interface ConnectLayout extends DialogScreenLayout {
  /** The standalone top action row; the onboarding host supplies its own. */
  navigationRows: number;
}
export interface ConnectLayoutOptions extends DialogScreenLayoutOptions {
  embedded?: boolean;
}

/**
 * The connect dialog's row and column budget.
 *
 * The screen is a pop-up now, so there is no bordered two-pane console frame
 * to lay out: the shared picker owns the list column, its detail column and
 * the split between them, and this only has to partition the surface the host
 * left into a title row, the picker body, a status line and a footer. It is
 * `computeDialogScreenLayout` under a connect-shaped name — the same
 * implementation, and therefore the same sweep, the settings dialog uses, and
 * the same borrowing this module already does for `shellChromeRows`.
 */
export function computeConnectLayout(
  width: number,
  height: number,
  totalRows: number,
  options: ConnectLayoutOptions = {},
): ConnectLayout {
  const chromeRows = cells(options.chromeRows ?? shellChromeRows(width));
  const availableRows = Math.max(0, cells(height) - chromeRows);
  const navigationRows = !options.embedded && availableRows >= 5 ? 1 : 0;
  const layout = computeDialogScreenLayout(width, Math.max(0, cells(height) - navigationRows), totalRows, options);
  return { ...layout, navigationRows, availableRows: layout.availableRows + navigationRows };
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

export type ConnectDetailTone = "title" | "text" | "muted" | "accent" | "ok" | "warn" | "blank";

export interface ConnectDetailLine {
  readonly text: string;
  readonly tone: ConnectDetailTone;
}


export interface ConnectDetailInput {
  row?: ConnectRow;
  compact?: boolean;
}

/**
 * The detail pane body for the highlighted provider, as tone-tagged lines.
 * Content is decided here and colour by the component, so the pane is testable
 * without a renderer. Every field uses a `": "` separator rather than
 * alignment columns, because `sanitizeTuiText` would trim padded literals.
 */
export function connectDetailLines(
  { row, compact = false }: ConnectDetailInput,
  width: number,
): ConnectDetailLine[] {
  const limit = cells(width);
  if (!row || limit <= 0) return [];

  if (row.kind !== "provider") return [];

  const provider = row.provider;
  const lines: ConnectDetailLine[] = [];
  const push = (value: string, tone: ConnectDetailTone) => {
    for (const text of wrapCells(value, limit)) lines.push({ text, tone });
  };
  const separate = () => {
    if (!compact) lines.push({ text: "", tone: "blank" });
  };

  push(provider.label, "title");
  if (provider.subtitle) {
    separate();
    push(provider.subtitle, "accent");
  }
  separate();

  // OpenRouter's OAuth is a browser (PKCE loopback) flow that mints an API key,
  // not a device-code flow where the operator types a code — name it honestly.
  const oauthVerb =
    PROVIDER_DEVICE_AUTH[provider.id]?.kind === "pkce-loopback" ? "browser sign-in" : "device sign-in";
  push(provider.auth === "oauth" ? `OAuth · ${oauthVerb}` : "API key", "text");

  separate();
  if (provider.connected) {
    if (provider.source === "env") {
      push(`Using key from ${provider.via ?? "the environment"}.`, "ok");
    } else {
      push("Saved on this machine.", "ok");
    }
    push("API access not checked yet.", "muted");
  } else {
    push("Not set up.", "muted");
    if (!provider.subtitle && provider.hint) push(provider.hint, "text");
    if (provider.fileSource) {
      push(`Also reads ${provider.fileSource}.`, "muted");
    }
  }

  separate();
  if (!provider.connected) {
    push(
      provider.auth === "oauth" ? "Sign in opens your browser." : "Enter to paste a key.",
      "muted",
    );
  }

  return lines;
}

/** Trims detail lines to the rows the pane holds, marking the cut. */
export function clipConnectDetailLines(
  lines: readonly ConnectDetailLine[],
  rows: number,
  width = 0,
): ConnectDetailLine[] {
  const limit = cells(rows);
  if (limit <= 0) return [];
  if (lines.length <= limit) return [...lines];

  const kept = lines.slice(0, limit);
  const last = kept[limit - 1];
  const room = cells(width);
  if (room >= 8 && last && last.text.length > 0) {
    const head = last.text.slice(0, Math.max(0, room - 4)).trimEnd();
    kept[limit - 1] = { text: `${head} ...`, tone: last.tone };
  } else {
    kept[limit - 1] = { text: "...", tone: "muted" };
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Title row (pane header: bold title left, right-aligned summary meta)
// ---------------------------------------------------------------------------

/** A pane header split into a left title and a right-aligned meta column. */
export interface ConnectTitleLayout {
  /** Total cells the header row occupies; equals the pane's inner width. */
  width: number;
  titleWidth: number;
  gap: number;
  /** Right-aligned summary column. 0 when the row cannot spare it. */
  metaWidth: number;
}

/**
 * Splits a header into a left title and a right-aligned summary meta.
 *
 * The split itself is `titleColumns` in `settings-layout.ts` — every dialog in
 * the console divides its header the same way, and one implementation means
 * one sweep. The title outranks the meta: on a narrow header the meta gives
 * way whole rather than crushing the title, and the two columns always sum to
 * exactly the width handed in.
 */
export function computeConnectTitleLayout(innerWidth: number, metaLength: number): ConnectTitleLayout {
  return titleColumns(innerWidth, metaLength);
}

// ---------------------------------------------------------------------------
// Status line, titles, hints and keys
// ---------------------------------------------------------------------------

export interface ConnectCounts {
  /** Distinct configured providers offered by the displayed rows. */
  readonly connected: number;
  /** Distinct providers offered by the displayed rows. */
  readonly total: number;
}

/** Count each provider once, including a configured provider on multiple rows. */
export function connectConnectedCounts(rows: readonly ConnectRow[]): ConnectCounts {
  const seen = new Set<string>();
  let connected = 0;
  for (const row of rows) {
    if (row.kind !== "provider") continue;
    if (seen.has(row.provider.id)) continue;
    seen.add(row.provider.id);
    if (row.provider.connected) connected += 1;
  }
  return { connected, total: seen.size };
}

/** The always-on status line under the list: how many providers are connected. */
export function connectStatusLine(rows: readonly ConnectRow[]): string {
  const { connected, total } = connectConnectedCounts(rows);
  if (total === 0) return "No providers match.";
  if (connected === 0) return "Pick a provider.";
  return `${connected} of ${total} set up`;
}

/** The detail pane's stable, left-aligned header label. */
export function connectDetailTitleLabel(): string {
  return "PROVIDER";
}

/**
 * "configured" when a credential exists, "not configured" when it does not,
 * and "" when nothing is highlighted. This does not check API access.
 */
export function connectDetailTitleMeta(row: ConnectRow | undefined): string {
  if (!row) return "";
  if (row.kind !== "provider") return "";
  return row.provider.connected ? "configured" : "not configured";
}

export type ConnectMode = "browse" | "filter" | "input" | "oauth";

/**
 * The prompt shown while the operator is pasting a credential. The secret is
 * NEVER echoed: only a fixed dot run capped at 8 cells signals that something
 * was typed, so neither the value nor its exact length reaches the screen.
 */
export function connectInputMask(secretLength: number): string {
  const length = cells(secretLength);
  if (length === 0) return "";
  const dots = "•".repeat(Math.min(length, 8));
  return length > 8 ? `${dots}…` : dots;
}

/** The footer hint, per mode. Names the real bindings. */
export function connectFooterHint(mode: ConnectMode, hasFilter = false, canContinue = false): string {
  if (mode === "input") return "Enter save · Esc cancel";
  if (mode === "oauth") return "Esc cancel";
  const action = canContinue ? "continue" : "connect";
  if (mode === "filter") return `Enter ${action} · Esc done`;
  return [
    "↑↓ select",
    `Enter ${action}`,
    "/ search",
    hasFilter ? "Esc clear" : "Esc back",
  ].join(" · ");
}

/** Every printable single character reaches the filter. */
export function isFilterKey(sequence: unknown): boolean {
  if (typeof sequence !== "string" || sequence.length !== 1) return false;
  const code = sequence.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

/**
 * Whether a single keystroke should be appended to the credential input.
 *
 * Broader than `isFilterKey` in intent (a pasted key can contain any printable
 * character), but the same test: one printable, non-control character.
 */
export function isInputKey(sequence: unknown): boolean {
  return isFilterKey(sequence);
}

/**
 * The printable characters of a key sequence, control characters stripped.
 *
 * A pasted credential can arrive as one key event whose sequence is the whole
 * paste, so the input sub-step appends `pastableChars(seq)` rather than a
 * single character — this keeps a pasted key intact while dropping any stray
 * control bytes (a trailing newline from the paste, an escape) that would
 * otherwise corrupt the stored secret.
 */
export function pastableChars(sequence: unknown): string {
  if (typeof sequence !== "string") return "";
  let out = "";
  for (const ch of sequence) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

/** All providers, for callers that want the raw list (e.g. a test guard). */
export { PROVIDERS };