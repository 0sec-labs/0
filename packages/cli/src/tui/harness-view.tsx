/** @jsxImportSource @opentui/react */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { sleekScrollbar } from "./scrollbar.js";
import { useKeyboard, usePaste } from "@opentui/react";
import { decodePasteBytes } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { HarnessSetting, HarnessView, HarnessViewBlock } from "@0sec/shared";
import { useHarness } from "./harness-context.js";
import { useTheme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { Cells } from "./primitives.js";
import { paneTitleColumns } from "./pane-layout.js";
import { DialogSelectBody } from "./dialog-select.js";
import type { DialogItem } from "./dialog-select.js";
import { computeDialogPanel } from "./dialog-select-layout.js";
import { deletePreviousCharacter, deletePreviousWord } from "./composer-edit.js";
import { sanitizeComposerText, sanitizeTuiText } from "./text.js";
import { isFilterKey } from "./model-layout.js";
import { renderMarkdown } from "./markdown.js";
import { renderMarkdownBlocks } from "./chat/markdown-blocks.js";

type Row = DialogItem & { providerId: string } & (
  | { kind: "view"; view: HarnessView }
  | { kind: "action"; prompt: string }
  | { kind: "command"; commandId: string; description?: string }
  | { kind: "setting"; setting: HarnessSetting }
);

function ViewBlocks({ blocks, width }: { blocks: HarnessViewBlock[]; width: number }) {
  const theme = useTheme();
  return <>{blocks.map((block, index) => {
    if (block.type === "markdown") return <React.Fragment key={index}>{renderMarkdownBlocks(renderMarkdown(block.text, width), `harness-${index}`, theme)}</React.Fragment>;
    if (block.type === "text") {
      const color = block.tone === "error" ? theme.ERROR : block.tone === "warning" ? theme.WARNING
        : block.tone === "success" ? theme.SUCCESS : block.tone === "muted" ? theme.MUTED : theme.TEXT;
      return <text key={index} fg={color} wrapMode="word">{sanitizeTuiText(block.text)}</text>;
    }
    if (block.type === "progress") return <text key={index} fg={theme.TEXT} wrapMode="word">{`${block.label}: ${block.value} / ${block.max}`}</text>;
    if (block.type === "action") return <text key={index} fg={theme.MUTED} wrapMode="word">{`${block.label} — select its action in the picker to stage a draft`}</text>;
    // Stack cells on narrow terminals rather than truncating data or overflowing.
    return <box key={index} flexDirection="column" width="100%">
      {block.rows.map((row, rowIndex) => <box key={rowIndex} flexDirection="column" marginBottom={1}>
        {block.columns.map((column, columnIndex) => <text key={columnIndex} fg={theme.TEXT} wrapMode="word">{`${column}: ${row[columnIndex] ?? ""}`}</text>)}
      </box>)}
    </box>;
  })}</>;
}

/**
 * One contextual picker over the host catalog; it never executes contributed
 * source.
 *
 * Presented as a dialog body: an icon+title row, the shared grouped/searchable
 * `DialogSelectBody` (grouped by contributing provider), a detail column for
 * the highlighted contribution when the surface is wide enough, and a footer
 * of action hints. Every width comes off the surface the host gave it — the
 * supplied `contentWidth` is clamped to the surface so a panel sized against
 * the terminal can never paint through a narrower dialog panel.
 */
export function HarnessViewPanel({ contentWidth, onBack }: { contentWidth: number; onBack: () => void }) {
  const harness = useHarness();
  const theme = useTheme();
  const symbols = useSymbols();
  const surface = useSurfaceDimensions();
  const inDialog = useDialogSurface();
  const height = surface.height;
  const innerWidth = Math.max(1, Math.min(Math.trunc(contentWidth) || 1, surface.width));
  const generationId = harness.snapshot?.generationId;
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [edit, setEditState] = useState<{ row: Row & { kind: "setting" }; value: string } | null>(null);
  const editRef = useRef(edit);
  const setEdit = (next: typeof edit) => { editRef.current = next; setEditState(next); };
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => { setEdit(null); setDocumentId(null); setCursor(0); }, [generationId]);
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    for (const { providerId, view } of harness.snapshot?.views ?? []) {
      result.push({ id: `view:${providerId}`, label: view.title || providerId, category: providerId, providerId, kind: "view", view, meta: "view" });
      view.blocks.forEach((block, index) => {
        if (block.type === "action") result.push({ id: `action:${providerId}:${index}`, label: block.label, category: providerId, providerId, kind: "action", prompt: block.prompt, meta: "stage draft" });
      });
    }
    for (const command of harness.snapshot?.commands ?? []) result.push({ id: `command:${command.providerId}:${command.id}`, label: command.label, category: command.providerId, providerId: command.providerId, kind: "command", commandId: command.id, description: command.description, meta: "command" });
    for (const setting of harness.snapshot?.settings ?? []) result.push({ id: `setting:${setting.providerId}:${setting.id}`, label: setting.label, category: setting.providerId, providerId: setting.providerId, kind: "setting", setting, meta: String(setting.value) });
    const order = new Map(harness.snapshot?.providers.map((provider, index) => [provider.id, index]));
    result.sort((left, right) => (order.get(left.providerId) ?? 0) - (order.get(right.providerId) ?? 0));
    return result;
  }, [harness.snapshot]);
  const items = useMemo(() => rows.filter(row => `${row.label} ${row.providerId}`.toLowerCase().includes(query.toLowerCase())), [rows, query]);
  const selected = items[Math.max(0, Math.min(cursor, items.length - 1))];
  const document = rows.find(row => row.id === documentId && row.kind === "view");
  const changeSetting = (row: Row & { kind: "setting" }, value: string | boolean) => {
    if (generationId) void harness.interact(generationId, row.providerId, { kind: "setting", id: row.setting.id, value });
  };
  const activate = () => {
    if (!selected || !generationId) return;
    if (selected.kind === "view") setDocumentId(selected.id);
    else if (selected.kind === "action") harness.stagePrompt(selected.prompt);
    else if (selected.kind === "command") void harness.interact(generationId, selected.providerId, { kind: "command", id: selected.commandId });
    else if (selected.setting.type === "text") setEdit({ row: selected, value: String(selected.setting.value) });
    else if (selected.setting.type === "boolean") changeSetting(selected, !selected.setting.value);
    else {
      const options = selected.setting.options ?? [];
      const next = options[(options.findIndex(option => option.value === selected.setting.value) + 1) % options.length];
      if (next) changeSetting(selected, next.value);
    }
  };
  usePaste(event => {
    const text = sanitizeComposerText(decodePasteBytes(event.bytes));
    if (editRef.current) setEdit({ ...editRef.current, value: editRef.current.value + text });
    else if (!documentId) { setQuery(previous => previous + text); setCursor(0); }
  });
  useKeyboard(key => {
    const currentEdit = editRef.current;
    const sequence = key.sequence ?? "";
    if (currentEdit) {
      if (key.name === "escape") setEdit(null);
      else if (key.name === "return" || key.name === "enter") { changeSetting(currentEdit.row, currentEdit.value); setEdit(null); }
      else if (key.name === "backspace") setEdit({ ...currentEdit, value: deletePreviousCharacter(currentEdit.value) });
      else if (key.ctrl && key.name === "u") setEdit({ ...currentEdit, value: "" });
      else if (key.ctrl && key.name === "w") setEdit({ ...currentEdit, value: deletePreviousWord(currentEdit.value) });
      else if (!key.ctrl && !key.meta && isFilterKey(sequence)) setEdit({ ...currentEdit, value: currentEdit.value + sanitizeComposerText(sequence) });
      return;
    }
    if (documentId) {
      if (key.name === "escape") setDocumentId(null);
      else if (key.name === "up") scroll.current?.scrollBy(-1);
      else if (key.name === "down") scroll.current?.scrollBy(1);
      else if (key.name === "pageup") scroll.current?.scrollBy(-Math.max(1, height - 8));
      else if (key.name === "pagedown") scroll.current?.scrollBy(Math.max(1, height - 8));
      return;
    }
    if (key.name === "escape") { if (query) { setQuery(""); setCursor(0); } else onBack(); }
    else if (key.name === "up") setCursor(previous => Math.max(0, previous - 1));
    else if (key.name === "down") setCursor(previous => Math.min(items.length - 1, previous + 1));
    else if (key.name === "return" || key.name === "enter") activate();
    else if (key.name === "backspace") { setQuery(previous => deletePreviousCharacter(previous)); setCursor(0); }
    else if (key.ctrl && key.name === "u") { setQuery(""); setCursor(0); }
    else if (!key.ctrl && !key.meta && isFilterKey(sequence)) { setQuery(previous => previous + sanitizeComposerText(sequence)); setCursor(0); }
  });
  const totalRows = items.reduce((count, item, index) => count + 1 + (index === 0 || items[index - 1]?.category !== item.category ? 1 : 0), 0);
  // Rows this panel spends on itself: its title row, its footer hint, and the
  // error line when the harness has one. Inside a dialog that is the whole
  // cost — the host reserves NOTHING for this screen (`ShellFrame` renders
  // with `dialogContent`: no outer header, no padding, and the surface is the
  // panel interior). Outside a dialog the legacy shell header and padding
  // still apply, so their rows come off as they always did.
  const OWN_ROWS = 2 + (harness.error ? 1 : 0);
  const LEGACY_SHELL_ROWS = 9;
  const bodyRows = Math.max(1, height - OWN_ROWS - (inDialog ? 0 : LEGACY_SHELL_ROWS));
  const panel = computeDialogPanel({ width: innerWidth, height, size: "large", totalRows, withDetail: true, bodyRows });
  // Title row: glyph + label on the left, an honest count of what the live
  // harness actually contributes on the right. Never a fabricated provider.
  const title = `${operatorIcon("commands", symbols)} ${operatorTitle("commands")}`;
  const meta = items.length === rows.length
    ? `${rows.length} contribution${rows.length === 1 ? "" : "s"}`
    : `${items.length}/${rows.length}`;
  const titleCols = paneTitleColumns(innerWidth, meta.length);
  return <box flexDirection="column" width="100%" flexGrow={1} minHeight={0}>
    <box flexDirection="row" width={innerWidth} flexShrink={0} minWidth={0}>
      <Cells width={titleCols.titleWidth} fg={theme.PRIMARY}>{title}</Cells>
      <Cells width={titleCols.gap}>{""}</Cells>
      <Cells width={titleCols.metaWidth} align="right" fg={theme.MUTED}>{meta}</Cells>
    </box>
    {harness.error ? <text fg={theme.ERROR} wrapMode="word">{harness.error}</text> : null}
    {edit ? <>
      <text fg={theme.TEXT} wrapMode="word">{edit.row.label}</text>
      <text fg={theme.ACCENT} wrapMode="word">{edit.value || " "}</text>
      <text fg={theme.MUTED}>Enter save · Esc cancel · Ctrl+U clear</text>
    </> : document?.kind === "view" ? <>
      <text fg={theme.PRIMARY} wrapMode="word">{document.label}</text>
      {/* The scrollbar occupies the last column, so the blocks below are
          budgeted one cell narrower. Without that, word-wrapped block text runs
          under the bar — invisible while the bar was unthemed, plainly wrong
          now that it is painted. */}
      <scrollbox
        ref={scroll}
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={sleekScrollbar(theme)}
      ><ViewBlocks blocks={document.view.blocks} width={Math.max(1, innerWidth - 1)} /></scrollbox>
      <text fg={theme.MUTED}>[↑↓] scroll · [esc] picker</text>
    </> : <>
      <DialogSelectBody items={items} cursor={Math.max(0, Math.min(cursor, items.length - 1))} panel={panel}
        query={query} placeholder="Find a view, command or setting" gutter emptyText="No contributions match this chat. Esc returns to controls."
        renderDetail={(item) => {
          const row = rows.find(candidate => candidate.id === item.id);
          const detail = row?.kind === "action" ? `Stages for review, never sends:\n${row.prompt}`
            : row?.kind === "command" ? row.description ?? "Run this contributed command. Returned prompts stage for review."
            : row?.kind === "setting" ? `${row.setting.description ?? row.label}\nCurrent: ${String(row.setting.value)}`
            : "Enter opens this view. Escape returns without changing the conversation.";
          return <text fg={theme.TEXT} wrapMode="word">{detail}</text>;
        }} />
      <text fg={theme.MUTED} wrapMode="word">[↑↓] choose · [⏎] open/change · type to find · [esc] back</text>
    </>}
  </box>;
}
