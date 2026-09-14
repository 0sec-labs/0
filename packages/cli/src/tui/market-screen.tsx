/** @jsxImportSource @opentui/react */
/**
 * The marketplace browser, as a pop-up dialog.
 *
 * `/market` opens the console's one grouped, searchable chooser over the
 * configured registry: an icon+title row, the shared `DialogSelectBody` list
 * grouped by kind (Plugins then Themes) with a live filter, the highlighted
 * artifact's detail in a column beside it whenever the surface is wide enough
 * (dropped, never shrunk below its floor, when it is not), a status line, and
 * a footer of action hints. It shares `model-screen.tsx`'s discipline exactly:
 *
 * 1. **This component does no arithmetic.** Every width, height, row count and
 *    window boundary comes off `market-layout.ts`, where it is swept across
 *    widths 0..200 and heights 0..80 by a test. Yoga shrinks siblings rather
 *    than clipping them, so a row that claims one cell too many paints two
 *    strings on top of each other, and a bordered box one row short of its
 *    content paints its own border through that content.
 *
 * 2. **Install is not enablement, and nothing here runs code.** Installing a
 *    plugin writes its validated bytes to the plugins dir and stops; installing
 *    a theme writes a palette file. Neither enables, applies, or executes
 *    anything. The action is confirmed before it runs, and the detail pane names
 *    the separate, explicit step an operator must take to enable a plugin.
 *
 * 3. **Default endpoint = the Hackstore.** The registry URL comes from
 *    `$0SEC_REGISTRY_URL` or the core `DEFAULT_REGISTRY_URL` (the community
 *    Hackstore index). When it is explicitly disabled, or the fetch fails, the
 *    screen renders an honest empty state — guidance, not a crash.
 *
 * The registry fetch, the install action and the installed-state read are all
 * INJECTED (`load`, `installItem`, `readInstalled`) with real defaults that
 * lazily import `@0sec/core`, so the screen can be driven under a test without
 * touching the network or the filesystem.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { sleekScrollbar } from "./scrollbar.js";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";

import { useTheme, type Theme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { useSettings } from "./settings-store.js";
import { Cells } from "./primitives.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import { computeDialogPanel } from "./dialog-select-layout.js";
import {
  createPluginService,
  type InstalledIndex,
  type MarketFetchResult,
  type MarketInstallResult,
  type PluginService,
} from "./plugin-service.js";
import {
  actionForRow,
  buildMarketItems,
  buildMarketRows,
  clampSelection,
  clipMarketDetailLines,
  computeMarketLayout,
  confirmPrompt,
  isFilterKey,
  marketDetailLines,
  marketDialogItems,
  marketDialogMeta,
  marketEmptyLines,
  marketFooterHint,
  paneTitleColumns,
  moveSelection,
  stateTag,
  type MarketAction,
  type MarketDetailTone,
  type MarketItem,
  type MarketMode,
  type MarketRegistryView,
  type MarketState,
} from "./market-layout.js";

export type { InstalledIndex, MarketFetchResult, MarketInstallResult } from "./plugin-service.js";

/** How many rows page-up and page-down move. */
const PAGE_STEP = 5;

// ---------------------------------------------------------------------------
// Registry URL + service wiring
// ---------------------------------------------------------------------------

/** The registry index URL: prop, then env, then the (empty) core default. */
function resolveRegistryUrl(explicit?: string): string {
  return (explicit ?? process.env["0SEC_REGISTRY_URL"] ?? "").trim();
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MarketFrameInput {
  body: React.ReactNode;
  hint: string;
}

export interface MarketScreenProps {
  /** Wraps the body in the console shell. Injected so this module does not
   *  depend on `run.tsx`, which owns `ShellFrame`. */
  frame: (input: MarketFrameInput) => React.ReactNode;
  /** Leave the screen — Esc, once any filter has been cleared. */
  onBack: () => void;
  /** Leave the console entirely — ctrl+c. */
  onExit: () => void;
  /** Registry URL override. Defaults to $0SEC_REGISTRY_URL then the empty core default. */
  registryUrl?: string;
  /** Pre-fetched registry (tests / synchronous). When given, no fetch runs. */
  initialData?: MarketRegistryView;
  /**
   * The bridge to the plugin machinery. Injected by `run.tsx` (and by tests);
   * when absent, a default service is built from `registryUrl`/`homeDir`. Every
   * install/enable/run/activate action goes through it.
   */
  service?: PluginService;
  /** Async registry loader override. Falls back to `service.fetchRegistry`. */
  load?: (url: string) => Promise<MarketFetchResult>;
  /** Installed/enabled state read override. Falls back to `service.list`. */
  readInstalled?: (homeDir: string | undefined, activeTheme: string) => Promise<InstalledIndex>;
  /** Install override. Falls back to `service.install`. */
  installItem?: (item: MarketItem, homeDir: string | undefined) => Promise<MarketInstallResult>;
  /** True while a turn is in flight, so a run defers. Forwarded to the service. */
  isTurnActive?: () => boolean;
  /** Home dir override for install + state reads. */
  homeDir?: string;
  /** Active theme name; defaults to the live setting. */
  activeThemeName?: string;
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function toneColor(theme: Theme, tone: MarketDetailTone): string | undefined {
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

/**
 * The unselected colour for an artifact row, by install state — the colouring
 * the hand-rolled list carried on its marker and state tag, restored through
 * `DialogItem.tone`. An available artifact stays dim, exactly as before.
 */
function stateColor(theme: Theme, state: MarketState): string {
  switch (state) {
    case "enabled":
    case "active":
      return theme.SUCCESS;
    case "installed":
      return theme.ACCENT;
    default:
      return theme.MUTED;
  }
}

/** Rows the dialog spends on its icon+title row, budgeted out of the body. */
const HEADER_ROWS = 1;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function MarketScreen({
  frame,
  onBack,
  onExit,
  registryUrl,
  initialData,
  service,
  load,
  readInstalled,
  installItem,
  isTurnActive,
  homeDir,
  activeThemeName,
}: MarketScreenProps) {
  const theme = useTheme();
  const symbols = useSymbols();
  const settings = useSettings();
  const { width, height } = useSurfaceDimensions();
  const inDialog = useDialogSurface();

  const url = useMemo(() => resolveRegistryUrl(registryUrl), [registryUrl]);
  const activeTheme = activeThemeName ?? settings.theme;

  // One bridge to the plugin machinery: injected by `run.tsx`/tests, or built
  // here from the resolved URL + home dir. The legacy `load`/`readInstalled`/
  // `installItem` props remain as per-action test overrides on top of it.
  const svc = useMemo<PluginService>(
    () => service ?? createPluginService({ registryUrl: url, homeDir, isTurnActive }),
    [service, url, homeDir, isTurnActive],
  );
  const doLoad = (u: string): Promise<MarketFetchResult> => (load ? load(u) : svc.fetchRegistry());
  const doRead = (h: string | undefined, a: string): Promise<InstalledIndex> =>
    readInstalled ? readInstalled(h, a) : svc.list(a);
  const doInstall = (item: MarketItem, h: string | undefined): Promise<MarketInstallResult> =>
    installItem ? installItem(item, h) : svc.install(item);

  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<MarketMode>("browse");
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState("");

  // A terminal delivers a multi-key burst in one go, so a state commit made by
  // one key has not landed when the next key arrives. Every synchronous
  // decision in the key handler below reads these refs; render keeps reading
  // the state above — refs do not repaint. The raw `setFilter`/`setMode`/
  // `setSelected` are called ONLY from inside the three setters here.
  const filterRef = useRef("");
  const modeRef = useRef<MarketMode>("browse");
  const selectedRef = useRef(0);
  const applyFilter = (next: string) => {
    filterRef.current = next;
    setFilter(next);
  };
  const applyMode = (next: MarketMode) => {
    modeRef.current = next;
    setMode(next);
  };
  const applySelected = (next: number) => {
    selectedRef.current = next;
    setSelected(next);
  };

  // ── the pending intent ──
  //
  // Confirm mode used to be a bare flag: `enter` set it, and both the prompt
  // the operator reads and the action `y` dispatches re-derived the item and
  // the action independently, at two different moments. Anything that moved
  // the selection between them — a key burst, a registry refresh, a state
  // re-read — let the operator confirm one artifact and dispatch another.
  //
  // So the exact item and the exact action are captured ONCE, when confirm
  // mode is entered, and that single value is what the prompt renders (from
  // state) and what `y` dispatches (from the ref). `y` does nothing at all
  // when there is no pending intent.
  const [pendingIntent, setPendingIntent] = useState<{ item: MarketItem; action: MarketAction } | null>(null);
  const pendingIntentRef = useRef<{ item: MarketItem; action: MarketAction } | null>(null);
  const applyPendingIntent = (next: { item: MarketItem; action: MarketAction } | null) => {
    pendingIntentRef.current = next;
    setPendingIntent(next);
  };

  // Registry data: seeded synchronously from `initialData`, otherwise fetched.
  const [data, setData] = useState<MarketRegistryView | undefined>(initialData);
  const [loaded, setLoaded] = useState(initialData !== undefined || url.length === 0);
  const [error, setError] = useState<string | undefined>(undefined);

  const [installed, setInstalled] = useState<InstalledIndex>(() => ({
    themes: new Set(),
    activeTheme,
    plugins: new Map(),
  }));

  // Fetch the registry once, unless it was handed in or none is configured.
  useEffect(() => {
    if (initialData !== undefined || url.length === 0) return;
    let live = true;
    void doLoad(url).then((result) => {
      if (!live) return;
      if (result.ok) setData(result.result);
      else setError(result.error);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doLoad is derived from svc/load, tracked below
  }, [initialData, svc, load, url]);

  // Read installed/enabled state once per mount.
  useEffect(() => {
    let live = true;
    void doRead(homeDir, activeTheme).then((index) => {
      if (live) setInstalled(index);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doRead is derived from svc/readInstalled, tracked below
  }, [svc, readInstalled, homeDir, activeTheme]);

  const stateFor = useMemo(() => {
    return (item: MarketItem): MarketState => {
      if (item.kind === "theme") {
        if (item.id === installed.activeTheme) return "active";
        return installed.themes.has(item.id) ? "installed" : "available";
      }
      return installed.plugins.get(item.id) ?? "available";
    };
  }, [installed]);

  const items = useMemo(() => buildMarketItems(data), [data]);
  const rows = useMemo(
    () => buildMarketRows({ items, filter, stateFor }),
    [items, filter, stateFor],
  );

  const cursor = clampSelection(rows, selected);
  const activeRow = cursor >= 0 ? rows[cursor] : undefined;
  const activeItem = activeRow?.kind === "item" ? activeRow.item : undefined;
  const activeState = activeRow?.kind === "item" ? activeRow.state : undefined;

  // Geometry: the shell's own content/row budget (less the dialog's title row
  // and the status line) feeds the shared picker's inline panel, which owns the
  // list/detail split, the column budgets and the scroll window.
  const layout = computeMarketLayout({
    width,
    height,
    noticeRows: 1,
    // Inside a dialog the host draws one footer row and no padding; the
    // surface is the panel interior, so no shell chrome comes off it.
    ...(inDialog ? { hostRows: 1, hostPaddingX: 0 } : {}),
  });
  const { items: dialogItems, rowIndexOfItem } = useMemo(
    () => marketDialogItems(rows, (state) => stateColor(theme, state)),
    [rows, theme],
  );
  const dialogCursor = Math.max(0, rowIndexOfItem.indexOf(cursor));
  const totalRows = useMemo(() => {
    let count = 0;
    let group = "";
    for (const item of dialogItems) {
      if (item.category && item.category !== group) {
        group = item.category;
        count += 1;
      }
      count += 1;
    }
    return count;
  }, [dialogItems]);
  const panel = computeDialogPanel({
    width: layout.contentWidth,
    height,
    size: "large",
    totalRows,
    withDetail: true,
    bodyRows: Math.max(1, layout.bodyRows - HEADER_ROWS),
  });

  useEffect(() => {
    if (cursor >= 0 && cursor !== selected) applySelected(cursor);
  }, [cursor, selected]);

  const reachableButEmpty = loaded && !error && url.length > 0 && items.length === 0;

  // The rows every synchronous decision in the key handler resolves against.
  // They recompute only when the ref and the render-time filter disagree — that
  // is, mid-burst — and otherwise hand back the memo itself.
  const currentRows = () =>
    filterRef.current === filter ? rows : buildMarketRows({ items, filter: filterRef.current, stateFor });
  /** The highlighted row, its item, its state and its action, all from one read. */
  const currentTarget = () => {
    const visible = currentRows();
    const at = clampSelection(visible, selectedRef.current);
    const row = at >= 0 ? visible[at] : undefined;
    const item = row?.kind === "item" ? row.item : undefined;
    const state = row?.kind === "item" ? row.state : undefined;
    const action: MarketAction = item && state ? actionForRow(item.kind, state) : "none";
    return { visible, at, item, action };
  };

  const move = (delta: number) => {
    const visible = currentRows();
    const next = moveSelection(visible, clampSelection(visible, selectedRef.current), delta);
    if (next >= 0) applySelected(next);
  };

  const setQuery = (next: string) => {
    applyFilter(next);
    applySelected(0);
  };

  // The action `enter` triggers for the highlighted row: install → enable → run
  // for plugins, install → activate for themes. `none` for a terminal state
  // (an already-enabled plugin, the active theme).
  const activeAction: MarketAction =
    activeItem && activeState ? actionForRow(activeItem.kind, activeState) : "none";

  // Apply a completed action's result: surface its message and, on success,
  // re-read installed/enabled state so the row tag and detail reflect it live.
  const applyResult = (result: { ok: boolean; message: string }) => {
    setNotice(result.message);
    if (result.ok) void doRead(homeDir, activeTheme).then(setInstalled);
  };

  // Each row action maps to exactly one service method. Install writes bytes and
  // runs nothing; enable records the operator's capability approval; run loads an
  // already-enabled plugin (deferring while a turn is in flight); activate hands
  // a theme off to the theme setting. None is ever implied by another.
  const dispatchAction = (action: MarketAction, item: MarketItem) => {
    switch (action) {
      case "install":
        setNotice(`Installing ${item.name}…`);
        void doInstall(item, homeDir).then(applyResult);
        return;
      case "enable":
        setNotice(`Enabling ${item.name}…`);
        void svc.enable(item).then(applyResult);
        return;
      case "run":
        setNotice(`Loading ${item.name}…`);
        void svc.run(item).then(applyResult);
        return;
      case "activate":
        setNotice(`Applying ${item.name}…`);
        void svc.activateTheme(item).then(applyResult);
        return;
      default:
        return;
    }
  };

  useKeyboard((key) => {
    const seq = typeof key.sequence === "string" ? key.sequence : "";

    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }

    // ── confirm mode ── (nothing effectful happens without a keystroke here)
    if (modeRef.current === "confirm") {
      if (seq === "y" || seq === "Y") {
        const intent = pendingIntentRef.current;
        // Require the captured intent in render state, not just the newly queued
        // ref: Enter+y in one input batch must not auto-confirm. This is a batch
        // boundary, not proof of terminal paint or operator attention.
        if (intent && pendingIntent === intent) {
          dispatchAction(intent.action, intent.item);
          applyPendingIntent(null);
          applyMode("browse");
        }
        return;
      }
      if (seq === "n" || seq === "N" || key.name === "escape") {
        setNotice("Cancelled.");
        applyPendingIntent(null);
        applyMode("browse");
        return;
      }
      return;
    }

    if (key.name === "up") return move(-1);
    if (key.name === "down") return move(1);
    if (key.name === "pageup") return move(-PAGE_STEP);
    if (key.name === "pagedown") return move(PAGE_STEP);

    if (key.name === "return") {
      const { item: activeItem, action: activeAction } = currentTarget();
      if (!activeItem) return;
      if (activeAction === "none") {
        setNotice(
          activeItem.kind === "theme"
            ? `${activeItem.id} is already the active theme.`
            : `${activeItem.id} is already enabled for this project.`,
        );
      } else {
        // Every effectful action is confirmed before it runs. The item and the
        // action are pinned here, once, and neither the prompt nor `y` looks
        // them up again.
        setNotice("");
        applyPendingIntent({ item: activeItem, action: activeAction });
        applyMode("confirm");
      }
      return;
    }

    // ── filter mode ──
    if (modeRef.current === "filter") {
      if (key.name === "escape") {
        setQuery("");
        applyMode("browse");
        return;
      }
      if (key.name === "backspace") {
        setQuery(filterRef.current.slice(0, -1));
        return;
      }
      if (isFilterKey(seq)) setQuery(filterRef.current + seq);
      return;
    }

    // ── browse mode ──
    if (key.name === "escape") {
      if (filterRef.current) {
        setQuery("");
        return;
      }
      onBack();
      return;
    }
    if (key.name === "backspace") {
      if (filterRef.current) setQuery(filterRef.current.slice(0, -1));
      return;
    }
    if (seq === "/") {
      applyMode("filter");
      setQuery("");
      return;
    }
    if (isFilterKey(seq)) {
      applyMode("filter");
      setQuery(seq);
    }
  });

  // The detail column: the highlighted artifact's full registry story, fitted
  // to the exact box the shared body hands it (OpenTUI does not clip).
  const renderDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    if (!activeRow) return null;
    // One column is left for the scrollbar. The lines are NOT clipped: an
    // artifact's capabilities, signature and version notes stay reachable by
    // scrolling rather than being cut off at the bottom of the pane.
    const inner = Math.max(1, pane.width - 1);
    const lines = marketDetailLines({ row: activeRow, compact: pane.height < 12 }, inner);
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
            <Cells key={`detail-${index}`} width={inner} fg={toneColor(theme, line.tone)}>
              {line.text}
            </Cells>
          ))}
        </box>
      </scrollbox>
    );
  };

  // The honest empty/error state: an unconfigured registry, a failed fetch or a
  // filter that matched nothing each say so in the body rather than showing an
  // empty frame that reads like a crash.
  const emptyLines = rows.length === 0
    ? clipMarketDetailLines(
        filter
          ? [{ text: "No extensions match this filter.", tone: "muted" }]
          : !loaded
            ? [{ text: "Loading extensions…", tone: "muted" }]
            : marketEmptyLines({ registryUrl: url, error, reachableButEmpty }, layout.contentWidth),
        Math.max(1, layout.bodyRows - HEADER_ROWS),
        layout.contentWidth,
      )
    : [];


  const statusText =
    mode === "confirm" && pendingIntent
      ? confirmPrompt(
          pendingIntent.item.name,
          pendingIntent.item.kind,
          pendingIntent.action,
          pendingIntent.item.capabilities,
        )
      : mode === "filter"
        ? `filter: ${filter}_`
        : notice
          ? notice
          : url.length === 0
            ? "registry: not configured — set 0SEC_REGISTRY_URL"
            : `registry: ${url}`;

  const statusTone =
    mode === "confirm"
      ? theme.WARNING
      : notice && mode !== "filter"
        ? theme.TEXT
        : theme.MUTED;

  // Title row: `⊞ Marketplace` on the left; on the right the count of what is
  // actually listed, plus the highlighted artifact's real install state.
  const title = `${operatorIcon("market", symbols)} ${operatorTitle("market")}`;
  const meta = [
    marketDialogMeta(dialogItems.length, items.length),
    activeState ? stateTag(activeState) : "",
  ].filter(Boolean).join(" · ");
  const titleCols = paneTitleColumns(layout.contentWidth, meta.length);

  const body = (
    <box flexDirection="column" width="100%" flexGrow={1} minWidth={0}>
      <box flexDirection="row" width={layout.contentWidth} flexShrink={0} minWidth={0}>
        <Cells width={titleCols.titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
          {title}
        </Cells>
        <Cells width={titleCols.gap}>{""}</Cells>
        <Cells width={titleCols.metaWidth} align="right" fg={theme.MUTED}>
          {meta}
        </Cells>
      </box>
      {rows.length === 0 ? (
        <box flexDirection="column" width="100%" flexGrow={1} minWidth={0}>
          {emptyLines.map((line, index) => (
            <Cells key={`empty-${index}`} width={layout.contentWidth} fg={toneColor(theme, line.tone)}>
              {line.text}
            </Cells>
          ))}
        </box>
      ) : (
        <DialogSelectBody
          items={dialogItems}
          cursor={dialogCursor}
          panel={panel}
          query={filter}
          placeholder="type to filter extensions"
          emptyText="No extensions match this filter."
          renderDetail={renderDetail}
          onActivateRow={(itemIndex) => {
            // Click SELECTS (highlights) a row, exactly as keyboard navigation
            // does; install/enable/run stay behind Enter. Map the clicked item
            // back into selection space the way the cursor→display map runs.
            const rowIndex = rowIndexOfItem[itemIndex];
            if (rowIndex !== undefined) applySelected(rowIndex);
          }}
          onHoverRow={(itemIndex) => {
            // Hover previews selection, exactly as arrow-key navigation does.
            const rowIndex = rowIndexOfItem[itemIndex];
            if (rowIndex !== undefined) applySelected(rowIndex);
          }}
          onScroll={move}
        />
      )}
      {rows.length > 0 || notice || mode !== "browse" ? (
      <box flexDirection="row" width="100%" flexShrink={0} minWidth={0}>
        <Cells width={layout.contentWidth} fg={statusTone}>
          {statusText}
        </Cells>
      </box>
      ) : null}
    </box>
  );

  const hasFilter = filter.length > 0;
  const hint = rows.length === 0 && !hasFilter && mode === "browse"
    ? "[esc] back · [⌃C] exit"
    : marketFooterHint(mode, hasFilter, activeAction);
  return <>{frame({ body, hint })}</>;
}
