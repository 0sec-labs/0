import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { X } from "lucide-react"

import { cn } from "../lib/utils.js"
import { asChildToRender } from "../lib/render.js"
import { Button } from "./button.js"

function Sheet({ onOpenChange, ...props }: Omit<SheetPrimitive.Root.Props, "onOpenChange"> & { onOpenChange?: (open: boolean) => void }) {
  return <SheetPrimitive.Root data-slot="sheet" onOpenChange={open => onOpenChange?.(open)} {...props} />
}

function SheetTrigger({ asChild, children, ...props }: SheetPrimitive.Trigger.Props & { asChild?: boolean }) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...asChildToRender(asChild, children)} {...props} />
}

function SheetClose({ asChild, children, ...props }: SheetPrimitive.Close.Props & { asChild?: boolean }) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...asChildToRender(asChild, children)} {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn("ui-backdrop fixed inset-0 z-50 bg-black/55", className as string | undefined)}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  const popupRef = React.useRef<HTMLDivElement>(null)
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        initialFocus={popupRef}
        ref={popupRef}
        data-side={side}
        className={cn(
          "ui-sheet fixed z-50 flex max-h-dvh flex-col overflow-y-auto overscroll-contain scroll-fade-y border-[0.5px] border-border-2 bg-popover text-sm text-popover-foreground shadow-[var(--sh-sheet,var(--sh-overlay,0_9px_48px_rgb(0_0_0/.08),0_6px_24px_rgb(0_0_0/.1),0_1px_1px_rgb(0_0_0/.04)))] outline-none data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:rounded-t-[var(--radius-panel)] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:rounded-r-[var(--radius-panel)] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:rounded-l-[var(--radius-panel)] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:rounded-b-[var(--radius-panel)] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          className as string | undefined
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={<Button variant="ghost" className="absolute top-4 right-4" size="icon-sm" />}
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-6 pr-14", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-6", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-sans text-base font-medium text-foreground",
        className as string | undefined
      )}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className as string | undefined)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
