/** @jsxImportSource @opentui/react */
import React from "react";

import { Popup } from "./popup.js";

// Screens and explicit windows consume the same layout context as Popup.
export { SurfaceContext, useSurfaceDimensions, useDialogSurface } from "./popup.js";
export type { SurfaceDimensions } from "./popup.js";

/**
 * Presentation only: the existing route stack owns navigation and cancellation.
 *
 * Popup owns the bounded central placement, compact window chrome and
 * selection-aware backdrop. Only a supplied dismissal callback enables the
 * top Back/Done controls; this wrapper never invents a screen action.
 */
export function DialogSurface({ children, onDismiss, size = "large" }: {
  children: React.ReactNode;
  onDismiss?: () => void;
  size?: "small" | "medium" | "large" | "xlarge";
}) {
  return (
    <Popup variant="modal" size={size} zIndex={100} onClose={onDismiss}>
      {children}
    </Popup>
  );
}
