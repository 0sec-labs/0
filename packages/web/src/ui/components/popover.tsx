import type { ComponentProps, ReactNode } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "../lib/utils.js";
import { triggerRender } from "../lib/trigger.js";

/** Product popover on Base UI Popover. */
function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root {...props} />;
}

function PopoverTrigger({ children, ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...triggerRender(props.render, children)} {...props} />;
}

type PopoverContentProps = {
  children?: ReactNode;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number;
  positionMethod?: "absolute" | "fixed";
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  container?: ComponentProps<typeof PopoverPrimitive.Portal>["container"];
};
function PopoverContent({ children, className, container, side = "bottom", align = "center", sideOffset = 8, ...positioner }: PopoverContentProps) {
  return <PopoverPrimitive.Portal container={container}>
    <PopoverPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} className="z-[60]" {...positioner}>
      <PopoverPrimitive.Popup data-slot="popover-content" className={cn("ui-popup flex origin-(--transform-origin) flex-col overflow-y-auto overscroll-contain scroll-fade-y rounded-[var(--radius-overlay,8px)] border-[0.5px] border-border-2 bg-popover text-popover-foreground shadow-[var(--sh-overlay,0_6px_18px_rgb(0_0_0/.03),0_3px_9px_rgb(0_0_0/.04),0_1px_1px_rgb(0_0_0/.05))] px-4 py-3 text-sm outline-none max-h-[min(28rem,calc(100dvh-2rem))]", className)}>
        {children}
      </PopoverPrimitive.Popup>
    </PopoverPrimitive.Positioner>
  </PopoverPrimitive.Portal>;
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return <PopoverPrimitive.Title {...props} className={cn("m-0 text-sm font-medium", className as string | undefined)} />;
}
function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return <PopoverPrimitive.Description {...props} className={cn("m-0 text-sm text-muted-foreground", className as string | undefined)} />;
}
function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

Popover.Trigger = PopoverTrigger;
Popover.Content = PopoverContent;
Popover.Title = PopoverTitle;
Popover.Description = PopoverDescription;
Popover.Close = PopoverClose;

export { Popover };
