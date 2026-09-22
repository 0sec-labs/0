/**
 * The provider model and text of the connect / login dialog (`/connect`,
 * alias `/login`).
 *
 * The screen is a pop-up now, so the two-pane console geometry this module
 * used to own is gone: the shared picker (`DialogSelectBody` over
 * `computeDialogPanel`) lays out the list column, the detail column and the
 * split between them, and `computeConnectLayout` here is the dialog-shaped
 * partition every other dialog uses. What remains is what only connect knows
 * — which providers exist, how they group, what may honestly be said about
 * each one, and how a credential is masked — and it is still pure: the
 * component reads widths and row counts off this module and never computes
 * one, for the reason spelled out in `PRIMITIVES.md` (OpenTUI lays rows out
 * with Yoga, and Yoga shrinks siblings rather than clipping them).
 *
 * ## What the screen is for
 *
 * `/providers` is read-only: it says which vendors this machine can already
 * reach. This screen is the write side — it lets the operator connect one. The
 * providers, their env vars and their setup hints are all taken from
 * `provider-status.ts` (itself transcribed from the runtime's detection), so a
 * provider added there appears here without this module changing. This module
 * only adds two things the runtime table does not carry: which auth *method*
 * each provider uses (an API key versus an OAuth/subscription sign-in) and
 * which providers are worth surfacing first for someone connecting their very
 * first one.
 *
 * ## The cloud row
 *
 * The first row in the list is always the "0 Cloud" cloud-sign-in row. It
 * sits outside the Popular / All provider groups and is always selectable. It
 * launches the hosted browser login flow (hostedBrowserLoginFlow from
 * commands/auth.ts) which opens a browser, polls for session completion, and
 * persists credentials to ~/.0/cloud.env.
 *
 * ## The honesty rule
 *
 * A provider reads as connected — the green check — only when a credential
 * actually exists for it: an env var holds one, or the credential store on
 * disk does. The store is written by the screen's input sub-step. Nothing here
 * ever reports a connection that was not verified against one of those two
 * sources; there is no optimistic "connecting…" state that sticks. The cloud
 * row's connected state is determined independently through
 * `hasCloudCredentials` which checks ZERO_CLOUD_TOKEN in env or
 * ~/.0/cloud.env.
 *
 * ## Reuse
 *
 * `shellChromeRows` and `wrapCells` are imported from `settings-layout.ts`
 * rather than copied, exactly as `model-layout.ts` does — the honest long-term
 * home for both is a shared `shell-geometry.ts`, and this import is the marker
 * for that move.
 */

import { PROVIDER_DEVICE_AUTH } from "./device-auth.js";
import { PROVIDERS, providerStates, type ProviderState } from "./provider-status.js";
import type { DialogItem } from "./dialog-select-layout.js";
import type { CreditAccount } from "@0/core";
import { formatBalanceDetail } from "./hosted-balance.js";
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
 * real device flow; only API-key entries can enter the generic secret field.
 * The "cloud" entry is an OAuth provider that uses the hosted browser login
 * flow (hostedBrowserLoginFlow) rather than the Codex device-auth subprocess.
 */
export type AuthKind = "api-key" | "oauth";



/**
 * Providers surfaced in the "Popular" group, in the order shown. Membership is
 * a curation decision, not a runtime fact, so it lives here and nowhere else.
 */
export const RECOMMENDED_IDS: readonly string[] = ["anthropic", "openai"];

/**
 * Plain-language subtitles for the recommended group. Kept short enough to sit
 * as a single dimmed row under the provider it describes; wrapping is handled
 * by the list row budget, not here.
 */
const PROVIDER_SUBTITLE: Record<string, string> = {
  "chatgpt-codex": "Sign in with your ChatGPT subscription - no API key, no per-token billing.",
  anthropic: "Paste an Anthropic API key from console.anthropic.com.",
  openai: "Paste an OpenAI API key from platform.openai.com.",
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

/**
 * The cloud sign-in's own group.
 *
 * The cloud row is not a provider in `PROVIDERS` and is not filtered with
 * them, but the shared picker groups by category, so it needs one of its own —
 * and it sorts first because `buildConnectRows` emits it first.
 */
const CLOUD_GROUP: ConnectGroup = { id: "cloud", label: "0cloud" };
/** The picker id the cloud row commits with; the runtime calls it "hosted". */
const CLOUD_ITEM_ID = "hosted";
const CLOUD_LABEL = "0cloud";
const POPULAR_GROUP: ConnectGroup = { id: "popular", label: "Use my own API key" };
const ALL_GROUP: ConnectGroup = { id: "all", label: "Other API providers" };
const SUBSCRIPTION_GROUP: ConnectGroup = { id: "subscription", label: "Provider subscription" };

export interface ConnectProvider {
  readonly id: string;
  readonly label: string;
  readonly auth: AuthKind;
  /** True when an env var OR the credential store holds a credential. */
  readonly connected: boolean;
  /** Where the connection was verified: "env" or "stored". Undefined when dark. */
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
  /**
   * Local Cloud credential presence, supplied by the component. Not a service
   * readiness or funding assertion.
   */
  cloudConnected?: boolean;
  /** Live verification of the saved cloud sign-in (component-supplied). */
  hostedVerification?: HostedVerificationStatus;
}

/** Does any provider hold a real credential? Drives the onboarding nudge. */
export function hasAnyConnection({ states, stored, cloudConnected }: ConnectSources): boolean {
  if (cloudConnected || states.some((state) => state.configured)) return true;
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
  | { readonly kind: "cloud" }
  | { readonly kind: "heading"; readonly group: ConnectGroup }
  | { readonly kind: "subtitle"; readonly group: ConnectGroup; readonly text: string }
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
 * Flattens the provider table into a cloud row, then a "Popular" group followed
 * by "All providers", each a heading then its provider rows. A recommended
 * provider with a subtitle emits a non-selectable subtitle row beneath it.
 *
 * A heading is only emitted when at least one provider under it survives the
 * filter, and the two groups are disjoint: a provider in the popular group is
 * not repeated under "all". The filter is AND-over-terms across the provider
 * id, its label and its auth hint. The cloud row is always the first row and
 * never removed by the filter.
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
  if (terms.every((term) => "hosted 0cloud sign in".includes(term))) rows.push({ kind: "cloud" });

  const pushGroup = (group: ConnectGroup, providers: readonly ConnectProvider[]) => {
    const shown = providers.filter(matches);
    if (shown.length === 0) return;
    rows.push({ kind: "heading", group });
    for (const provider of shown) {
      rows.push({ kind: "provider", group, provider });
      if (group.id === "popular" && provider.subtitle) {
        rows.push({ kind: "subtitle", group, text: provider.subtitle });
      }
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
   * Local Cloud credential presence, decided by the component from the
   * environment or `~/.0/cloud.env`. Never assumed here.
   */
  cloudConnected?: boolean;
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
  /** Live backend verification of the saved cloud sign-in. */
  hostedVerification?: HostedVerificationStatus;
}

/**
 * Projects the connect rows onto the console's one shared picker.
 *
 * `DialogItem` carries the group as `category`, so the picker draws the same
 * "0cloud / Use my own API key / Other API providers / Provider
 * subscription" headings the hand-rolled list drew, and it searches them. The
 * subtitle that used to occupy a row of its own becomes the item's
 * `description`, which costs no row and cannot be landed on by the cursor.
 *
 * The honesty rule survives the projection intact. `current` — the gutter dot
 * — and the `connected` meta are set from `provider.connected`, which
 * `connectProviderFor` derives only from an env credential or the on-disk
 * store, minus any provider currently being repaired. Nothing here can mark a
 * provider connected optimistically, and no secret is carried on the item.
 */
export function connectDialogItems({
  rows,
  cloudConnected,
  recoveryProviderId,
  tones,
  hostedVerification,
}: ConnectItemsInput): DialogItem[] {
  const items: DialogItem[] = [];
  // Subtitles are rows in the row model; fold them onto the item above.
  const subtitleFor = new Map<string, string>();
  rows.forEach((row, index) => {
    if (row.kind !== "subtitle") return;
    const above = rows[index - 1];
    if (above?.kind === "provider") subtitleFor.set(above.provider.id, row.text);
  });

  for (const row of rows) {
    if (row.kind === "cloud") {
      // Cloud item state depends on backend verification, not just credential
      // presence. A saved token that the server rejects is not a connection.
      const stored = cloudConnected === true;
      const recovering = recoveryProviderId === "hosted";
      let meta: string;
      let current: boolean;
      let tone: string | undefined;
      if (recovering) {
        meta = "reconnect";
        current = false;
        tone = tones?.recovering;
      } else if (!stored) {
        meta = "sign in";
        current = false;
        tone = undefined;
      } else if (!hostedVerification || hostedVerification.kind === "pending") {
        // Credentials exist but verification hasn't completed yet.
        meta = "login saved";
        current = true;
        tone = tones?.connected;
      } else {
        switch (hostedVerification.kind) {
          case "verified": {
            const account = hostedVerification.account;
            meta = account && account.state !== "ready"
              ? `connected · credits ${account.state}`
              : "connected";
            current = true;
            tone = tones?.connected;
            break;
          }
          case "rejected":
            meta = "rejected";
            current = false;
            tone = tones?.recovering;
            break;
          case "unreachable":
            meta = "offline";
            current = false;
            tone = undefined;
            break;
        }
      }
      items.push({
        id: CLOUD_ITEM_ID,
        label: CLOUD_LABEL,
        description: "Sign in once to use the 0.security-managed model catalog",
        meta,
        category: CLOUD_GROUP.label,
        current,
        tone,
      });
      continue;
    }
    if (row.kind !== "provider") continue;
    const provider = row.provider;
    const recovering = recoveryProviderId === provider.id;
    const connected = provider.connected && !recovering;
    items.push({
      id: provider.id,
      label: provider.label,
      description: provider.subtitle ?? subtitleFor.get(provider.id),
      meta: recovering ? "reconnect" : connected ? "connected" : authHintLabel(provider.auth),
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
  if (id === CLOUD_ITEM_ID) return rows.find((row) => row.kind === "cloud");
  return rows.find((row) => row.kind === "provider" && row.provider.id === id);
}

// ---------------------------------------------------------------------------
// Dialog geometry
// ---------------------------------------------------------------------------

export type ConnectLayout = DialogScreenLayout;
export type ConnectLayoutOptions = DialogScreenLayoutOptions;

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
  return computeDialogScreenLayout(width, height, totalRows, options);
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

export type ConnectDetailTone = "title" | "text" | "muted" | "accent" | "ok" | "warn" | "blank";

export interface ConnectDetailLine {
  readonly text: string;
  readonly tone: ConnectDetailTone;
}

/**
 * The result of verifying a saved 0cloud sign-in against the backend
 * (`GET /api/inference/account`). `pending` while the check is in flight;
 * `verified` for every successful HTTP 200, carrying the typed DTO (which
 * may be null for unsupported schemas or carry state=disabled/unavailable/
 * restricted — these are not auth failures); `rejected` means the token
 * was refused (401/403 — sign in again); `unreachable` is a transient
 * network failure, not a bad token.
 */
export type HostedVerificationStatus =
  | { readonly kind: "pending" }
  | { readonly kind: "verified"; readonly account?: CreditAccount | null }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreachable" };

export interface ConnectDetailInput {
  row?: ConnectRow;
  compact?: boolean;
  /**
   * Local credential presence supplied by the component; this pure renderer
   * never reads environment variables or credential files.
   */
  cloudConnected?: boolean;
  /** Live backend verification of the saved cloud sign-in (component-supplied). */
  hostedVerification?: HostedVerificationStatus;
}

/**
 * The detail pane body for the highlighted provider, as tone-tagged lines.
 * Content is decided here and colour by the component, so the pane is testable
 * without a renderer. Every field uses a `": "` separator rather than
 * alignment columns, because `sanitizeTuiText` would trim padded literals.
 */
export function connectDetailLines(
  { row, compact = false, cloudConnected, hostedVerification }: ConnectDetailInput,
  width: number,
): ConnectDetailLine[] {
  const limit = cells(width);
  if (!row || limit <= 0) return [];

  // ── cloud row ──
  if (row.kind === "cloud") {
    const connected = cloudConnected === true;
    const lines: ConnectDetailLine[] = [];
    const push = (value: string, tone: ConnectDetailTone) => {
      for (const text of wrapCells(value, limit)) lines.push({ text, tone });
    };
    const separate = () => {
      if (!compact) lines.push({ text: "", tone: "blank" });
    };

    push("0cloud", "title");
    separate();
    push("Sign in once to use the 0.security-managed model catalog.", "text");
    push("Model access and credits are checked when used.", "muted");
    separate();
    if (connected) {
      const v = hostedVerification;
      if (!v || v.kind === "pending") {
        push("Verifying your 0cloud sign-in\u2026", "muted");
      } else if (v.kind === "verified") {
        push("Connected to 0cloud.", "ok");
        for (const line of formatBalanceDetail(v.account ?? null).trimEnd().split("\n")) {
          push(line.trimStart(), "text");
        }
      } else if (v.kind === "rejected") {
        push("Sign-in saved, but 0cloud rejected the token \u2014 press Enter to sign in again.", "warn");
      } else {
        push("Sign-in saved; couldn\u2019t reach 0cloud to verify right now.", "muted");
      }
    } else {
      push("Cloud login not configured.", "muted");
    }
    push("Use your own API key or provider subscription without a 0cloud account.", "muted");
    separate();
    if (connected && hostedVerification?.kind === "verified") {
      push("Enter: continue with 0cloud", "accent");
    } else if (connected && hostedVerification?.kind === "rejected") {
      push("Enter: open browser to sign in again", "muted");
    } else {
      push("Enter: open browser for 0cloud sign-in.", "muted");
    }
    return lines;
  }

  // ── provider rows ──
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
  push(
    provider.auth === "oauth" ? `Auth: ${provider.label} ${oauthVerb}` : "Auth: API key",
    "text",
  );

  separate();
  if (provider.connected) {
    if (provider.source === "env") {
      push(`Connected: credential found in ${provider.via ?? "the environment"}`, "ok");
    } else {
      push("Connected: credential stored on this machine", "ok");
      if (provider.envVars.length > 0) {
        push(`Exported to the runtime as ${provider.envVars[0]}`, "muted");
      }
    }
  } else {
    push("Not connected in this environment", "warn");
    if (provider.envVars.length > 0) push(`Reads: ${provider.envVars.join(", ")}`, "muted");
    if (provider.hint) push(`Setup: ${provider.hint}`, "muted");
    if (provider.fileSource) {
      push(`Also read from ${provider.fileSource}, which is not checked here.`, "muted");
    }
  }

  separate();
  push(
    provider.connected
      ? "Enter: continue with this provider"
      : (provider.auth === "oauth"
        ? `Enter: start ${provider.label} ${oauthVerb}. No API key or pasted token is used.`
        : "Enter: paste an API key. It is stored owner-only on this machine."),
    "muted",
  );

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
  /** Configured providers plus a remotely verified Cloud connection. */
  readonly connected: number;
  /** Distinct connections offered by the displayed rows, including Cloud. */
  readonly total: number;
}

/** Count each provider and the Cloud row once; saved Cloud credentials alone do not count. */
export function connectConnectedCounts(
  rows: readonly ConnectRow[],
  hostedVerification?: HostedVerificationStatus,
): ConnectCounts {
  const seen = new Set<string>();
  let connected = 0;
  let hasCloud = false;
  for (const row of rows) {
    if (row.kind === "cloud") {
      hasCloud = true;
      continue;
    }
    if (row.kind !== "provider") continue;
    if (seen.has(row.provider.id)) continue;
    seen.add(row.provider.id);
    if (row.provider.connected) connected += 1;
  }
  return {
    connected: connected + Number(hasCloud && hostedVerification?.kind === "verified"),
    total: seen.size + Number(hasCloud),
  };
}

/** The always-on status line under the list: how many providers and cloud are connected. */
export function connectStatusLine(rows: readonly ConnectRow[], hostedVerification?: HostedVerificationStatus): string {
  const { connected, total } = connectConnectedCounts(rows, hostedVerification);
  if (total === 0) return "no connections to show";
  if (connected === 0) return "no connections yet - select one to connect";
  return `connected: ${connected} of ${total}`;
}

/** The detail pane's stable, left-aligned header label. */
export function connectDetailTitleLabel(): string {
  return "PROVIDER";
}

/**
 * The detail header's right-aligned summary for the highlighted provider:
 * "connected" when a credential exists, "not connected" when it does not,
 * "sign in" / "signed in" for the cloud row, and "" when nothing is
 * highlighted. Colour is the component's to choose.
 */
export function connectDetailTitleMeta(
  row: ConnectRow | undefined,
  cloudConnected?: boolean,
): string {
  if (!row) return "";
  if (row.kind === "cloud") {
    return cloudConnected ? "login saved" : "sign in";
  }
  if (row.kind !== "provider") return "";
  return row.provider.connected ? "connected" : "not connected";
}

export type ConnectMode = "browse" | "filter" | "input" | "oauth" | "hosted";

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
  if (mode === "input") return "paste credential · [⏎] save · [esc] cancel";
  if (mode === "oauth") return "device sign-in running · [esc] cancel";
  if (mode === "hosted") return "cloud sign-in running · [esc] cancel";
  const action = canContinue ? "continue" : "connect";
  if (mode === "filter") return `type to filter · [⏎] ${action} · [esc] done · [⌫] delete`;
  return [
    "[↑↓] select",
    `[⏎] ${action}`,
    "[/] filter",
    hasFilter ? "[esc] clear filter" : "[esc] back",
    "[⌃C] exit",
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