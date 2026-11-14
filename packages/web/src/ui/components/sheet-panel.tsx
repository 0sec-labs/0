import * as React from "react";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "./sheet.js";
import { cn } from "../lib/utils.js";

/** Standard width for settings detail sheets. */
export const SHEET_PANEL_WIDTH = "w-full data-[side=right]:sm:max-w-[640px]";

/**
 * Right-hand detail sheet scaffold: header (optional leading logo), padded body, and an optional bordered footer.
 * `locked` blocks dismissal and hides the close button while a request is in flight.
 */
export function SheetPanel({ open, onOpenChange, locked = false, showClose, title, titleClassName, description, descriptionClassName, leading, footer, footerClassName, bodyClassName, className, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locked?: boolean;
  /** Overrides the close button; defaults to `!locked`. */
  showClose?: boolean;
  title: React.ReactNode;
  titleClassName?: string;
  description?: React.ReactNode;
  descriptionClassName?: string;
  /** Logo or back button placed before the title. Switches the header to a row. */
  leading?: React.ReactNode;
  footer?: React.ReactNode;
  footerClassName?: string;
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const titleBlock = <><SheetTitle className={titleClassName}>{title}</SheetTitle>{description && <SheetDescription className={descriptionClassName}>{description}</SheetDescription>}</>;
  return <Sheet open={open} onOpenChange={next => { if (!next && locked) return; onOpenChange(next); }}>
    <SheetContent className={cn(SHEET_PANEL_WIDTH, className)} showCloseButton={showClose ?? !locked}>
      {leading ? <SheetHeader className="flex-row items-start gap-3">{leading}<div className="min-w-0">{titleBlock}</div></SheetHeader> : <SheetHeader>{titleBlock}</SheetHeader>}
      <div className={cn("flex flex-col gap-6 px-6 pb-6", bodyClassName)}>{children}</div>
      {footer && <SheetFooter className={cn("mt-auto flex-row justify-end gap-2 border-t-[0.5px] border-border-1 py-4", footerClassName)}>{footer}</SheetFooter>}
    </SheetContent>
  </Sheet>;
}
