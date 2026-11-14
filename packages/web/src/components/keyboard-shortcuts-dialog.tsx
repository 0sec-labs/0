import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { matchShortcut } from "@/lib/shortcuts";
import { ShortcutList } from "@/components/console-control/shortcuts-control";

/** Window event the account menu fires to open the dialog. */
export const OPEN_SHORTCUTS_EVENT = "zero:open-shortcuts";
export const openShortcutsDialog = () => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT));

/** Keyboard shortcuts dialog: opens with "?" when not typing, or from the account menu. Reads the shared registry. */
export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || matchShortcut(event)?.handler !== "shortcuts.open") return;
      event.preventDefault();
      setOpen(value => !value);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen); };
  }, []);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle><DialogDescription>Press ? any time outside a text field to open this list.</DialogDescription></DialogHeader>
      <ShortcutList />
    </DialogContent>
  </Dialog>;
}
