/** @jsxImportSource @opentui/react */
import React, { createContext, useContext, useMemo, useRef } from "react";
import { RGBA } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useTheme } from "./theme-context.js";

interface SurfaceDimensions { width: number; height: number }
const SurfaceContext = createContext<SurfaceDimensions | null>(null);

/** Screen layout uses its containing dialog, not the terminal behind it. */
export function useSurfaceDimensions(): SurfaceDimensions {
  const surface = useContext(SurfaceContext);
  const terminal = useTerminalDimensions();
  return surface ?? terminal;
}

export function useDialogSurface(): boolean {
  return useContext(SurfaceContext) !== null;
}

/** Presentation only: the existing route stack owns navigation and cancellation. */
export function DialogSurface({ children, onDismiss, size = "large" }: {
  children: React.ReactNode;
  onDismiss?: () => void;
  size?: "small" | "medium" | "large";
}) {
  const terminal = useTerminalDimensions();
  const theme = useTheme();
  const renderer = useRenderer();
  const backdropPress = useRef(false);
  const panelWidth = Math.max(1, Math.min(size === "small" ? 64 : size === "medium" ? 92 : 120, terminal.width - (terminal.width > 4 ? 4 : 0)));
  const panelHeight = Math.max(1, Math.min(44, terminal.height - (terminal.height > 10 ? 4 : 0)));
  const border = panelWidth > 4 && panelHeight > 4;
  const dimensions = useMemo(() => ({
    width: Math.max(1, panelWidth - (border ? 2 : 0)),
    height: Math.max(1, panelHeight - (border ? 2 : 0)),
  }), [panelWidth, panelHeight, border]);
  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={100}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      onMouseDown={() => { backdropPress.current = !renderer.getSelection()?.getSelectedText(); }}
      onMouseUp={() => {
        const dismiss = backdropPress.current && !renderer.getSelection()?.getSelectedText();
        backdropPress.current = false;
        if (dismiss) onDismiss?.();
      }}>
      <box position="absolute" left={Math.max(0, Math.floor((terminal.width - panelWidth) / 2))}
        top={Math.max(0, Math.floor((terminal.height - panelHeight) / 3))}
        width={panelWidth} height={panelHeight} flexDirection="column" overflow="hidden"
        paddingX={border ? 1 : 0} paddingY={border ? 1 : 0} backgroundColor={theme.PANEL}
        onMouseDown={(event) => { backdropPress.current = false; event.stopPropagation(); }}
        onMouseUp={(event) => { backdropPress.current = false; event.stopPropagation(); }}>
        <SurfaceContext.Provider value={dimensions}>{children}</SurfaceContext.Provider>
      </box>
    </box>
  );
}
