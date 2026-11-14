"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { X } from "lucide-react"

import { cn } from "../lib/utils.js"
import { asChildToRender } from "../lib/render.js"
import { Button } from "./button.js"

/** Radix-style cancelable event so existing call sites can keep calling `preventDefault()`. */
type GuardEvent = { preventDefault: () => void; readonly defaultPrevented: boolean; nativeEvent?: Event }
function guardEvent(nativeEvent?: Event): GuardEvent {
  let prevented = false
  return { preventDefault: () => { prevented = true }, get defaultPrevented() { return prevented }, nativeEvent }
}

type Guards = {
  onEscapeKeyDown?: (event: GuardEvent) => void
  onInteractOutside?: (event: GuardEvent) => void
}
const GuardContext = React.createContext<React.RefObject<Guards>>({ current: {} })

function Dialog({ onOpenChange, ...props }: Omit<DialogPrimitive.Root.Props, "onOpenChange"> & {
  onOpenChange?: (open: boolean) => void
}) {
  const guards = React.useRef<Guards>({})
  return (
    <GuardContext.Provider value={guards}>
      <DialogPrimitive.Root
        data-slot="dialog"
        onOpenChange={(open, details) => {
          if (!open) {
            const handler = details.reason === "escape-key" ? guards.current.onEscapeKeyDown
              : details.reason === "outside-press" || details.reason === "focus-out" ? guards.current.onInteractOutside
              : undefined
            if (handler) {
              const event = guardEvent(details.event)
              handler(event)
              if (event.defaultPrevented) { details.cancel(); return }
            }
          }
          onOpenChange?.(open)
        }}
        {...props}
      />
    </GuardContext.Provider>
  )
}

function DialogTrigger({ asChild, children, ...props }: DialogPrimitive.Trigger.Props & { asChild?: boolean }) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...asChildToRender(asChild, children)} {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ asChild, children, ...props }: DialogPrimitive.Close.Props & { asChild?: boolean }) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...asChildToRender(asChild, children)} {...props} />
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "ui-backdrop fixed inset-0 isolate z-50 bg-black/55",
        className as string | undefined
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onInteractOutside,
  overlayClassName,
  ...props
}: Omit<DialogPrimitive.Popup.Props, "initialFocus" | "finalFocus"> & {
  showCloseButton?: boolean
  overlayClassName?: string
  onOpenAutoFocus?: (event: GuardEvent) => void
  onCloseAutoFocus?: (event: GuardEvent) => void
  onEscapeKeyDown?: (event: GuardEvent) => void
  onInteractOutside?: (event: GuardEvent) => void
}) {
  const guards = React.useContext(GuardContext)
  React.useEffect(() => {
    guards.current = { onEscapeKeyDown, onInteractOutside }
    return () => { guards.current = {} }
  }, [guards, onEscapeKeyDown, onInteractOutside])
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        initialFocus={onOpenAutoFocus ? () => { onOpenAutoFocus(guardEvent()); return true } : undefined}
        finalFocus={onCloseAutoFocus ? () => { const event = guardEvent(); onCloseAutoFocus(event); return !event.defaultPrevented } : undefined}
        className={cn(
          "ui-popup ui-popup-dialog fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] overflow-y-auto overscroll-contain scroll-fade-y -translate-x-1/2 -translate-y-1/2 gap-6 rounded-[var(--radius-panel,12px)] border-[0.5px] border-border-2 bg-popover p-6 text-sm text-popover-foreground shadow-[var(--sh-overlay,0_6px_18px_rgb(0_0_0/.03),0_3px_9px_rgb(0_0_0/.04),0_1px_1px_rgb(0_0_0/.05))] outline-none sm:max-w-md",
          className as string | undefined
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" className="absolute top-4 right-4" size="icon-sm" />}
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5 pr-8", className)} {...props} />
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & { showCloseButton?: boolean }) {
  return (
    <div data-slot="dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props}>
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-sans text-base leading-none font-medium", className as string | undefined)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground", className as string | undefined)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
