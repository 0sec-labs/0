import { useContext, useEffect, useId, useRef, createContext, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { dismiss, toast, Toaster, type ToastInput } from "@/ui/components/toast";

export interface AppNotice {
  id: string;
  message: string;
  kind?: "error" | "status";
  onDismiss?: () => void;
  action?: { label: string; href?: string; onClick?: () => void };
}
const AppNoticeContext = createContext(false);

/** Maps a page-level notice onto the toast store (errors stay 8s, status 5s). */
export function noticeToToast(notice: AppNotice): ToastInput {
  return {
    id: `notice:${notice.id}`, title: notice.message, kind: notice.kind === "status" ? "info" : "error",
    ...(notice.onDismiss ? { onDismiss: notice.onDismiss } : {}),
    ...(notice.action ? { action: notice.action } : {}),
  };
}

/** Marks that notices render in this tree; sources register through toasts. */
export function AppNoticeProvider({ children }: { children: ReactNode }) {
  return <AppNoticeContext.Provider value>{children}</AppNoticeContext.Provider>;
}

/** Register a page-level error/status; local form and embedded-pane errors stay local. */
export function useAppNotice(notice: AppNotice | null | undefined): boolean {
  const mounted = useContext(AppNoticeContext);
  const owner = useId();
  const latest = useRef(notice);
  latest.current = notice;
  const id = notice?.id, message = notice?.message, kind = notice?.kind;
  const actionLabel = notice?.action?.label, actionHref = notice?.action?.href;
  const canDismiss = Boolean(notice?.onDismiss);
  useEffect(() => {
    if (!mounted || !id || !message) return;
    const input = noticeToToast({
      id, message, kind,
      ...(canDismiss ? { onDismiss: () => latest.current?.onDismiss?.() } : {}),
      ...(actionLabel ? { action: { label: actionLabel, href: actionHref, onClick: () => latest.current?.action?.onClick?.() } } : {}),
    });
    toast(input);
    // The owning page leaving clears its notice without invoking onDismiss.
    return () => dismiss(input.id!, { silent: true });
  }, [mounted, owner, id, message, kind, actionLabel, actionHref, canDismiss]);
  return mounted;
}

/** Mounted inside the router so action links can navigate client-side. */
export function AppNoticeHost() {
  const navigate = useNavigate();
  return <Toaster onNavigate={href => navigate(href)} />;
}
