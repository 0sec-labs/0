import type { ReactElement, ReactNode } from "react";
import { Tooltip as KumoTooltip, TooltipProvider } from "@cloudflare/kumo/components/tooltip";

/** Quiet control hints and larger prompt previews share accessible hover/focus behavior. */
export function Tooltip({ children, content, preview = false, side = "top" }: { children: ReactElement; content: ReactNode; preview?: boolean; side?: "top" | "bottom" | "left" | "right" }) {
  return <TooltipProvider><KumoTooltip asChild delay={400} side={side} content={<span className={preview ? "zero-tooltip-preview" : "zero-tooltip-label"}>{content}</span>}>{children}</KumoTooltip></TooltipProvider>;
}
