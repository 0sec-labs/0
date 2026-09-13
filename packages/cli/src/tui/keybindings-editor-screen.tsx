/** @jsxImportSource @opentui/react */
/**
 * The console's keybinding editor (`/keybindings`), as a pop-up dialog — the
 * WRITE side of `/shortcuts`.
 *
 * `/shortcuts` is a read-only cheat-sheet; this screen is the same registry made
 * editable for the rebindable set (today the three View toggles). It captures a
 * chord for the highlighted rebindable row, validates it against the shared
 * conflict rules, and persists it via the settings store — so a rebind survives
 * the session and every consumer (the chat handlers, the reference view)
 * repaints immediately.
 *
 * Three properties are load-bearing, inherited from `shortcuts-screen.tsx`:
 *
 * 1. **Nothing is invented.** Every row is a `keybindings.ts` binding, and every
 *    chord shown is the EFFECTIVE one (override ?? default). The protected set
 *    is shown too, marked locked, so the operator sees why it cannot be touched.
 *
 * 2. **The chord model, resolver and conflict rules live in `keybindings.ts`.**
 *    This screen owns capture and rendering only: it calls
 *    `assessChordAssignment` and never re-implements the parsing or the
 *    reserved-chord policy.
 *
 * 3. **It does its own arithmetic off the shared shortcuts layout**, so the body
 *    cannot overflow the box the host reserved (Yoga shrinks siblings rather
 *    than clipping — see PRIMITIVES.md).
 */

import React, { useRef, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { useTheme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { Cells } from "./primitives.js";
import { paneTitleColumns } from "./pane-layout.js";
import { useSettings, updateSetting } from "./settings-store.js";
import { assessChordAssignment, type KeyLike } from "./keybindings.js";
import {
  buildKeybindingEditorRows,
  computeShortcutsLayout,
  keybindingsEditorFooterHint,
  rebindableRowIndices,
  type KeybindingEditorRow,
} from "./keybindings-layout.js";

export interface KeybindingsEditorFrameInput {
  body: React.ReactNode;
  hint: string;
}

export interface KeybindingsEditorScreenProps {
  /** Wraps the body in the console shell (injected, like `ShortcutsScreen`). */
  frame: (input: KeybindingsEditorFrameInput) => React.ReactNode;
  /** Leave the screen — Esc. */
  onBack: () => void;
  /** Leave the console entirely — Ctrl+C. */
  onExit: () => void;
}

/** The dialog's own icon+title row, budgeted out of the body. */
const HEADER_ROWS = 1;

type MessageTone = "error" | "notice";

export function KeybindingsEditorScreen({ frame, onBack, onExit }: KeybindingsEditorScreenProps) {
  const theme = useTheme();
  const symbols = useSymbols();
  const { width, height } = useSurfaceDimensions();
  const inDialog = useDialogSurface();
  const overrides = useSettings().keybindings;

  const rows = buildKeybindingEditorRows(overrides);
  const editable = rebindableRowIndices(rows);

  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const [capturing, setCapturing] = useState(false);
  const capturingRef = useRef(false);
  const [message, setMessage] = useState<{ text: string; tone: MessageTone } | null>(null);

  const clampSelected = (next: number): number => {
    if (editable.length === 0) return 0;
    return Math.max(0, Math.min(editable.length - 1, next));
  };
  const move = (delta: number) => {
    const next = clampSelected(selectedRef.current + delta);
    selectedRef.current = next;
    setSelected(next);
    setMessage(null);
  };
  const activeRowIndex = editable.length > 0 ? editable[clampSelected(selected)] : -1;
  const activeId = activeRowIndex >= 0 ? rows[activeRowIndex]?.id : undefined;

  const setCapture = (value: boolean) => {
    capturingRef.current = value;
    setCapturing(value);
  };

  const capture = (key: KeyLike) => {
    const id = activeId;
    if (!id) {
      setCapture(false);
      return;
    }
    const assessment = assessChordAssignment(id, key, overrides);
    if (!assessment) return; // a nameless key (bare modifier) — keep waiting.
    if (assessment.kind === "unassignable") {
      setMessage({ text: "A chord must include Ctrl, Alt or Meta so it never steals typing.", tone: "error" });
      setCapture(false);
      return;
    }
    if (assessment.kind === "conflict") {
      setMessage({ text: `That chord is already bound to "${assessment.conflictLabel}".`, tone: "error" });
      setCapture(false);
      return;
    }
    updateSetting("keybindings", { ...overrides, [id]: assessment.chord });
    setMessage({ text: "Rebound.", tone: "notice" });
    setCapture(false);
  };

  const reset = () => {
    const id = activeId;
    if (!id || typeof overrides[id] !== "string") return;
    const rest = { ...overrides };
    delete rest[id];
    updateSetting("keybindings", rest);
    setMessage({ text: "Reset to default.", tone: "notice" });
  };

  useKeyboard((key) => {
    // Ctrl+C always exits, even mid-capture — a terminal-owning TUI must never
    // let the operator bind away their only quit key.
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    if (capturingRef.current) {
      if (key.name === "escape") {
        setCapture(false);
        setMessage(null);
        return;
      }
      capture(key);
      return;
    }
    if (key.name === "escape") {
      onBack();
      return;
    }
    if (key.name === "up") return move(-1);
    if (key.name === "down") return move(1);
    if (key.name === "return") {
      if (activeId) setCapture(true);
      return;
    }
    if (!key.ctrl && !key.meta && !key.option && (key.name === "r" || key.sequence === "r")) {
      reset();
      return;
    }
  });

  const shell = computeShortcutsLayout({
    width,
    height,
    ...(inDialog ? { hostRows: 1, hostPaddingX: 0 } : {}),
  });
  const bodyRows = Math.max(1, shell.pane.bodyRows - HEADER_ROWS);
  const innerWidth = shell.pane.innerWidth;
  // Size the chord column to the widest EFFECTIVE chord label plus the marker.
  const widestChord = rows.reduce((max, row) => Math.max(max, (row.chord ?? "").length + 2), 6);
  const keysWidth = Math.min(widestChord, Math.max(6, Math.floor(innerWidth / 3)));
  const gap = innerWidth > keysWidth + 4 ? 1 : 0;
  const descriptionWidth = Math.max(0, innerWidth - keysWidth - gap);

  // Window the rows so the highlighted row stays visible.
  const visible = Math.max(1, bodyRows);
  let start = 0;
  if (activeRowIndex >= 0 && rows.length > visible) {
    start = Math.max(0, Math.min(activeRowIndex - Math.floor(visible / 2), rows.length - visible));
  }
  const shown = rows.slice(start, start + visible);

  const title = `${operatorIcon("keybindings", symbols)} ${operatorTitle("keybindings")}`;
  const meta = `${editable.length} editable`;
  const titleCols = paneTitleColumns(innerWidth, meta.length);

  const renderRow = (row: KeybindingEditorRow, rowIndex: number) => {
    if (row.kind === "heading") {
      return (
        <Cells key={`h-${rowIndex}`} width={innerWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
          {row.label ?? ""}
        </Cells>
      );
    }
    const isActive = rowIndex === activeRowIndex;
    const locked = !row.rebindable;
    const marker = locked ? "·" : row.overridden ? "*" : isActive ? "›" : " ";
    const chordFg = locked ? theme.MUTED : row.overridden ? theme.ACCENT : theme.TEXT;
    const descFg = isActive ? theme.PRIMARY : locked ? theme.MUTED : theme.TEXT;
    return (
      <box key={`b-${rowIndex}`} flexDirection="row" width={innerWidth} flexShrink={0} minWidth={0}>
        <Cells width={keysWidth} fg={chordFg} attributes={isActive ? TextAttributes.BOLD : undefined}>
          {`${marker} ${row.chord ?? ""}`}
        </Cells>
        {gap > 0 ? <Cells width={gap}>{""}</Cells> : null}
        <Cells width={descriptionWidth} fg={descFg} attributes={isActive ? TextAttributes.BOLD : undefined}>
          {isActive && capturing ? "press a chord…" : row.description ?? ""}
        </Cells>
      </box>
    );
  };

  const messageFg = message?.tone === "error" ? theme.ERROR : theme.ACCENT;

  const body = (
    <box flexDirection="column" width="100%" flexGrow={1} minWidth={0}>
      <box flexDirection="row" width={innerWidth} flexShrink={0} minWidth={0}>
        <Cells width={titleCols.titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
          {title}
        </Cells>
        <Cells width={titleCols.gap}>{""}</Cells>
        <Cells width={titleCols.metaWidth} align="right" fg={theme.MUTED}>
          {meta}
        </Cells>
      </box>
      {shown.map((row, index) => renderRow(row, start + index))}
      {message ? (
        <Cells width={innerWidth} fg={messageFg}>
          {message.text}
        </Cells>
      ) : null}
    </box>
  );

  return <>{frame({ body, hint: keybindingsEditorFooterHint(capturing) })}</>;
}
