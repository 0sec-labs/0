import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "../lib/utils.js"

function ScrollArea({ className, children, ...props }: ScrollAreaPrimitive.Root.Props) {
  return (
    <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative", className as string | undefined)} {...props}>
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] scroll-fade-y outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation="vertical" />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({ className, orientation = "vertical", ...props }: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px opacity-0 transition-opacity duration-150 select-none data-[hovering]:opacity-100 data-[scrolling]:opacity-100 motion-reduce:transition-none data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5",
        className as string | undefined
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-muted-foreground/25 hover:bg-muted-foreground/40"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
