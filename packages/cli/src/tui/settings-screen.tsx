/** @jsxImportSource @opentui/react */
/**
 * The settings dialog.
 *
 * This is a pop-up, not a route: the host wraps it in `DialogSurface`, which
 * owns the scrim, the rounded panel and the centring, and
 * `useSurfaceDimensions` reports that panel's inner box so every row and cell
 * budget here is measured against the dialog rather than the terminal.
 *
 * The body is the console's one shared picker (`DialogSelectBody`) driven in
 * inline `bodyRows` mode: an icon+title row, a search line, the whole settings
 * table grouped under its category headings, the highlighted setting's prose
 * and LIVE PREVIEW in the detail column beside it, and a status line. The
 * footer of bindings is the HOST's single row, drawn from the `hint` this
 * screen returns through `frame` — it is deliberately not drawn twice. When
 * the surface is too narrow for two columns the detail stacks under the list
 * instead, and when it is narrower still the list keeps every cell.
 *
 * Groups, values and controls still come from `SETTING_DEFS` and the existing
 * store, and every read and write goes through `settings-store.ts` exactly as
 * before: saves notify subscribers immediately, and failed persistence stays
 * visible rather than pretending the change was saved.
 *
 * Three properties stay load-bearing across that reshaping:
 *
 * 1. **Nothing here knows the settings.** The row model is derived from
 *    `SETTING_DEFS` on every render, so a def added to that table appears with
 *    its group heading, its detail text and its preview without this file
 *    changing. There is no list, no group order and no row count written down.
 *
 * 2. **This component does no arithmetic.** Every width, height, row count and
 *    window boundary comes off `settings-layout.ts` and
 *    `dialog-select-layout.ts`, where it is swept across widths and heights by
 *    a test. The reason is in `PRIMITIVES.md`: Yoga shrinks siblings rather
 *    than clipping them, so a row that claims one cell too many paints two
 *    strings on top of each other, and a bordered box one row short of its
 *    content paints its own border through that content.
 *
 * 3. **Every change is persisted immediately, and a failed write is
 *    reported.** A settings screen that silently drops changes on a read-only
 *    `$HOME` is worse than one that refuses to open.
 */

import React, { useMemo, useRef, useState } from "react";
import { useKeyboard, usePaste } from "@opentui/react";
import { decodePasteBytes, TextAttributes } from "@opentui/core";

import { Cells } from "./primitives.js";
import { getSettings, resetSettings, updateSetting, useSettings } from "./settings-store.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { useTheme, type Theme } from "./theme-context.js";
import { sanitizeTuiText } from "./text.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import {
  clampDialogSelection,
  moveDialogSelection,
} from "./dialog-select-layout.js";
import {
  SETTINGS_DIALOG_HOST_ROWS,
  buildSettingsRows,
  computeSettingsLayout,
  cycleSetting,
  isFilterKey,
  isSettingModified,
  resetAllSettings,
  resetSetting,
  settingValue,
  settingValueLabel,
  settingsDetailLines,
  settingsFooterHint,
  shellChromeRows,
  titleColumns,
  type SettingsDetailTone,
  type SettingsMode,
  type SettingsRow,
} from "./settings-layout.js";
import { SETTING_DEFS, type SettingDef, type TuiSettings } from "./settings.js";
import { SettingsPreview, previewRowCount } from "./settings-preview.js";

/** How many rows page-up and page-down move. */
const PAGE_STEP = 5;
/** Rows kept for the setting's prose before any preview is lent room. */
const MIN_TEXT_ROWS = 6;
/** The dialog's own identity, from the shared operator icon/title table. */
const SCREEN_KEY = "settings";

export interface SettingsFrameInput {
  /** The settings body, already sized to the rows the frame left it. */
  body: React.ReactNode;
  /** Footer text for the current mode, naming the bindings that actually work. */
  hint: string;
}

export interface SettingsScreenProps {
  /**
   * Wraps the body in the console shell.
   *
   * Injected rather than imported so this module does not depend on `run.tsx`
   * — which owns `ShellFrame` and pulls in every other screen with it. The
   * screen states what it needs (a frame, and a footer line whose text changes
   * with the mode) and the router supplies it.
   */
  frame: (input: SettingsFrameInput) => React.ReactNode;
  /** Leave the screen — Esc, once any filter has been cleared. */
  onBack: () => void;
  /** Leave the console entirely — ctrl+c. */
  onExit: () => void;
  /** Overrides the settings file location. Tests only. */
  homeDir?: string;
}

type PendingReset =
  | { kind: "one"; key: keyof TuiSettings; label: string; value: string }
  | { kind: "all" };

interface Notice {
  text: string;
  tone: "error" | "warn" | "info";
}

function toneColor(tone: SettingsDetailTone, theme: Theme): string | undefined {
  switch (tone) {
    case "title":
      return theme.PRIMARY;
    case "accent":
      return theme.ACCENT;
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
 * A table key as a `TuiSettings` key.
 *
 * `SETTING_DEFS` is published under the deliberately loose `SettingDef`, whose
 * `key` is a plain string, while the store's writes are keyed on
 * `keyof TuiSettings`. One narrow, named cast here is better than the same
 * assertion at four call sites, and every write still leaves through
 * `normalizeSettings`, which is total — a key the interface does not have is
 * repaired rather than trusted.
 */
function settingKey(key: string): keyof TuiSettings {
  return key as keyof TuiSettings;
}

function settingsDialogItems(rows: SettingsRow[], settings: TuiSettings): DialogItem[] {
  return rows
    .filter((row): row is Extract<SettingsRow, { kind: "setting" }> => row.kind === "setting")
    .map((row) => ({
      id: row.def.key,
      label: row.def.label,
      meta: settingValueLabel(row.def, settingValue(settings, row.def)),
      category: row.group,
      current: isSettingModified(settings, row.def),
    }));
}

/** Display rows (category headings interleaved) the picker would render. */
function displayRowCount(items: readonly DialogItem[]): number {
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

/** First index of the group `index` sits in. */
function groupStart(items: readonly DialogItem[], index: number): number {
  const category = items[index]?.category;
  let at = index;
  while (at > 0 && items[at - 1]?.category === category) at -= 1;
  return at;
}

export function SettingsScreen({ frame, onBack, onExit }: SettingsScreenProps) {
  const { width, height } = useSurfaceDimensions();
  const inDialog = useDialogSurface();
  const theme = useTheme();

  // The live settings, read from the process-wide store. This screen is the
  // writer: the store's writes persist AND notify every other subscribed
  // screen synchronously, so a change here takes effect on the chat screen
  // without a remount.
  const settings = useSettings();
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const filterRef = useRef("");
  const filteringRef = useRef(false);
  const setFilterMode = (value: boolean) => {
    filteringRef.current = value;
    setFiltering(value);
  };
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const [pending, setPending] = useState<PendingReset | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // `buildSettingsRows` does the domain work — grouping by the table's group,
  // first-appearance order, and the AND-over-terms filter across key, label,
  // group, description and choices. The dialog shows every group at once (the
  // picker draws a heading per category), so no group is selected away and a
  // search is always a search of the whole table. The screen keeps only the
  // selectable setting rows and projects them onto `DialogItem`s: the group is
  // the category, the current value is the right-aligned meta, and a setting
  // that differs from its default carries the current-value gutter dot.
  const settingsRows = useMemo(() => buildSettingsRows(SETTING_DEFS, filter), [filter]);
  const items = useMemo(() => settingsDialogItems(settingsRows, settings), [settingsRows, settings]);
  const defByKey = useMemo(() => {
    const map = new Map<string, SettingDef>();
    for (const def of SETTING_DEFS) map.set(def.key, def);
    return map;
  }, []);
  const totalRows = useMemo(() => displayRowCount(items), [items]);

  // The highlighted row can vanish from under the cursor as the filter narrows,
  // so the rendered cursor is always the clamped one.
  const cursor = clampDialogSelection(items, selected);
  const modifiedCount = useMemo(
    () => SETTING_DEFS.reduce((count, def) => count + (isSettingModified(settings, def) ? 1 : 0), 0),
    [settings],
  );

  const mode: SettingsMode = pending
    ? pending.kind === "all"
      ? "confirm-reset-all"
      : "confirm-reset"
    : filtering
      ? "filter"
      : "browse";

  // The status line under the list carries the confirm prompt and any save
  // failure. The filter lives in the picker's search line, so it does not
  // compete for this row.
  const statusText = pending
    ? pending.kind === "all"
      ? "Reset ALL settings to their defaults? y confirm / n cancel"
      : `Reset "${pending.label}" to ${pending.value}? y confirm / n cancel`
    : notice
      ? notice.text
      : `${items.length} setting${items.length === 1 ? "" : "s"} · ${modifiedCount} changed · changes save automatically`;
  const statusTone = pending ? theme.WARNING : notice?.tone === "error" ? theme.ERROR : theme.MUTED;

  // Inside a dialog the surface IS the panel's inner box — the shell renders
  // with `dialogContent`, so it has no header and no padding — and the only
  // rows the host still spends are its one footer and the route's clickable
  // harness line. Outside a dialog the legacy shell chrome still applies.
  const layout = computeSettingsLayout(width, height, totalRows, inDialog
    ? { chromeRows: SETTINGS_DIALOG_HOST_ROWS, chromeColumns: 0 }
    : { chromeRows: shellChromeRows(width) });
  const { panel, contentWidth } = layout;

  /**
   * Reports a failed persist without discarding the in-memory choice.
   *
   * The store's writes persist, update the in-memory copy AND notify every
   * subscriber synchronously, then report whether the disk write succeeded as
   * their return value rather than throwing — because a read-only `$HOME` must
   * not take the console down. What they must also not do is look like they
   * worked: the change stays live for the session and the status line says so.
   */
  const reportSave = (saved: boolean) => {
    setPending(null);
    if (saved) {
      setNotice(null);
      return;
    }
    setNotice({
      tone: "error",
      text: "Changed for this session only - the settings file could not be written.",
    });
  };

  /**
   * Applies one change through the store's single-key write.
   *
   * `updateSetting` writes exactly the key that changed, into the layer that
   * owns it. A whole-object `setSettings` would rewrite every other key at the
   * same time and flatten the global/project layering, so the per-key write is
   * the one the screen uses.
   */
  const commit = (next: TuiSettings, key: keyof TuiSettings) => {
    reportSave(updateSetting(key, next[key]));
  };

  const currentItems = () => filterRef.current === filter
    ? items
    : settingsDialogItems(buildSettingsRows(SETTING_DEFS, filterRef.current), getSettings());
  const highlight = (next: number) => {
    selectedRef.current = next;
    setSelected(next);
  };

  const change = (delta: 1 | -1) => {
    const visible = currentItems();
    const item = visible[clampDialogSelection(visible, selectedRef.current)];
    const activeDef = item ? defByKey.get(item.id) : undefined;
    if (!activeDef) return;
    commit(cycleSetting(getSettings(), activeDef.key, delta), settingKey(activeDef.key));
  };

  const move = (delta: number) => {
    const visible = currentItems();
    if (visible.length === 0) return;
    const dir: 1 | -1 = delta >= 0 ? 1 : -1;
    let next = clampDialogSelection(visible, selectedRef.current);
    for (let i = 0; i < Math.abs(delta); i += 1) next = moveDialogSelection(visible, next, dir);
    highlight(next);
  };

  /**
   * Tab jumps the cursor to the next (or previous) group heading.
   *
   * The rail is gone and every group is on screen, so Tab is no longer a tab
   * bar — it is the fast way down a long grouped list, and it wraps exactly as
   * up/down do.
   */
  const jumpGroup = (dir: 1 | -1) => {
    const visible = currentItems();
    if (visible.length === 0) return;
    const at = clampDialogSelection(visible, selectedRef.current);
    const category = visible[at]?.category;
    if (dir === 1) {
      for (let index = at + 1; index < visible.length; index += 1) {
        if (visible[index]?.category !== category) return highlight(index);
      }
      return highlight(0);
    }
    const start = groupStart(visible, at);
    if (at !== start) return highlight(start);
    if (start > 0) return highlight(groupStart(visible, start - 1));
    return highlight(groupStart(visible, visible.length - 1));
  };

  const setQuery = (next: string) => {
    filterRef.current = next;
    setFilter(next);
    highlight(0);
  };

  usePaste((event) => {
    if (pending) return;
    const text = sanitizeTuiText(decodePasteBytes(event.bytes));
    if (!text) return;
    setFilterMode(true);
    setQuery(filterRef.current + text);
  });

  useKeyboard((key) => {
    const seq = typeof key.sequence === "string" ? key.sequence : "";
    const isSpace = key.name === "space" || seq === " ";

    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    if (key.ctrl && key.name === "u") {
      setPending(null);
      setQuery("");
      setFilterMode(false);
      return;
    }
    if (key.ctrl || key.meta) return;

    // ── confirm gate ──
    // Nothing is reset without passing through here. Anything that is not an
    // explicit yes cancels, so a stray keystroke can only ever be a no.
    if (pending) {
      if (key.name === "return" || seq === "y" || seq === "Y") {
        // Only the keys the table actually shows are reset. The store's
        // `resetSettings` writes exactly those and drops their project
        // shadows, so hidden or metadata-only keys — the ones that record
        // that an operator has already been asked something — survive a
        // "reset all" instead of being re-armed by it.
        const keys = pending.kind === "all"
          ? SETTING_DEFS.map((def) => settingKey(def.key))
          : [pending.key];
        const next = pending.kind === "all"
          ? resetAllSettings()
          : resetSetting(getSettings(), pending.key);
        reportSave(resetSettings(next, keys));
        return;
      }
      setPending(null);
      return;
    }

    // Up/down and paging move the selection in every non-confirm mode, filter
    // capture included, so the list can be walked while a query is being typed.
    if (key.name === "up") return move(-1);
    if (key.name === "down") return move(1);
    if (key.name === "pageup") return move(-PAGE_STEP);
    if (key.name === "pagedown") return move(PAGE_STEP);
    if (key.name === "home") return highlight(0);
    if (key.name === "end") return highlight(Math.max(0, currentItems().length - 1));
    if (key.name === "left") return change(-1);
    if (key.name === "right") return change(1);

    // ── filter mode ──
    // Every printable character types here, `r` and `R` included; that is the
    // whole point of having an explicit mode, since browse mode has to give
    // those two letters to reset.
    if (filteringRef.current) {
      if (key.name === "escape") {
        setFilterMode(false);
        return;
      }
      if (key.name === "return") return change(1);
      if (key.name === "backspace") {
        setQuery(Array.from(filterRef.current).slice(0, -1).join(""));
        return;
      }
      if (isFilterKey(seq) || seq === "r" || seq === "R") {
        setQuery(filterRef.current + seq);
      }
      return;
    }

    // Tab walks the groups; left/right always edit the highlighted value.
    if (key.name === "tab") return jumpGroup(key.shift ? -1 : 1);

    // ── browse mode ──
    if (key.name === "escape") {
      // Esc unwinds one step at a time: clear the filter first, leave second.
      if (filterRef.current) {
        setQuery("");
        return;
      }
      onBack();
      return;
    }
    if (key.name === "return" || isSpace) return change(1);
    if (key.name === "backspace") {
      if (filterRef.current) setQuery(Array.from(filterRef.current).slice(0, -1).join(""));
      return;
    }
    if (seq === "r") {
      const visible = currentItems();
      const item = visible[clampDialogSelection(visible, selectedRef.current)];
      const activeDef = item ? defByKey.get(item.id) : undefined;
      if (!activeDef) return;
      setPending({
        kind: "one",
        key: settingKey(activeDef.key),
        label: activeDef.label,
        value: settingValueLabel(activeDef, activeDef.default),
      });
      return;
    }
    if (seq === "R") {
      setPending({ kind: "all" });
      return;
    }
    if (seq === "/") {
      setFilterMode(true);
      setQuery("");
      return;
    }
    if (isFilterKey(seq)) {
      setFilterMode(true);
      setQuery(filterRef.current + seq);
    }
  });

  /**
   * The detail pane: the setting's prose, then — when the pane can spare the
   * rows — a live visual PREVIEW of its current value.
   *
   * The preview reserves rows first, but never so many that the description
   * loses its footing: at least `MIN_TEXT_ROWS` stay with the prose, and the
   * preview only appears when it can show its header plus real content. The
   * width and the total row budget come off the shared body's `pane`; this is
   * the one split the screen performs on top, and the preview physically cannot
   * paint more rows than it is lent.
   *
   * Current/default values precede the prose, and the prose scrolls inside its
   * own viewport rather than being cut, so a long description stays reachable
   * on a short pane instead of ending at a clip marker.
   */
  const renderDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    const def = defByKey.get(item.id);
    const value = settingValue(settings, def);
    const desired =
      def && pane.width > 0
        ? previewRowCount({ def, value, width: pane.width, settings })
        : 0;
    let previewRows = 0;
    if (desired >= 2 && pane.height >= MIN_TEXT_ROWS + 2) {
      previewRows = Math.min(desired, pane.height - MIN_TEXT_ROWS);
      if (previewRows < 2) previewRows = 0;
    }
    const textRows = pane.height - previewRows;
    const detailWidth = Math.max(1, pane.width - 1);
    const detailLines = settingsDetailLines(def, value, detailWidth, { compact: pane.height < 12 });
    return (
      <>
        <scrollbox
          key={item.id}
          width={pane.width}
          height={textRows}
          flexShrink={0}
          scrollX={false}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.PANEL,
              foregroundColor: theme.MUTED,
            },
            arrowOptions: {
              foregroundColor: theme.MUTED,
              backgroundColor: theme.PANEL,
            },
          }}
        >
          <box width={detailWidth} flexDirection="column" flexShrink={0} minWidth={0}>
            {detailLines.map((line, index) => (
              <Cells key={`detail-${index}`} width={detailWidth} fg={toneColor(line.tone, theme)}
                attributes={line.tone === "title" ? TextAttributes.BOLD : undefined}>
                {line.text}
              </Cells>
            ))}
          </box>
        </scrollbox>
        {previewRows > 0 ? (
          <SettingsPreview
            def={def}
            value={value}
            width={pane.width}
            settings={settings}
            rowBudget={previewRows}
            theme={theme}
          />
        ) : null}
      </>
    );
  };

  const hint = settingsFooterHint(mode, filter.length > 0);
  const titleText = `${operatorIcon(SCREEN_KEY)} ${operatorTitle(SCREEN_KEY)}`;
  const titleMeta = modifiedCount > 0
    ? `${modifiedCount} changed`
    : `${SETTING_DEFS.length} settings`;
  const title = titleColumns(contentWidth, titleMeta.length);
  const selectedItem = items[cursor];

  const body = (
    <box flexDirection="column" width={contentWidth} flexGrow={1} minWidth={0} overflow="hidden">
      {layout.titleRows > 0 ? (
        <box flexDirection="row" width={title.width} flexShrink={0} minWidth={0}>
          <Cells width={title.titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
            {titleText}
          </Cells>
          {title.metaWidth > 0 ? (
            <>
              <Cells width={title.gap}>{""}</Cells>
              <Cells width={title.metaWidth} align="right" fg={modifiedCount > 0 ? theme.ACCENT : theme.MUTED}>
                {titleMeta}
              </Cells>
            </>
          ) : null}
        </box>
      ) : null}
      <box width={contentWidth} height={layout.bodyRows} flexDirection="column" flexShrink={0} minWidth={0}>
        {layout.listRows >= 2 && contentWidth > 0 ? (
          <DialogSelectBody
            items={items}
            cursor={cursor}
            panel={panel}
            query={filter}
            placeholder="type to search every setting"
            isCurrent={(item) => item.current === true}
            renderDetail={renderDetail}
            emptyText="No matching settings · ctrl+u clears search"
          />
        ) : null}
        {layout.stackedRows > 0 && selectedItem ? (
          <box width={contentWidth} height={layout.stackedRows}
            flexDirection="column" flexShrink={0} minWidth={0}>
            {renderDetail(selectedItem, { width: contentWidth, height: layout.stackedRows })}
          </box>
        ) : null}
      </box>
      {layout.statusRows > 0 ? <Cells width={contentWidth} fg={statusTone}>{statusText}</Cells> : null}
    </box>
  );

  return <>{frame({ body, hint })}</>;
}
