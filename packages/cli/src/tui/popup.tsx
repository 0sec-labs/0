/** @jsxImportSource @opentui/react */
/**
 * Shared window chrome, placement and backdrop handling.
 *
 * `modal` provides a bounded, centered content surface and real close controls.
 * Explicit `centered` windows own their content chrome; `anchored` menus retain
 * cursor placement and their transparent click-to-dismiss backdrop.
 */

import React, { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { RGBA, TextAttributes } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";

import { useTheme } from "./theme-context.js";
import { Cells } from "./primitives.js";
import { fitLegend } from "./text.js";
import { DialogActionButton } from "./dialog-screen-chrome.js";
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

/** Compact width bands shared by generic dialog windows. */
export function popupBandWidth(size: PopupSize): number {
  return size === "small" ? 56 : size === "medium" ? 72 : 88;
}

export interface ModalPanelGeometry {
  /** Outer panel width, padding included. */
  panelWidth: number;
  /** Outer panel height, bounded by the size band and viewport. */
  panelHeight: number;
  paddingX: number;
  paddingY: number;
  /** The single close control, when a content row remains available. */
  closeRows: number;
  /** Child content box, excluding padding and the close control. */
  inner: SurfaceDimensions;
  /** Left offset centring the panel horizontally in the terminal. */
  left: number;
  /** Top offset centring the panel vertically in the terminal. */
  top: number;
}

/** Keep the window and a usable child surface inside even a tiny viewport. */
export function modalPanelGeometry(
  terminal: SurfaceDimensions,
  size: PopupSize,
  dismissible = false,
): ModalPanelGeometry {
  const panelWidth = Math.max(1, Math.min(popupBandWidth(size), terminal.width - (terminal.width > 4 ? 4 : 0)));
  const heightBand = size === "small" ? 20 : size === "medium" ? 24 : 28;
  const panelHeight = Math.max(1, Math.min(heightBand, terminal.height - (terminal.height > 10 ? 4 : 0)));
  const padded = panelWidth > 8 && panelHeight > 6;
  const paddingX = padded ? 2 : 0;
  const paddingY = padded ? 1 : 0;
  const innerWidth = Math.max(1, panelWidth - paddingX * 2);
  const innerHeight = Math.max(1, panelHeight - paddingY * 2);
  // Never spend the last content row on chrome; keyboard/backdrop cancellation
  // remains available in a one-row viewport.
  const closeRows = dismissible && innerHeight >= 2 ? 1 : 0;
  const inner: SurfaceDimensions = {
    width: innerWidth,
    height: innerHeight - closeRows,
  };
  const left = Math.max(0, Math.floor((terminal.width - panelWidth) / 2));
  const top = Math.max(0, Math.floor((terminal.height - panelHeight) / 2));
  return { panelWidth, panelHeight, paddingX, paddingY, closeRows, inner, left, top };
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
  // A fixed footer legend must fit whole — drop trailing " · " units rather
  // than clip a word — before Cells pads it to the inner width.
  return (
    <Cells width={Math.max(1, width)} fg={theme.MUTED}>
      {fitLegend(Math.max(1, width), text)}
    </Cells>
  );
}

/** Generic modal windows expose one close control, pinned upper-right. */
function PopupClose({ width, onClose }: { width: number; onClose: () => void }) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  return (
    <box width={width} height={1} flexShrink={0} flexDirection="row" justifyContent="flex-end">
      {width >= 3 ? (
        <DialogActionButton label={width >= 7 ? "Close" : "×"} onPress={onClose} />
      ) : (
        <box width={width} height={1} flexShrink={0}
          backgroundColor={hovered ? theme.BORDER : theme.PANEL_ALT}
          onMouseOver={() => setHovered(true)} onMouseOut={() => setHovered(false)}
          onMouseUp={(event) => {
            event.stopPropagation();
            if (event.button === 0) onClose();
          }}>
          <Cells width={width} align="right" fg={theme.TEXT}>{"×"}</Cells>
        </box>
      )}
    </box>
  );
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

export interface PopupProps {
  children: ReactNode;
  /** Placement + backdrop family. Default `"modal"`. */
  variant?: PopupVariant;
  /** Compact width/height band for `modal`. Default `"large"`. */
  size?: PopupSize;
  /** Explicit outer width (cells). Required for `centered`/`anchored`. */
  width?: number;
  /** Explicit outer height, or `"auto"` for a content-sized box. */
  height?: number | "auto";
  /** Explicit-window padding; modal padding adapts to its viewport. */
  paddingX?: number;
  paddingY?: number;
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
  paddingX: explicitPaddingX = 2,
  paddingY: explicitPaddingY = 1,
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
  const modal = variant === "modal" ? modalPanelGeometry(terminal, size, onClose != null) : null;

  // The box's outer width. Modal derives it from the band; every other variant
  // is handed one explicitly.
  const outerWidth = modal ? modal.panelWidth : Math.max(1, width ?? 1);
  // Modal is bounded by its size band; others are auto unless given.
  const outerHeight: number | undefined = modal ? modal.panelHeight : typeof height === "number" ? height : undefined;

  // Explicit windows own their padding and child geometry.
  const innerWidth = modal ? modal.inner.width : Math.max(1, outerWidth - explicitPaddingX * 2);
  const provideSurface = variant === "modal";

  // `centered` with no anchor is flex-centred by the backdrop (ShutdownDialog);
  // every other placement pins the box with an absolute position.
  const flexCenter = variant === "centered" && !anchor;

  // Modal is centered; anchored menus are clamped into the viewport. Explicit
  // centered anchors are placed verbatim using their caller's geometry.
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

  const paddingX = modal ? modal.paddingX : explicitPaddingX;
  const paddingY = modal ? modal.paddingY : explicitPaddingY;

  // ── content ───────────────────────────────────────────────────────────
  // Chrome consumes rows outside the child surface. Reserve a content row on
  // tiny terminals rather than letting optional title/footer push it outside.
  const showTitle = title != null && (!modal || modal.inner.height > 1);
  const showFooter = footer != null && (!modal || modal.inner.height - (showTitle ? 1 : 0) > 1);
  const bodyHeight = modal ? modal.inner.height - (showTitle ? 1 : 0) - (showFooter ? 1 : 0) : 0;
  const surfaceValue = useMemo(
    () => (modal ? { width: modal.inner.width, height: bodyHeight } : null),
    [modal?.inner.width, bodyHeight],
  );
  const body = provideSurface ? (
    <box width={innerWidth} height={bodyHeight} flexShrink={0} flexDirection="column" minWidth={0} minHeight={0} overflow="hidden">
      <SurfaceContext.Provider value={surfaceValue}>{children}</SurfaceContext.Provider>
    </box>
  ) : (
    children
  );

  const content = (
    <>
      {modal && modal.closeRows > 0 && onClose ? <PopupClose width={innerWidth} onClose={onClose} /> : null}
      {showTitle && title != null ? (
        <PopupTitle title={title} meta={titleMeta} width={innerWidth} tone={tone} onMeta={modal ? undefined : onClose} />
      ) : null}
      {body}
      {showFooter && footer != null ? <PopupFooter text={footer} width={innerWidth} /> : null}
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
