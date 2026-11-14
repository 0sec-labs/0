import type { ReactElement, ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

/** Product tooltip behavior with the chat app's content/shortcut compatibility API. */
export function Tooltip({ children, content, preview = false, side = "top", delay = 350, shortcut }: { children: ReactElement; content: ReactNode; shortcut?: ReactNode; preview?: boolean; delay?: number; side?: "top" | "bottom" | "left" | "right" }) {
  return <TooltipPrimitive.Provider delayDuration={delay}>
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content data-slot="tooltip-content" side={side} sideOffset={6} collisionPadding={12}
          className="z-[70] w-fit max-w-[min(22rem,var(--radix-tooltip-content-available-width,22rem))] origin-[var(--radix-tooltip-content-transform-origin)] whitespace-normal rounded-[var(--radius-menu,12px)] border-[length:var(--ui-frame-border-width,1px)] border-border bg-popover px-3 py-2 text-left text-xs leading-5 text-popover-foreground shadow-[var(--ui-panel-shadow,0_8px_24px_rgb(0_0_0_/_16%))] [overflow-wrap:anywhere] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:zoom-out-95 motion-safe:data-[side=bottom]:slide-in-from-top-2 motion-safe:data-[side=left]:slide-in-from-right-2 motion-safe:data-[side=right]:slide-in-from-left-2 motion-safe:data-[side=top]:slide-in-from-bottom-2 motion-safe:duration-200 motion-safe:data-[state=closed]:duration-150">
          <span className={preview ? "zero-tooltip-preview" : "zero-tooltip-label"}>{content}{shortcut && <kbd className="zero-tooltip-shortcut">{shortcut}</kbd>}</span>
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>;
}
