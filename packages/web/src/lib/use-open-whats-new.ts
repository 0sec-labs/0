import { useCallback } from "react";
import { useMobileSidebar } from "@/ui/components/sidebar";
import { openWhatsNew } from "./whats-new";

/** Opens the dialog from inside the sidebar; on mobile the drawer closes first so the dialog is not covered. */
export function useOpenWhatsNew() {
  const sidebar = useMobileSidebar();
  return useCallback(() => { sidebar?.setOpen(false); openWhatsNew(); }, [sidebar]);
}
