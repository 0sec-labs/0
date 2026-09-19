/** @jsxImportSource @opentui/react */
import React from "react";

import { Popup } from "./popup.js";

// Back-compat surface: the layout context and its hooks now live with the popup
// primitive that provides them, and are re-exported here UNCHANGED so the 15+
// screens that `import { useSurfaceDimensions, useDialogSurface } from
// "./dialog-surface.js"` keep working with zero changes. It is the same context
// object either way, so `useDialogSurface()` still reports true inside a
// `DialogSurface` exactly as before.
export { SurfaceContext, useSurfaceDimensions, useDialogSurface } from "./popup.js";
export type { SurfaceDimensions } from "./popup.js";

/**
 * Presentation only: the existing route stack owns navigation and cancellation.
 *
 * Now a thin wrapper over the shared {@link Popup} `modal` variant — the centred,
 * upper-third box, its `SurfaceContext`, its dim scrim and its selection-aware
 * click-outside dismiss are all provided there. Geometry and behaviour are
 * unchanged.
 */
export function DialogSurface({ children, onDismiss, size = "large" }: {
  children: React.ReactNode;
  onDismiss?: () => void;
  size?: "small" | "medium" | "large";
}) {
  return (
    <Popup variant="modal" size={size} zIndex={100} onClose={onDismiss}>
      {children}
    </Popup>
  );
}
