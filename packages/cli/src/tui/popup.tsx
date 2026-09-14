/** @jsxImportSource @opentui/react */
/**
 * The one modal-box primitive every popup projects onto.
 *
 * Before this component the same "dim the screen, raise a `PANEL` box, guard the
 * click-outside" chrome was hand-rolled four times — `DialogSurface`,
 * `DialogSelect`'s panel, `ContextMenu` and `ShutdownDialog` each grew their own
 * copy. `Popup` is that chrome, made once, so a future change to how a popup
 * dims, positions or dismisses is a one-file change.
 *
 * It owns no domain logic and adds no behaviour of its own: every consumer keeps
 * its own keyboard handler, its own geometry inputs and its own `zIndex`. The
 * three `variant`s are exactly the three placements the console already used —
 *
 *   - `modal`     the centred, upper-third box `DialogSurface` raises; it alone
 *                 provides `SurfaceContext` so the screens mounted inside it lay
 *                 out against the box, not the terminal behind it.
 *   - `centered`  a flex-centred box (`ShutdownDialog`), or — when an `anchor`
 *                 is given — a box placed verbatim at that cell without the
 *                 viewport clamp (`DialogSelect`, whose panel geometry is
 *                 computed upstream by `dialog-select-layout`).
 *   - `anchored`  a box pinned at the cursor and clamped into the viewport with
 *                 `clampMenuPosition` (`ContextMenu`), over a transparent
 *                 click-to-dismiss backdrop.
 *
 * The geometry that is worth testing lives in the pure exports below
 * (`modalPanelGeometry`, `anchoredPosition`, `resolveBackdropColor`,
 * `backdropDismissMode`) so a regression in the size bands, the height clamp or
 * the placement is caught without driving a terminal.
 */

import React, { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { RGBA, TextAttributes } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";

import { useTheme } from "./theme-context.js";
import { Cells } from "./primitives.js";
import { clampMenuPosition, type MenuBox, type MenuPosition, type Viewport } from "./use-context-menu.js";

// ---------------------------------------------------------------------------
// SurfaceContext — the layout handle screens read to size themselves against
// their containing popup instead of the terminal.
//
// Defined here (with the popup that provides it) and RE-EXPORTED from
// `dialog-surface.js`, so the 15+ screens that already `import { … } from
// "./dialog-surface.js"` keep working with zero changes: it is the same context
// object whether reached through this module or that one.
// ---------------------------------------------------------------------------

export interface SurfaceDimensions {
  width: number;
  height: number;
}

export const SurfaceContext = createContext<SurfaceDimensions | null>(null);

/** Screen layout uses its containing dialog, not the terminal behind it. */
export function useSurfaceDimensions(): SurfaceDimensions {
  const surface = useContext(SurfaceContext);
  const terminal = useTerminalDimensions();
  return surface ?? terminal;
}

/** True when rendered inside a popup that provides a `SurfaceContext`. */
export function useDialogSurface(): boolean {
  return useContext(SurfaceContext) !== null;
}

// ---------------------------------------------------------------------------
// Pure geometry — unit-tested in popup.test.ts
// ---------------------------------------------------------------------------

export type PopupVariant = "modal" | "centered" | "anchored";
export type PopupSize = "small" | "medium" | "large";
export type PopupBackdrop = "dim" | "transparent" | "none";
export type PopupTone = "default" | "danger";

/** The verbatim scrim colour every dimmed popup has always used. */
export const POPUP_BACKDROP_COLOR = RGBA.fromInts(0, 0, 0, 150);

/** Width bands, verbatim from the old DialogSurface (`dialog-surface.tsx:31`). */
export function popupBandWidth(size: PopupSize): number {
  return size === "small" ? 64 : size === "medium" ? 92 : 120;
}

export interface ModalPanelGeometry {
  /** Outer panel width, borders included. */
  panelWidth: number;
  /** Outer panel height, borders included (clamped to 44). */
  panelHeight: number;
  /** Whether the box is large enough to spend a cell of padding on each side. */
  border: boolean;
  /** Inner content box the panel provides to `SurfaceContext`. */
  inner: SurfaceDimensions;
  /** Left offset centring the panel horizontally in the terminal. */
  left: number;
  /** Top offset anchoring the panel in the upper third. */
  top: number;
}

/**
 * The centred, upper-third modal box — reproduced verbatim from the old
 * `DialogSurface` (`dialog-surface.tsx:31-37,47-48`). The band width clamps to
 * the terminal, the height clamps to 44, and a box wider/taller than 4 cells
 * spends one cell of padding on each side (which is the inner box the surface
 * hands its children).
 */
export function modalPanelGeometry(terminal: SurfaceDimensions, size: PopupSize): ModalPanelGeometry {
  const panelWidth = Math.max(1, Math.min(popupBandWidth(size), terminal.width - (terminal.width > 4 ? 4 : 0)));
  const panelHeight = Math.max(1, Math.min(44, terminal.height - (terminal.height > 10 ? 4 : 0)));
  const border = panelWidth > 4 && panelHeight > 4;
  const inner: SurfaceDimensions = {
    width: Math.max(1, panelWidth - (border ? 2 : 0)),
    height: Math.max(1, panelHeight - (border ? 2 : 0)),
  };
  const left = Math.max(0, Math.floor((terminal.width - panelWidth) / 2));
  const top = Math.max(0, Math.floor((terminal.height - panelHeight) / 3));
  return { panelWidth, panelHeight, border, inner, left, top };
}

/**
 * Place an anchored box (the context menu) at the cursor, clamped into the
 * viewport. A thin, named re-export of `clampMenuPosition` so the anchored popup
 * and its unit tests name the same function.
 */
export function anchoredPosition(anchor: { x: number; y: number }, box: MenuBox, viewport: Viewport): MenuPosition {
  return clampMenuPosition(anchor.x, anchor.y, box, viewport);
}

/** The scrim colour for a backdrop mode; `undefined` for transparent / none. */
export function resolveBackdropColor(backdrop: PopupBackdrop): RGBA | undefined {
  return backdrop === "dim" ? POPUP_BACKDROP_COLOR : undefined;
}

/**
 * How a backdrop press is handled:
 *   - `"none"`             the press does nothing (dismiss disabled).
 *   - `"selection-aware"`  the modal guard: a press dismisses only if it was not
 *     the start/end of a text selection (verbatim from the old DialogSurface).
 *   - `"simple"`           any press dismisses (the context-menu backdrop).
 */
export function backdropDismissMode(
  variant: PopupVariant,
  dismissOnBackdrop: boolean,
): "none" | "selection-aware" | "simple" {
  if (!dismissOnBackdrop) return "none";
  return variant === "modal" ? "selection-aware" : "simple";
}

// ---------------------------------------------------------------------------
// Title / footer — the shared, single-place popup chrome text
// ---------------------------------------------------------------------------

/**
 * The popup title row: a bold title on the left and, optionally, a right-pinned
 * affordance (`esc`) or metadata that can never fuse with the title under
 * pressure. Reproduces `DialogSelect`'s title row verbatim (its old
 * `dialog-select.tsx:538-574`); a click on the affordance runs `onMeta`.
 */
export function PopupTitle({
  title,
  meta,
  width,
  tone = "default",
  onMeta,
}: {
  title: string;
  meta?: string;
  width: number;
  tone?: PopupTone;
  onMeta?: () => void;
}) {
  const theme = useTheme();
  const titleFg = tone === "danger" ? theme.ERROR : theme.PRIMARY;
  if (!meta) {
    return (
      <Cells width={Math.max(1, width)} fg={titleFg} attributes={TextAttributes.BOLD}>
        {title}
      </Cells>
    );
  }
  const titleGap = 1;
  const metaWidth = Math.min(width, meta.length);
  const titleWidth = Math.max(1, width - metaWidth - titleGap);
  return (
    <box flexDirection="row" width={width} flexShrink={0} minWidth={0} gap={titleGap}>
      <Cells width={titleWidth} fg={titleFg} attributes={TextAttributes.BOLD}>
        {title}
      </Cells>
      <Cells width={metaWidth} align="right" fg={theme.MUTED} onMouseDown={onMeta}>
        {meta}
      </Cells>
    </box>
  );
}

/** The popup footer hint — a single muted line, fitted to the inner width. */
export function PopupFooter({ text, width }: { text: string; width: number }) {
  const theme = useTheme();
  return (
    <Cells width={Math.max(1, width)} fg={theme.MUTED}>
      {text}
    </Cells>
  );
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

export interface PopupProps {
  children: ReactNode;
  /** Placement + backdrop family. Default `"modal"`. */
  variant?: PopupVariant;
  /** Width band for `modal` (64 / 92 / 120). Default `"large"`. */
  size?: PopupSize;
  /** Explicit outer width (cells). Required for `centered`/`anchored`. */
  width?: number;
  /** Explicit outer height, or `"auto"` for a content-sized box. */
  height?: number | "auto";
  /** For `anchored` (and explicit `centered`): the cell the box is placed at. */
  anchor?: { x: number; y: number };
  /** Optional title row (left) — see {@link PopupTitle}. */
  title?: string;
  /** Optional right-pinned affordance / metadata beside the title (e.g. `esc`). */
  titleMeta?: string;
  /** Optional footer hint line. */
  footer?: string;
  /** Title tint. Default `"default"`. */
  tone?: PopupTone;
  /** Backdrop press / affordance click. */
  onClose?: () => void;
  /** Whether a backdrop press dismisses. Default `true`. */
  dismissOnBackdrop?: boolean;
  /** Backdrop fill. Default `"dim"` (`modal`/`centered`) or `"transparent"` (`anchored`). */
  backdrop?: PopupBackdrop;
  /**
   * Stacking order. The stack that owns z-ordering is a later wave; for now each
   * consumer passes its current value verbatim. For `anchored`, the backdrop
   * sits at `zIndex` and the box one above it.
   */
  zIndex?: number;
}

export function Popup({
  children,
  variant = "modal",
  size = "large",
  width,
  height = "auto",
  anchor,
  title,
  titleMeta,
  footer,
  tone = "default",
  onClose,
  dismissOnBackdrop = true,
  backdrop,
  zIndex = 100,
}: PopupProps) {
  const theme = useTheme();
  const terminal = useTerminalDimensions();
  const renderer = useRenderer();
  const backdropPress = useRef(false);

  const backdropMode: PopupBackdrop = backdrop ?? (variant === "anchored" ? "transparent" : "dim");
  const backdropColor = resolveBackdropColor(backdropMode);
  const dismissMode = backdropDismissMode(variant, dismissOnBackdrop);

  // ── placement + sizing ────────────────────────────────────────────────
  const modal = variant === "modal" ? modalPanelGeometry(terminal, size) : null;

  // The box's outer width. Modal derives it from the band; every other variant
  // is handed one explicitly.
  const outerWidth = modal ? modal.panelWidth : Math.max(1, width ?? 1);
  // Modal is always the clamped 44-band height; others are auto unless given.
  const outerHeight: number | undefined = modal ? modal.panelHeight : typeof height === "number" ? height : undefined;

  // Inner content width available to the title / footer. Modal reserves a cell
  // of border each side; every other variant uses two cells of horizontal
  // padding each side (the chrome those popups have always drawn).
  const innerWidth = modal ? modal.inner.width : Math.max(1, outerWidth - 4);
  const provideSurface = variant === "modal";

  // `centered` with no anchor is flex-centred by the backdrop (ShutdownDialog);
  // every other placement pins the box with an absolute position.
  const flexCenter = variant === "centered" && !anchor;

  // Absolute box position. Modal centres in the upper third; an anchored box is
  // clamped into the viewport; an explicit anchor on any other variant is placed
  // verbatim (DialogSelect, whose top/left is computed upstream).
  let boxLeft: number | undefined;
  let boxTop: number | undefined;
  if (modal) {
    boxLeft = modal.left;
    boxTop = modal.top;
  } else if (anchor) {
    if (variant === "anchored") {
      const clampHeight = typeof height === "number" ? height : 0;
      const pos = anchoredPosition(anchor, { width: outerWidth, height: clampHeight }, { width: terminal.width, height: terminal.height });
      boxLeft = pos.x;
      boxTop = pos.y;
    } else {
      boxLeft = anchor.x;
      boxTop = anchor.y;
    }
  }

  const paddingX = modal ? (modal.border ? 1 : 0) : 2;
  const paddingY = modal ? (modal.border ? 1 : 0) : 1;

  // ── content ───────────────────────────────────────────────────────────
  // Stable while the inner box is unchanged, so consumers of `SurfaceContext`
  // don't re-render on every parent render (as the old DialogSurface memoized).
  const surfaceValue = useMemo(
    () => (modal ? modal.inner : null),
    [modal?.inner.width, modal?.inner.height],
  );
  const body = provideSurface ? (
    <SurfaceContext.Provider value={surfaceValue}>{children}</SurfaceContext.Provider>
  ) : (
    children
  );

  const content = (
    <>
      {title != null ? (
        <PopupTitle title={title} meta={titleMeta} width={innerWidth} tone={tone} onMeta={onClose} />
      ) : null}
      {body}
      {footer != null ? <PopupFooter text={footer} width={innerWidth} /> : null}
    </>
  );

  // ── panel box ─────────────────────────────────────────────────────────
  // Modal keeps its overflow guard and the two mouse handlers that stop a press
  // inside the box (or a drag that ends inside it) from reaching the backdrop
  // dismiss — verbatim from the old DialogSurface.
  const panel = (
    <box
      position={flexCenter ? undefined : "absolute"}
      left={flexCenter ? undefined : boxLeft}
      top={flexCenter ? undefined : boxTop}
      width={outerWidth}
      height={outerHeight}
      flexShrink={0}
      flexDirection="column"
      overflow={modal ? "hidden" : undefined}
      minWidth={variant === "anchored" ? 0 : undefined}
      paddingX={paddingX}
      paddingY={paddingY}
      backgroundColor={theme.PANEL}
      zIndex={variant === "anchored" && backdropMode !== "none" ? zIndex + 1 : undefined}
      onMouseDown={
        dismissMode === "selection-aware"
          ? (event) => {
              backdropPress.current = false;
              event.stopPropagation();
            }
          : undefined
      }
      onMouseUp={
        dismissMode === "selection-aware"
          ? (event) => {
              backdropPress.current = false;
              event.stopPropagation();
            }
          : undefined
      }
    >
      {content}
    </box>
  );

  if (backdropMode === "none") {
    return panel;
  }

  // ── backdrop ──────────────────────────────────────────────────────────
  // `selection-aware` reproduces the modal guard: a press arms dismiss only when
  // it is not the start of a text selection, and the matching release dismisses
  // only when no selection was made. `simple` dismisses on any press.
  const backdropBox = (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={zIndex}
      backgroundColor={backdropColor}
      alignItems={flexCenter ? "center" : undefined}
      justifyContent={flexCenter ? "center" : undefined}
      onMouseDown={
        dismissMode === "selection-aware"
          ? () => {
              backdropPress.current = !renderer.getSelection()?.getSelectedText();
            }
          : dismissMode === "simple"
            ? (event) => {
                event.stopPropagation?.();
                onClose?.();
              }
            : undefined
      }
      onMouseUp={
        dismissMode === "selection-aware"
          ? () => {
              const dismiss = backdropPress.current && !renderer.getSelection()?.getSelectedText();
              backdropPress.current = false;
              if (dismiss) onClose?.();
            }
          : undefined
      }
    >
      {variant === "anchored" ? null : panel}
    </box>
  );

  // Anchored keeps the backdrop and the box as siblings (the box floats one
  // z-level above the transparent scrim); every other variant nests the box
  // inside its scrim.
  if (variant === "anchored") {
    return (
      <>
        {backdropBox}
        {panel}
      </>
    );
  }
  return backdropBox;
}
