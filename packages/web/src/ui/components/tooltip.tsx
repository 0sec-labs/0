import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

const TOOLTIP_DELAY = 300;
const TOOLTIP_SKIP_WINDOW = 1000;
const ProviderMounted = createContext(false);

/** App-level tooltip provider: 300ms open delay, then neighbours open instantly for a 1s skip window. */
export function TooltipProvider({ children, delay = TOOLTIP_DELAY, closeDelay, timeout = TOOLTIP_SKIP_WINDOW }: { children?: ReactNode; delay?: number; closeDelay?: number; timeout?: number }) {
  return <ProviderMounted.Provider value>
    <TooltipPrimitive.Provider delay={delay} closeDelay={closeDelay} timeout={timeout}>{children}</TooltipPrimitive.Provider>
  </ProviderMounted.Provider>;
}

/** Product tooltip with the chat app's content/shortcut compatibility API. Falls back to an inline provider when none is mounted. */
export function Tooltip({ children, content, preview = false, side = "top", delay, shortcut }: { children: ReactElement; content: ReactNode; shortcut?: ReactNode; preview?: boolean; delay?: number; side?: "top" | "bottom" | "left" | "right" }) {
  const mounted = useContext(ProviderMounted);
  const tooltip = <TooltipPrimitive.Root>
    <TooltipPrimitive.Trigger render={children} delay={delay} />
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={4} collisionPadding={12} className="z-[70]">
        <TooltipPrimitive.Popup data-slot="tooltip-content"
          className="ui-popup w-fit max-w-[min(20rem,var(--available-width,20rem))] origin-(--transform-origin) whitespace-normal rounded-md border-[0.5px] border-border-2 bg-popover px-2 py-1 text-left text-xs font-medium text-popover-foreground shadow-[var(--sh-overlay,0_6px_18px_rgb(0_0_0/.03),0_3px_9px_rgb(0_0_0/.04),0_1px_1px_rgb(0_0_0/.05))] [overflow-wrap:anywhere]">
          <span className={preview ? "leading-[1.7] [overflow-wrap:anywhere]" : "flex items-center gap-1.5"}>{content}{shortcut && <kbd className="inline-flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-[3px] bg-secondary px-1 font-sans text-xs text-muted-foreground-1">{shortcut}</kbd>}</span>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
  return mounted ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>;
}
