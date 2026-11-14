import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "./button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog.js";
import { cn } from "../lib/utils.js";

type DialogFrameProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Locks the dialog: no dismissal, no close button, cancel disabled. */
  pending?: boolean;
  /** Rendered after the body and before the footer; pass an already-formed alert or `Feedback` node. */
  error?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  cancelVariant?: "ghost" | "outline";
  className?: string;
  /** Restore focus to the control that opened the dialog instead of the default target. */
  onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
  children?: React.ReactNode;
};

type ConfirmProps = DialogFrameProps & {
  confirmLabel: React.ReactNode;
  destructive?: boolean;
  confirmDisabled?: boolean;
  /** Show a spinner on the confirm button while pending. */
  spinner?: boolean;
  onConfirm: () => void;
};

type FormProps = DialogFrameProps & {
  submitLabel: React.ReactNode;
  submitDisabled?: boolean;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  footerClassName?: string;
  /** Defaults to `pending`. */
  cancelDisabled?: boolean;
  formClassName?: string;
};

function Frame({ open, onOpenChange, title, description, pending = false, className, onCloseAutoFocus, children }: Pick<DialogFrameProps, "open" | "onOpenChange" | "title" | "description" | "pending" | "className" | "onCloseAutoFocus"> & { children: React.ReactNode }) {
  return <Dialog open={open} onOpenChange={next => { if (!next && pending) return; onOpenChange(next); }}>
    <DialogContent showCloseButton={!pending} className={className} onCloseAutoFocus={onCloseAutoFocus}>
      <DialogHeader><DialogTitle>{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}

/** Question, consequence, Cancel and one confirming action. Pending locks dismissal so a request cannot be orphaned. */
export function ConfirmDialog({ confirmLabel, destructive = false, confirmDisabled = false, spinner = false, onConfirm, error, cancelLabel = "Cancel", cancelVariant = "ghost", children, ...frame }: ConfirmProps) {
  const pending = Boolean(frame.pending);
  return <Frame {...frame}>
    {children}
    {error}
    <DialogFooter>
      <Button variant={cancelVariant} disabled={pending} onClick={() => frame.onOpenChange(false)}>{cancelLabel}</Button>
      <Button variant={destructive ? "destructive" : "default"} aria-busy={pending || undefined} disabled={pending || confirmDisabled} onClick={onConfirm}>
        {spinner && pending && <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />}{confirmLabel}
      </Button>
    </DialogFooter>
  </Frame>;
}

/** A form in a dialog: header, fields, error, Cancel and a submit button. */
export function FormDialog({ submitLabel, submitDisabled = false, onSubmit, error, cancelLabel = "Cancel", cancelVariant = "ghost", cancelDisabled, footerClassName, formClassName, children, ...frame }: FormProps) {
  const pending = Boolean(frame.pending);
  return <Frame {...frame}>
    <form className={cn("space-y-4", formClassName)} onSubmit={onSubmit}>
      {children}
      {error}
      <DialogFooter className={footerClassName}>
        <Button type="button" variant={cancelVariant} disabled={cancelDisabled ?? pending} onClick={() => frame.onOpenChange(false)}>{cancelLabel}</Button>
        <Button type="submit" aria-busy={pending || undefined} disabled={pending || submitDisabled}>{submitLabel}</Button>
      </DialogFooter>
    </form>
  </Frame>;
}
