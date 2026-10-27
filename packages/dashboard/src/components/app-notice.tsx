import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Info, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export interface AppNotice {
  id: string;
  message: string;
  kind?: "error" | "status";
  onDismiss?: () => void;
  action?: { label: string; href?: string; onClick?: () => void };
}
type Registration = (owner: string, notice: AppNotice) => () => void;
const AppNoticeContext = createContext<{ register: Registration; notices: AppNotice[] } | null>(null);

/** Notices belong to their mounted source, so route changes cannot leave stale errors. */
export function AppNoticeProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Map<string, AppNotice>>(() => new Map());
  const register = useCallback<Registration>((owner, notice) => {
    setEntries(previous => new Map(previous).set(owner, notice));
    return () => setEntries(previous => {
      if (previous.get(owner) !== notice) return previous;
      const next = new Map(previous); next.delete(owner); return next;
    });
  }, []);
  const value = useMemo(() => ({ register, notices: [...entries.values()] }), [entries, register]);
  return <AppNoticeContext.Provider value={value}>{children}</AppNoticeContext.Provider>;
}

/** Register a page-level error/status; local form and embedded-pane errors stay local. */
export function useAppNotice(notice: AppNotice | null | undefined): boolean {
  const context = useContext(AppNoticeContext);
  const owner = useId();
  const latest = useRef(notice);
  latest.current = notice;
  const register = context?.register;
  const id = notice?.id, message = notice?.message, kind = notice?.kind;
  const actionLabel = notice?.action?.label, actionHref = notice?.action?.href;
  const canDismiss = Boolean(notice?.onDismiss);
  useEffect(() => {
    if (!register || !id || !message) return;
    return register(owner, { id, message, kind, ...(canDismiss ? { onDismiss: () => latest.current?.onDismiss?.() } : {}), ...(actionLabel ? { action: { label: actionLabel, href: actionHref, onClick: () => latest.current?.action?.onClick?.() } } : {}) });
  }, [register, owner, id, message, kind, actionLabel, actionHref, canDismiss]);
  return Boolean(context);
}

export function AppNoticeBanner({ notice }: { notice: AppNotice }) {
  const error = notice.kind !== "status";
  const Icon = error ? AlertCircle : Info;
  return <div data-slot="app-notice" role={error ? "alert" : "status"} aria-atomic="true" className={`flex shrink-0 items-start gap-3 border-b ${error ? "border-destructive/20" : "border-border"} bg-card px-4 py-3 text-sm text-foreground sm:px-6`}>
    <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${error ? "text-destructive" : "text-muted-foreground"}`} />
    <p className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-5">{notice.message}</p>
    <div className="flex shrink-0 items-center gap-2">
      {notice.action && (notice.action.href ? <Button asChild variant="outline" size="sm"><Link to={notice.action.href}>{notice.action.label}</Link></Button> : <Button variant="outline" size="sm" onClick={notice.action.onClick}>{notice.action.label}</Button>)}
      {notice.onDismiss && <Button variant="ghost" size="icon-sm" aria-label="Dismiss notification" onClick={notice.onDismiss}><X className="size-4" /></Button>}
    </div>
  </div>;
}

export function AppNoticeHost() {
  const context = useContext(AppNoticeContext);
  const notices = context?.notices || [];
  const notice = notices.findLast(item => item.kind !== "status") || notices.at(-1);
  return notice ? <div className="pointer-events-none absolute inset-x-4 top-3 z-50 flex justify-center"><div className="pointer-events-auto w-full max-w-2xl overflow-hidden rounded-xl border border-border shadow-lg"><AppNoticeBanner notice={notice} /></div></div> : null;
}
