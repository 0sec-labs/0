import type { ReactNode } from "react";

/**
 * @deprecated The old "Chat information" popover is gone: context usage lives in the
 * composer's ContextPopover and the rest in the Chat details dock panel. Renders
 * nothing; remove together with the `detailsControl` prop in console-page.tsx.
 */
export function ChatDetailsPopover(_props: { open: boolean; onOpenChange: (open: boolean) => void; contextPercent?: number; children?: ReactNode }) {
  return null;
}
