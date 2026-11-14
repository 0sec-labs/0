import { useEffect, useRef, useSyncExternalStore } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

export type ToastKind = "info" | "success" | "error" | "warning";
export interface ToastAction { label: string; onClick?: () => void; href?: string }
export interface ToastInput {
  id?: string; title: string; description?: string; kind?: ToastKind; action?: ToastAction;
  /** 0 keeps the toast until dismissed (e.g. connection states). Defaults to 5s, 8s for errors. */
  durationMs?: number;
  /** Runs when the person or the timer dismisses it, never when a source replaces/clears it silently. */
  onDismiss?: () => void;
}
export interface ToastItem extends Required<Pick<ToastInput, "id" | "title">> {
  description?: string; kind: ToastKind; action?: ToastAction; durationMs: number; onDismiss?: () => void; leaving: boolean;
}

export const MAX_VISIBLE_TOASTS = 3;
export const TOAST_EXIT_MS = 150;
const DEFAULT_MS = 5000, ERROR_MS = 8000;

interface Timer { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }
let items: ToastItem[] = [];
let snapshot: readonly ToastItem[] = items;
let seq = 0;
const timers = new Map<string, Timer>();
const exits = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
function publish() { snapshot = [...items]; listeners.forEach(listener => listener()); }

function clearTimer(id: string) { const timer = timers.get(id); if (timer?.handle) clearTimeout(timer.handle); timers.delete(id); }
function arm(id: string, remaining: number) {
  clearTimer(id);
  if (remaining <= 0) return;
  const timer: Timer = { handle: null, remaining, startedAt: Date.now() };
  timer.handle = setTimeout(() => dismiss(id), remaining);
  timers.set(id, timer);
}
function remove(id: string) {
  const exit = exits.get(id); if (exit) clearTimeout(exit);
  exits.delete(id); clearTimer(id);
  items = items.filter(item => item.id !== id); publish();
}

/** Show (or update, when the id is already live) a toast. Returns its id. */
export function toast(input: ToastInput): string {
  const id = input.id ?? `toast-${++seq}`;
  const kind = input.kind ?? "info";
  const durationMs = input.durationMs ?? (kind === "error" ? ERROR_MS : DEFAULT_MS);
  const next: ToastItem = { id, title: input.title, description: input.description, kind, action: input.action, durationMs, onDismiss: input.onDismiss, leaving: false };
  const exit = exits.get(id); if (exit) { clearTimeout(exit); exits.delete(id); }
  const index = items.findIndex(item => item.id === id);
  if (index >= 0) items = items.map((item, i) => i === index ? next : item); else items = [...items, next];
  // Newest stays at the bottom; the oldest overflow leaves silently so callers' state is not cleared.
  const live = items.filter(item => !item.leaving);
  for (const old of live.slice(0, Math.max(0, live.length - MAX_VISIBLE_TOASTS))) dismiss(old.id, { silent: true });
  arm(id, durationMs);
  publish();
  return id;
}

export function dismiss(id: string, options: { silent?: boolean } = {}) {
  const item = items.find(entry => entry.id === id);
  if (!item || item.leaving) return;
  clearTimer(id);
  items = items.map(entry => entry.id === id ? { ...entry, leaving: true } : entry);
  exits.set(id, setTimeout(() => remove(id), TOAST_EXIT_MS));
  publish();
  if (!options.silent) item.onDismiss?.();
}

export function pauseToast(id: string) {
  const timer = timers.get(id); if (!timer?.handle) return;
  clearTimeout(timer.handle); timer.handle = null; timer.remaining -= Date.now() - timer.startedAt;
}
export function resumeToast(id: string) {
  const timer = timers.get(id); if (!timer || timer.handle) return;
  arm(id, Math.max(timer.remaining, 1000));
}

/** Test helper: drop everything without callbacks. */
export function clearToasts() { for (const id of [...timers.keys()]) clearTimer(id); exits.forEach(clearTimeout); exits.clear(); items = []; publish(); }

export const getToasts = (): readonly ToastItem[] => snapshot;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useToasts(): readonly ToastItem[] { return useSyncExternalStore(subscribe, () => snapshot, () => snapshot); }

const ICONS = { info: Info, success: CheckCircle2, error: AlertCircle, warning: AlertTriangle } as const;
const TONES = { info: "text-muted-foreground", success: "text-success", error: "text-destructive", warning: "text-warning" } as const;

function ToastCard({ item, onNavigate }: { item: ToastItem; onNavigate?: (href: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const Icon = ICONS[item.kind];
  const urgent = item.kind === "error" || item.kind === "warning";
  useEffect(() => { const frame = requestAnimationFrame(() => ref.current?.setAttribute("data-entered", "")); return () => cancelAnimationFrame(frame); }, []);
  const act = () => {
    const { action } = item; if (!action) return;
    action.onClick?.();
    if (action.href) onNavigate ? onNavigate(action.href) : window.location.assign(action.href);
    dismiss(item.id);
  };
  return <div ref={ref} data-slot="toast" data-kind={item.kind} data-leaving={item.leaving ? "" : undefined}
    role={urgent ? "alert" : "status"} aria-atomic="true" tabIndex={0}
    onMouseEnter={() => pauseToast(item.id)} onMouseLeave={() => resumeToast(item.id)}
    onFocus={() => pauseToast(item.id)} onBlur={() => resumeToast(item.id)}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); dismiss(item.id); } }}
    className="pointer-events-auto flex w-full translate-y-2 items-start gap-2.5 rounded-lg border-[0.5px] border-border-2 bg-popover px-3 py-2.5 text-[13px] leading-5 text-popover-foreground opacity-0 shadow-[var(--sh-overlay,0_6px_18px_rgb(0_0_0/.03),0_3px_9px_rgb(0_0_0/.04),0_1px_1px_rgb(0_0_0/.05))] outline-none transition-[opacity,translate] duration-[var(--duration-base,200ms)] ease-[var(--ease-out-quint,cubic-bezier(.23,1,.32,1))] focus-visible:ring-2 focus-visible:ring-ring/50 data-[entered]:translate-y-0 data-[entered]:opacity-100 data-[leaving]:translate-y-1 data-[leaving]:opacity-0 data-[leaving]:duration-[var(--duration-fast,150ms)] motion-reduce:translate-y-0 motion-reduce:transition-opacity motion-reduce:duration-[120ms] sm:max-w-sm">
    <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${TONES[item.kind]}`} />
    <div className="min-w-0 flex-1">
      <p className="whitespace-pre-wrap break-words font-medium">{item.title}</p>
      {item.description && <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">{item.description}</p>}
    </div>
    {item.action && <button type="button" onClick={act} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-foreground underline-offset-2 hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">{item.action.label}</button>}
    <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(item.id)} className="-mr-1 -mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"><X aria-hidden="true" className="size-3.5" /></button>
  </div>;
}

/** Bottom-right stack, newest at the bottom; full width above the safe area on small screens. */
export function Toaster({ onNavigate }: { onNavigate?: (href: string) => void }) {
  const list = useToasts();
  if (!list.length) return null;
  return <div data-slot="toaster" className="pointer-events-none fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[80] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end">
    {list.map(item => <ToastCard key={item.id} item={item} onNavigate={onNavigate} />)}
  </div>;
}
