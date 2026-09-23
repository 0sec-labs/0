/** @jsxImportSource @opentui/react */
/**
 * The `/model` pop-up dialog.
 *
 * The screen is a dialog *body*: an icon+title row, the target / policy
 * context rows, the shared grouped/searchable picker (`DialogSelectBody`) with
 * a detail column beside it, and a status line. The scrim, the rounded panel
 * and the footer hints are the host's — the surface is read through
 * `useSurfaceDimensions`, which reports the panel's inner box when the screen
 * is mounted inside a `DialogSurface` and the terminal otherwise, and the
 * footer text still goes out through the injected `frame`.
 *
 * `/model` used to open a compact selector floating above the composer: a flat
 * list of every priced model, each with a `provider · price` caption. That
 * shape competed with the transcript for the only scarce resource a TUI has —
 * rows — and it had nowhere to put the one thing an operator needs before
 * switching model, which is whether this machine can reach the vendor at all.
 * A turn started against a dark provider dies with zero tokens and a message
 * about a key nobody knew they needed.
 *
 * This screen is the replacement, and it is now a projection of the one shared
 * picker body, `DialogSelectBody`: the grouped, windowed list on the left and
 * the highlighted model's detail on the right, driven inline (no scrim, no
 * floating panel) inside the console shell. The same body serves the modal
 * `DialogSelect` overlay and the settings screen; this file supplies only the
 * domain — which models exist, how they group, what their detail says — and its
 * own keyboard.
 *
 * ## One picker, independent catalogues
 *
 * A hosted connection offers one `0security Auto` choice on the parent
 * picker. Its availability is read from the account's live catalogue; no
 * public model is substituted if that read fails. Connected API-key providers
 * appear beside it, derived from the pricing table and Models.dev. Codex
 * subscription IDs are discovered from the account, not inferred from public
 * model names. Matching IDs across connections remain separate rows because
 * choosing one also chooses its provider.
 *
 * ## What this screen may say about a model
 *
 * API-key rows use their own priced catalogue and provider-qualified context
 * windows. The hosted Auto choice delegates model selection to the service;
 * it never borrows a public model's price or context window. A hosted role
 * assignment may show account-reported capabilities for a concrete route.
 * Listing a route does not assert funding or availability for a request.
 *
 * Every write is an explicit operator action applied to the current audit: the
 * base model, one role's assignment, or the single-model policy. Loading,
 * highlighting, filtering and background refreshing never call those callbacks,
 * and no model is ever selected for the operator.
 *
 * Three further properties are load-bearing:
 *
 * 1. **Nothing here knows the models.** The row model is derived from
 *    `model-catalog.ts` — itself derived from the pricing table or the account's
 *    own catalogue — and the provider facts from `provider-status.ts`. There is
 *    no list, no vendor order and no row count written down, so a model added
 *    to the pricing table appears here with its group, its price and its
 *    credential state without this file changing.
 *
 * 2. **This component does no arithmetic.** Every width, height, row count and
 *    window boundary comes off `model-layout.ts` via
 *    `computeModelDialogLayout` (and `dialog-select-layout.ts` beneath it),
 *    where it is swept across widths and heights by a test. The reason is in
 *    `PRIMITIVES.md`: Yoga shrinks siblings rather than clipping them, so a
 *    row that claims one cell too many paints two strings on top of each
 *    other, and a bordered box one row short of its content paints its own
 *    border through that content.
 *
 * 3. **Credential state is reported per provider, never per model.** A
 *    previous attempt annotated each row "no credentials" using the provider
 *    the catalogue carries. That was wrong and was reverted: the catalogue's
 *    provider comes from the pricing table, while the runtime resolves a
 *    model's provider through its own detection and failover order
 *    (`providerForModel` in `core/src/runtime/llm-api.ts`, which core does not
 *    export). Those disagree — an OpenAI-named model can in fact be served by
 *    the ChatGPT/Codex backend — so a per-row verdict flags working models as
 *    broken. What this screen states is what it can verify: which providers
 *    hold credentials, in the status line and in the detail pane. The operator
 *    judges.
 *
 * ## Only live bindings are advertised
 *
 * The role-assignment and single-model controls exist only when the router
 * actually wired their callbacks. When it did not, the key is not bound, its
 * row is not drawn and the footer does not name it — a control that cannot
 * function is absent, never rendered-and-dead.
 */

import React, { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { loadCodexModelCatalog, type CodexCatalogModel, type RuntimeConfig } from "@0/core";
import { credentialEnvPatch, loadCredentials } from "./credential-store.js";
import { sleekScrollbar } from "./scrollbar.js";
import { useKeyboard, usePaste } from "@opentui/react";
import { decodePasteBytes, TextAttributes } from "@opentui/core";

import { useTheme, type Theme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { Cells, textCells } from "./primitives.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import {
  clampDialogSelection,
  moveDialogSelection,
} from "./dialog-select-layout.js";
import {
  activateModelConnectAction,
  agentRosterLines,
  buildContextWindowIndex,
  clipModelDetailLines,
  computeModelDialogLayout,
  contextWindowFor,
  configuredProviderLabels,
  credentialSummary,
  dialogContentWidth,
  hostedDetailLines,
  isFilterKey,
  isModelConnectAction,
  modelConnectActionItem,
  modelConnectDetailLines,
  modelDetailLines,
  modelDialogCount,
  modelDialogHint,
  modelDialogTitle,
  modelFooterHint,
  modelResultCount,
  modelTargetLine,
  reachableModelCatalog,
  buildModelRows,
  type ModelCatalogScope,
  type ModelDetailLine,
  type ModelDetailTone,
  type ModelMode,
  type ModelRow,
} from "./model-layout.js";
import {
  buildFullModelCatalog,
  buildHostedModelCatalog,
  hostedModelDetails,
  scopeModelCatalog,
} from "./model-catalog.js";
import {
  syncModelCatalog,
  loadCatalogModels,
  loadHostedModelCatalog,
  type HostedCatalogSnapshot,
} from "./model-catalog-sync.js";
import { cloudConfigured, providerStates } from "./provider-status.js";
import { sanitizeTuiText } from "./text.js";
/** How many rows page-up and page-down move. */
const PAGE_STEP = 5;
/**
 * The runtime discriminator for the hosted service. It is the runtime's own
 * provider id, not an upstream supplier name.
 */
const HOSTED_PROVIDER_ID = "hosted";

/** Synthetic parent selection that delegates model choice to the hosted service. */
export const HOSTED_AUTO_MODEL_ID = "";
/** Display label for the service-selected hosted route. */
export const HOSTED_AUTO_LABEL = "0security Auto";
/**
 * The roles an audit can assign a model to. The list is the union of these and
 * whatever keys the caller's map already carries, so a role the caller knows
 * about is targetable even when it is not named here.
 */
const MODEL_ROLES = ["discovery", "attack", "verify", "report", "audit", "review"] as const;

export interface ModelFrameInput {
  /** The screen body, already sized to the rows the frame left it. */
  body: React.ReactNode;
  /** Footer text for the current mode, naming the bindings that actually work. */
  hint: string;
}

export interface ModelScreenProps {
  /**
   * Wraps the body in the console shell.
   *
   * Injected rather than imported so this module does not depend on `run.tsx`
   * — which owns `ShellFrame` and pulls in every other screen with it. The
   * screen states what it needs (a frame, and a footer line whose text changes
   * with the mode) and the router supplies it.
   */
  frame: (input: ModelFrameInput) => React.ReactNode;
  /** The model the session is currently running, when there is one. */
  currentModel?: string;
  /**
   * The runtime this picker is choosing for: `"hosted"` selects the account's
   * own catalogue; other connections use the BYOK catalogue with separate
   * account groups for configured subscription/cloud connections.
   * Never invented — the router reports what the runtime says.
   */
  providerId?: string;
  /** Catalog bound to the running subscription account, when one exists. */
  codexCatalog?: (signal?: AbortSignal) => Promise<CodexCatalogModel[]>;
  /** Per-role model assignments applied to the current audit. */
  agentModels?: Readonly<Record<string, string>>;
  /** Whether the audit is pinned to one model for every role. */
  singleModel?: boolean;
  /**
   * Apply the full merged role map to the current audit. Optional: when the
   * router does not supply it there is no role targeting at all — no Ctrl+←/→,
   * no Ctrl+Backspace, no target row and no footer mention of either.
   */
  onAgentModelsChange?: (models: Readonly<Record<string, string>>) => void;
  /** Apply the single-model policy. Optional on the same terms as above. */
  onSingleModelChange?: (enabled: boolean) => void;
  /** Enter on a model row. The router decides what "select" means. */
  onSelect: (id: string, providerId?: RuntimeConfig["provider"]) => void;
  /** Open the existing provider Connections flow. */
  onConnect?: () => void;
  onBack: () => void;
  /** Wizard-only: skip this decision with Ctrl+N when unfiltered. */
  onSkip?: () => void;
  /** Leave the console entirely — ctrl+c. */
  onExit: () => void;
  /**
   * Environment to read credentials from. Defaults to the real one; injected
   * so the screen can be driven under a synthetic environment without the
   * test mutating `process.env`.
   */
  env?: Record<string, string | undefined>;
}

function toneColor(theme: Theme, tone: ModelDetailTone): string | undefined {
  switch (tone) {
    case "title":
      return theme.PRIMARY;
    case "accent":
      return theme.ACCENT;
    case "ok":
      return theme.SUCCESS;
    case "warn":
      return theme.WARNING;
    case "muted":
    case "blank":
      return theme.MUTED;
    default:
      return theme.TEXT;
  }
}

function modelDialogItems(rows: ModelRow[]): DialogItem[] {
  return rows
    .filter((row): row is Extract<ModelRow, { kind: "model" }> => row.kind === "model")
    .map((row) => ({
      id: row.model.id,
      label: row.model.id,
      meta: row.model.price,
      category: row.group.label,
      current: row.active,
    }));
}

export function ModelScreen({
  frame,
  currentModel,
  providerId,
  codexCatalog,
  agentModels,
  singleModel = false,
  onAgentModelsChange,
  onSingleModelChange,
  onSelect,
  onConnect,
  onBack,
  onSkip,
  onExit,
  env: suppliedEnv,
}: ModelScreenProps) {
  const theme = useTheme();
  const symbols = useSymbols();
  const { width, height } = useSurfaceDimensions();
  const inDialog = useDialogSurface();
  const [reload, setReload] = useState(0);
  const env = useMemo(() => suppliedEnv ?? {
    ...process.env, ...credentialEnvPatch(loadCredentials(), process.env),
  }, [suppliedEnv, reload]);

  // One picker for every connected route. The active runtime determines the
  // initial highlight, not which provider groups are allowed to appear.
  const isHosted = providerId === HOSTED_PROVIDER_ID;
  const cloudCreds = useMemo(() => cloudConfigured(env), [env]);
  const loadHosted = cloudCreds;
  const scope: ModelCatalogScope = "byok";
  // A control exists only when its callback does. These two flags gate the
  // key, the row and the footer text together, so a binding is never named
  // where it would do nothing.
  const rolesLive = onAgentModelsChange !== undefined;
  const singleModelLive = onSingleModelChange !== undefined;

  const [role, setRole] = useState<string | null>(null);
  const roles = useMemo(
    () => [null, ...new Set<string>([...MODEL_ROLES, ...Object.keys(agentModels ?? {})])],
    [agentModels],
  );
  // The model the picker is choosing FOR: the parent model, or the role's own
  // assignment when it has one. A role with no assignment inherits, and the
  // target row says so rather than showing the inherited id as an assignment.
  const activeModel = role === null ? currentModel : (agentModels?.[role] ?? currentModel);
  const [notice, setNotice] = useState("");

  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const filterRef = useRef("");
  const showAllRef = useRef(false);

  // Read once per mount. Credentials are process-level and cannot change
  // under a screen that has no way to set them; re-deriving them on every
  // keystroke would only make the filter slower.
  const credentialStates = useMemo(() => providerStates(env), [env]);
  const loadCodex = providerId === "chatgpt-codex" || credentialStates.some((state) => state.id === "chatgpt-codex" && state.configured);

  // The identity of the connection this load belongs to. A hosted snapshot is
  // only ever shown while it still matches — rows fetched for one account must
  // never paint under another, and Ctrl+R bumps `reload` to force a re-read.
  const source = useMemo(() => ({ providerId, env, reload, codexCatalog }), [providerId, env, reload, codexCatalog]);
  const [hostedState, setHostedState] = useState<{
    source: typeof source;
    snapshot: HostedCatalogSnapshot | null;
    error: string | null;
  } | null>(null);
  const hostedSnapshot = hostedState?.source === source ? hostedState.snapshot : null;
  const hostedError = hostedState?.source === source ? hostedState.error : null;
  const [codexState, setCodexState] = useState<{
    source: typeof source; models: CodexCatalogModel[] | null; failed: boolean;
  } | null>(null);
  const codexModels = codexState?.source === source ? codexState.models : null;
  const codexFailed = codexState?.source === source && codexState.failed;
  // Successful discovery also verifies file-backed Codex credentials that the
  // environment-only provider inventory cannot see. A staged provider alone
  // is not evidence of credentials.
  const states = useMemo(() => credentialStates.map((state) =>
    state.id === "chatgpt-codex" && codexModels !== null
      ? { ...state, configured: true } : state), [credentialStates, codexModels]);
  const configured = useMemo(() => configuredProviderLabels(states), [states]);

  // BYOK: refresh the Models.dev catalog cache in the background whenever the
  // picker opens. Fire-and-forget: it never throws, no-ops when the cache is
  // still fresh, and only affects the *next* open — this render reads whatever
  // cache (or the bundled offline floor) is already on disk, so the list is
  // instant. `catalogNonce` bumps once the refresh lands so an operator who
  // leaves the picker open sees newly-synced models without reopening it.
  //
  // Hosted: read the account's own catalogue live. There is nothing to cache
  // and nothing to fall back to, so a failure is reported as a failure.
  const [catalogNonce, setCatalogNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setRefreshing(true);
    const tasks: Promise<unknown>[] = [];
    if (loadCodex) {
      tasks.push((codexCatalog ? codexCatalog(controller.signal) : loadCodexModelCatalog({ env, signal: controller.signal })).then(
        (models) => { if (alive) setCodexState({ source, models, failed: false }); },
        () => { if (alive) setCodexState({ source, models: null, failed: true }); },
      ));
    }
    // Cloud discovery only controls Auto. A failed read never hides connected
    // API-key models or substitutes a public model for the hosted route.
    if (loadHosted) {
      tasks.push(
        loadHostedModelCatalog({ env })
          .then((snapshot) => {
            // Project before publishing: a malformed catalogue (an id-less or
            // duplicated row) throws here and stays an error rather than being
            // half-drawn.
            buildHostedModelCatalog(snapshot.models);
            if (alive) setHostedState({ source, snapshot, error: null });
          })
          .catch((error: unknown) => {
            // CloudNetworkError / CloudUnauthorizedError (and any other) all mean
            // the same thing to the picker: cloud is unreachable right now. The
            // message is shown; no cached, offline or BYOK row is ever passed off
            // as a hosted route.
            if (alive) {
              setHostedState({
                source,
                snapshot: null,
                error: sanitizeTuiText(
                  error instanceof Error ? error.message : "Hosted catalog failed",
                ),
              });
            }
          }),
      );
    }
    // Refresh the public catalogue independently of Cloud discovery.
    tasks.push(
      syncModelCatalog().then((updated) => {
        if (alive && updated) setCatalogNonce((n) => n + 1);
      }),
    );
    void Promise.allSettled(tasks).finally(() => {
      if (alive) setRefreshing(false);
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [source, loadHosted, loadCodex, env, codexCatalog]);

  const hostedCatalog = useMemo(
    () => (hostedSnapshot ? buildHostedModelCatalog(hostedSnapshot.models) : []),
    [hostedSnapshot],
  );
  const catalog = useMemo(
    () => buildFullModelCatalog(activeModel),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeModel, catalogNonce],
  );
  // BYOK context windows come straight off the synced Models.dev cache (or its
  // bundled offline floor). `CatalogModel` does not carry the field, and
  // `model-catalog.ts` is not this lane's to widen, so the lookup is built
  // here from the same rows the catalogue itself was built from.
  //
  // The index is keyed on **provider and id together**: the same id exists
  // under more than one provider with different windows, so an id-only lookup
  // would report another provider's number as this model's. A pair the feed
  // never described, or one it described inconsistently, is simply not in the
  // index and renders "unknown" — never inferred from a sibling row. The
  // hosted path never consults it: a hosted route's window is the service's
  // own `context_length` or nothing.
  const contextIndex = useMemo(
    () => buildContextWindowIndex(loadCatalogModels().models),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogNonce],
  );
  const scopeCatalog = (query: string, all: boolean) => {
    // The active hosted route does not hide the operator's other connections.
    const scoped = scopeModelCatalog(catalog, { showAll: all, filter: query, currentModel: activeModel });
    // Subscription rows come only from this account, including models absent
    // from the public pricing feed. Do not dress API-key rows as subscription access.
    const catalogRows = [
      ...scoped,
      ...(codexModels ?? []).map((model) => ({ id: model.id, provider: "chatgpt-codex", price: "subscription" })),
    ];
    const codexModelIds = new Set((codexModels ?? []).map((model) => model.id));
    return reachableModelCatalog(catalogRows, states, { env, providerId, codexModelIds })
      .filter((model) => role === null || (
        // Role maps carry IDs but no provider: a child inherits its parent's
        // connection. Never offer a cross-provider assignment it cannot route.
        providerId === "chatgpt-codex" ? model.provider === "chatgpt-codex"
          : providerId === "hosted" ? false
          : model.provider !== "chatgpt-codex" && model.provider === providerId
      ));
  };
  const scopedCatalog = scopeCatalog(filter, showAll);

  // `buildModelRows` does all the domain work — grouping by provider, credential
  // lookup, credential-band ordering, floating the active model first, and the
  // AND-over-terms filter. The screen keeps only its selectable model rows and
  // projects them onto `DialogItem`s: the provider label is the category (so the
  // shared body draws a heading per provider), the price is the right-aligned
  // meta, and the running model carries the current-value dot.
  const modelRows = useMemo(
    () => buildModelRows({ catalog: scopedCatalog, states, filter, activeModel, activeProvider: providerId }),
    [scopedCatalog, states, filter, activeModel, providerId],
  );
  const modelOnlyRows = useMemo(
    () => modelRows.filter((row): row is Extract<ModelRow, { kind: "model" }> => row.kind === "model"),
    [modelRows],
  );
  const byokItems = useMemo(() => modelDialogItems(modelOnlyRows), [modelOnlyRows]);
  // Parent selection exposes one service-managed Auto choice. Concrete hosted
  // routes are only relevant while targeting a role on an existing hosted audit.
  const hostedItems = (query: string): DialogItem[] => {
    if (!cloudCreds || hostedCatalog.length === 0) return [];
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (role === null) {
      return terms.every((term) => HOSTED_AUTO_LABEL.toLowerCase().includes(term))
        ? [{ id: HOSTED_AUTO_MODEL_ID, label: HOSTED_AUTO_LABEL, meta: "service-selected", category: "0security", current: isHosted }]
        : [];
    }
    if (!isHosted) return [];
    return hostedCatalog
      .filter((model) => model.id !== "auto" && terms.every((term) => model.id.toLowerCase().includes(term)))
      .map((model) => ({ id: model.id, label: model.id, category: "0security", current: model.id === activeModel }));
  };
  const connectAction = onConnect ? modelConnectActionItem() : undefined;
  const resultItems = [...hostedItems(filter), ...byokItems];
  const items = connectAction ? [...resultItems, connectAction] : resultItems;
  const hostedById = useMemo(
    () => new Map(hostedCatalog.map((model) => [model.id, model])),
    [hostedCatalog],
  );
  // Item identity preserves the provider's own price, window and credential facts.
  const rowByItem = useMemo(
    () => new Map(byokItems.map((item, index) => [item, modelOnlyRows[index]])),
    [byokItems, modelOnlyRows],
  );
  // Display rows (headings interleaved) drive the panel's scroll/height math.
  const totalRows = useMemo(() => {
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
  }, [items]);

  // Match provider and id so duplicates remain navigable across catalog refreshes.
  const [selectedItem, setSelectedItem] = useState<DialogItem>();
  const selectedItemRef = useRef(selectedItem);
  const selectionIndex = (visible: DialogItem[], selection = selectedItemRef.current) =>
    clampDialogSelection(visible, visible.findIndex((item) =>
      item.id === (selection?.id ?? (isHosted ? HOSTED_AUTO_MODEL_ID : activeModel)) &&
      item.category === (selection?.category ?? (isHosted ? "0security" : states.find((state) => state.id === providerId)?.label)),
    ));
  const cursor = selectionIndex(items, selectedItem);

  // Every width and row count comes off the layout module, from the surface
  // box the dialog handed down — never from `useTerminalDimensions` and never
  // computed here (PRIMITIVES.md: Yoga shrinks siblings rather than clipping).
  // ── Meta lines (above the list), deliberately kept to at most one by default.
  // The header used to carry six-plus lines — a focus line with key hints, a
  // single-model policy line, the full per-agent roster (which wraps to several
  // rows) and a curated/all count — and that dense block stole the rows the
  // picker list needs. So now:
  //   • ONE compact context line, only while role targeting is wired: the
  //     target and the model it resolves to, with the single-model note folded
  //     in. No key hints — those live in the footer.
  //   • The full agent roster is NOT drawn by default. It is revealed only while
  //     the operator is actively targeting a specific role, which is the one
  //     moment the whole per-role mapping matters (so "select each" is visible).
  //   • No single-model line and no curated/all line: the title already names
  //     curated/all and its count, and the footer already names Tab and Ctrl+S.
  // Built here, before the layout, so the layout can size the list against the
  // real demand — the width it wraps to (`dialogContentWidth`) is the same the
  // layout will report.
  const metaContentWidth = dialogContentWidth(width, inDialog);
  const metaLines: { text: string; fg: string }[] = [];
  if (rolesLive) {
    metaLines.push({
      text: modelTargetLine(role, activeModel, role !== null && agentModels?.[role] !== undefined, symbols, singleModel),
      fg: singleModel && role !== null ? theme.WARNING : theme.ACCENT,
    });
    // Reveal the full roster only while a specific role is targeted; the parent
    // (base) view stays at the single context line above.
    if (role !== null) {
      for (const line of agentRosterLines(
        { roles, parentModel: currentModel, agentModels, activeRole: role, singleModel },
        metaContentWidth,
        symbols,
      )) {
        metaLines.push({ text: line.text, fg: line.tone === "warn" ? theme.WARNING : theme.MUTED });
      }
    }
  }

  const layout = computeModelDialogLayout({ width, height, totalRows, inDialog, metaLineCount: metaLines.length });
  const { contentWidth, panel, stackedRows } = layout;
  const listRows = layout.bodyRows - stackedRows;
  const visibleMetaLines = metaLines.slice(0, layout.metaRows);

  const mode: ModelMode = filter ? "filter" : "browse";
  // Connection failures affect only that provider's row; other connected
  // providers remain selectable.
  const cloudStatus = cloudCreds
    ? hostedError
      ? `${symbols.warning} 0security Auto unavailable: ${hostedError} · Ctrl+R retry`
      : hostedSnapshot
        ? hostedCatalog.length > 0
          ? `${hostedSnapshot.host} · 0security Auto`
          : `${symbols.warning} 0security Auto unavailable: this account lists no routes`
        : "0security Auto · loading…"
    : null;
  const baseStatusText = cloudStatus
    ? `${credentialSummary(states)} · ${cloudStatus}`
    : credentialSummary(states);
  const statusText = !loadCodex ? baseStatusText : `${baseStatusText} · ${codexFailed
    ? "Codex model discovery unavailable · Ctrl+R retry"
    : codexModels === null ? "Loading Codex account models…" : `${codexModels.length} Codex account models`}`;

  const currentItems = (): DialogItem[] => {
    const byok = filterRef.current === filter && showAllRef.current === showAll
      ? byokItems
      : modelDialogItems(buildModelRows({
        catalog: scopeCatalog(filterRef.current, showAllRef.current),
        states,
        filter: filterRef.current,
        activeModel,
        activeProvider: providerId,
      }));
    const results = [...hostedItems(filterRef.current), ...byok];
    return connectAction ? [...results, connectAction] : results;
  };
  const highlight = (index: number) => {
    const item = currentItems()[index];
    selectedItemRef.current = item;
    setSelectedItem(item);
  };

  const move = (delta: number) => {
    const visible = currentItems();
    if (visible.length === 0) return;
    const dir: 1 | -1 = delta >= 0 ? 1 : -1;
    let next = selectionIndex(visible);
    for (let i = 0; i < Math.abs(delta); i += 1) next = moveDialogSelection(visible, next, dir);
    highlight(next);
  };

  const setQuery = (next: SetStateAction<string>) => {
    filterRef.current = typeof next === "function" ? next(filterRef.current) : next;
    setFilter(filterRef.current);
    highlight(0);
  };

  usePaste((event) => {
    const text = sanitizeTuiText(decodePasteBytes(event.bytes));
    if (text) setQuery((current) => current + text);
  });

  useKeyboard((key) => {
    const seq = typeof key.sequence === "string" ? key.sequence : "";

    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }

    if (key.ctrl && key.name === "u") return setQuery("");
    if (key.ctrl && key.name === "n" && onSkip && !filterRef.current) return onSkip();
    // Role targeting, single-model policy and inheritance exist only while
    // their callbacks do; without them these keys are not bound at all.
    if (rolesLive && key.ctrl && (key.name === "left" || key.name === "right")) {
      const index = roles.indexOf(role);
      const next = roles[(index + (key.name === "right" ? 1 : -1) + roles.length) % roles.length] ?? null;
      setRole(next);
      setNotice(next === null ? "" : "Role models use the parent audit’s connection.");
      const target = next === null ? currentModel : (agentModels?.[next] ?? currentModel);
      highlight(currentItems().findIndex((item) => item.id === target));
      return;
    }
    if (singleModelLive && key.ctrl && key.name === "s") {
      onSingleModelChange?.(!singleModel);
      setNotice("Single-model policy applied to this audit.");
      return;
    }
    // Ctrl+R re-reads the live hosted catalogue — on the pure hosted lane, and
    // in the merge to retry a dark cloud without losing the BYOK list.
    if ((loadHosted || loadCodex) && key.ctrl && key.name === "r") {
      setReload((value) => value + 1);
      return;
    }
    if (rolesLive && key.ctrl && key.name === "backspace" && role !== null) {
      const next = { ...agentModels };
      delete next[role];
      onAgentModelsChange?.(next);
      setNotice(`${role} now inherits the parent model.`);
      return;
    }
    if (key.ctrl || key.meta || key.option) return;
    if (key.name === "up") return move(-1);
    if (key.name === "down") return move(1);
    if (key.name === "pageup") return move(-PAGE_STEP);
    if (key.name === "pagedown") return move(PAGE_STEP);
    if (key.name === "home") return highlight(0);
    if (key.name === "end") return highlight(Math.max(0, currentItems().length - 1));
    if (key.name === "tab") {
      showAllRef.current = !showAllRef.current;
      setShowAll(showAllRef.current);
      return;
    }
    if (key.name === "return") {
      const visible = currentItems();
      const activeItem = visible[selectionIndex(visible)];
      if (!activeItem) return;
      if (activateModelConnectAction(activeItem, onConnect)) return;
      if (role !== null && rolesLive) {
        onAgentModelsChange?.({ ...agentModels, [role]: activeItem.id });
        setNotice(
          `${role}: ${activeItem.id} applied${singleModel ? "; single-model mode still takes precedence" : ""}.`,
        );
        return;
      }
      // The category is the connection identity. Resolve it from the same
      // live items used for navigation; a filter typed before React paints
      // must not accidentally keep the previous provider.
      const selectedProvider = activeItem.category === "0security" ? "hosted"
        : states.find((state) => state.label === activeItem.category)?.id as RuntimeConfig["provider"] | undefined;
      onSelect(activeItem.id, selectedProvider);
      return;
    }
    if (key.name === "escape") {
      if (filterRef.current) setQuery("");
      else onBack();
      return;
    }
    if (key.name === "backspace") {
      setQuery((current) => Array.from(current).slice(0, -1).join(""));
      return;
    }
    if (isFilterKey(seq)) {
      // Functional updates preserve every character in a paste/fast key burst.
      // A leading slash still opens search; slashes within model IDs are text.
      setQuery((current) => current === "" && seq === "/" ? "" : current + seq);
    }
  });

  // The detail pane shows the highlighted model's full story — what the
  // catalogue reported and nothing else — fitted to the exact box the shared
  // body hands it. Both branches end in a bounded box, so the pane physically
  // cannot paint more rows than it was given.
  const renderDetail = (item: DialogItem, pane: { width: number; height: number }) => {

    const compact = pane.height < 12;
    if (isModelConnectAction(item)) {
      const lines = clipModelDetailLines(
        modelConnectDetailLines(pane.width),
        pane.height,
        pane.width,
      );
      return (
        <>
          {lines.map((line, index) => (
            <Cells
              key={`connect-detail-${index}`}
              width={pane.width}
              fg={toneColor(theme, line.tone)}
            >
              {line.text}
            </Cells>
          ))}
        </>
      );
    }

    if (item.id === HOSTED_AUTO_MODEL_ID) {
      const inner = Math.max(1, pane.width - 1);
      const lines = [
        { text: HOSTED_AUTO_LABEL, tone: "title" as const },
        { text: "The 0security service selects the model for this audit.", tone: "muted" as const },
        { text: hostedCatalog.length > 0 ? "A hosted route is available." : "No hosted model route is available for this account yet.", tone: hostedCatalog.length > 0 ? "ok" as const : "warn" as const },
      ];
      return (
        <box width={inner} flexDirection="column" flexShrink={0} minWidth={0}>
          {lines.map((line, index) => (
            <Cells key={`auto-detail-${index}`} width={inner} fg={toneColor(theme, line.tone)} attributes={line.tone === "title" ? TextAttributes.BOLD : undefined}>
              {line.text}
            </Cells>
          ))}
        </box>
      );
    }
    const row = rowByItem.get(item);
    const hosted = row ? undefined : hostedById.get(item.id);
    if (hosted) {
      // Every string below is the hosted service's own report of this model.
      const details = hostedModelDetails(hosted);
      if (role !== null && rolesLive) {
        details.splice(
          1,
          0,
          `Role advice: ${role} inherits the parent unless you explicitly assign a model.`,
          `Enter applies this exact model to ${role}; Ctrl+Backspace restores inheritance.`,
        );
      }
      // Keep customer capabilities and role controls scrollable in a bounded pane.
      const inner = Math.max(1, pane.width - 1);
      const lines = hostedDetailLines(details, inner, compact);
      return (
        <scrollbox
          key={item.id}
          width={pane.width}
          height={pane.height}
          flexShrink={0}
          scrollX={false}
          verticalScrollbarOptions={sleekScrollbar(theme)}
        >
          <box width={inner} flexDirection="column" flexShrink={0} minWidth={0}>
            {lines.map((line, index) => (
              <Cells
                key={`detail-${index}`}
                width={inner}
                fg={toneColor(theme, line.tone)}
                attributes={line.tone === "title" ? TextAttributes.BOLD : undefined}
              >
                {line.text}
              </Cells>
            ))}
          </box>
        </scrollbox>
      );
    }

    // The BYOK pane is short and bounded — id, provider, price, context, the
    // credential story — and is clipped with a visible marker rather than
    // scrolled. Nothing that was reachable before is dropped.
    const contextTokens = row?.kind === "model"
      ? row.model.provider === "chatgpt-codex"
        ? codexModels?.find((model) => model.id === row.model.id)?.contextTokens ?? null
        : contextWindowFor(contextIndex, row.model.provider, row.model.id)
      : null;
    const lines: ModelDetailLine[] = clipModelDetailLines(
      modelDetailLines({ row, configured, compact, contextTokens }, pane.width, symbols),
      pane.height,
      pane.width,
    );
    return (
      <>
        {lines.map((line, index) => (
          <Cells
            key={`detail-${index}`}
            width={pane.width}
            fg={toneColor(theme, line.tone)}
            attributes={line.tone === "title" ? TextAttributes.BOLD : undefined}
          >
            {line.text}
          </Cells>
        ))}
      </>
    );
  };

  // ── Title row: glyph + label on the left, the live row count on the right.
  // Split explicitly so the two leaves can never be handed overlapping cells.
  const titleText = modelDialogTitle({ scope, showAll: showAll || !!filter.trim(), cloudMerged: cloudCreds });
  const countText = modelDialogCount(modelResultCount(items), refreshing);
  const countWidth = Math.min(contentWidth, textCells(countText));
  const titleWidth = Math.max(0, contentWidth - countWidth - (countWidth > 0 ? 1 : 0));

  const hint = onSkip && !filter
    ? "[esc] back · [⌃N] skip · [⏎] select · [↑↓] move · type to filter · [⌃C] quit"
    : rolesLive && singleModelLive
      ? modelDialogHint({ scope, role, hasFilter: filter.length > 0, canReload: loadHosted || loadCodex })
      : modelFooterHint(mode, filter.length > 0);


  const body = (
    <box flexDirection="column" width="100%" flexGrow={1} minWidth={0} overflow="hidden">
      {layout.titleRows > 0 && contentWidth > 0 ? (
        <box flexDirection="row" width={contentWidth} height={1} flexShrink={0} minWidth={0}>
          <Cells width={titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
            {titleText}
          </Cells>
          {countWidth > 0 ? (
            <>
              {titleWidth > 0 ? <Cells width={1}>{""}</Cells> : null}
              <Cells width={countWidth} align="right" fg={theme.MUTED}>
                {countText}
              </Cells>
            </>
          ) : null}
        </box>
      ) : null}

      {contentWidth > 0
        ? visibleMetaLines.map((line, index) => (
          <Cells key={`meta-${index}`} width={contentWidth} fg={line.fg}>
            {line.text}
          </Cells>
        ))
        : null}

      {listRows < 2 || contentWidth < 1 ? null : (
        <DialogSelectBody
          items={items}
          cursor={cursor}
          panel={panel}
          query={filter}
          placeholder={`${symbols.fieldSearch} Find a model or provider`}
          gutter
          isCurrent={(item) => item.current === true}
          renderDetail={renderDetail}
          onActivateRow={highlight}
          onHoverRow={highlight}
          onScroll={move}
          emptyText={showAll || filter.trim()
            ? "No matches. Ctrl+U clears search."
            : "No connected models found. Open Connections or press Tab to search all."}
        />
      )}

      {stackedRows > 0 && items[cursor] ? (
        <box width={contentWidth} height={stackedRows} flexDirection="column" flexShrink={0} minWidth={0}>
          {renderDetail(items[cursor]!, { width: contentWidth, height: stackedRows })}
        </box>
      ) : null}

      {layout.statusRows > 0 && contentWidth > 0 ? (
        <Cells width={contentWidth} fg={theme.MUTED}>
          {notice || statusText}
        </Cells>
      ) : null}
    </box>
  );

  return <>{frame({ body, hint })}</>;
}
