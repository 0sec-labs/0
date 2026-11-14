import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

function startOfDay(date: Date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); }

/** "12:16" today, "Mon 12:16" within the last week, otherwise "Mar 3, 12:16". */
export function formatStamp(iso: string | undefined, now = new Date()): string | undefined {
  const date = new Date(iso ?? "");
  if (!iso || Number.isNaN(date.getTime())) return undefined;
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return time;
  if (days > 0 && days < 7) return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })}, ${time}`;
}

export function dayKey(iso: string | undefined): string | undefined {
  const date = new Date(iso ?? "");
  return iso && !Number.isNaN(date.getTime()) ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : undefined;
}

/** Centered day/time stamp between turns. */
export function DayStamp({ iso }: { iso?: string }) {
  const label = formatStamp(iso);
  if (!label) return null;
  return <div data-slot="chat-stamp" className="flex min-h-7 justify-center text-xs tabular-nums text-muted-foreground-2">{label}</div>;
}

/** Hover/focus toolbar floating above a message: time label and Copy. Parent must be `group/rail relative`. */
export function MessageToolbar({ iso, text, align = "right" }: { iso?: string; text: string; align?: "left" | "right" }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const time = formatStamp(iso);
  if (!time && !text) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch { /* Clipboard may be unavailable; the text stays selectable. */ }
  };
  return <div data-slot="message-toolbar" className={cn("absolute -top-[22px] z-10 flex h-7 items-center gap-0.5 rounded-[var(--radius,6px)] border-[0.5px] border-border-2 bg-card px-1 text-xs text-muted-foreground-2 shadow-sm opacity-0 transition-opacity group-hover/rail:opacity-100 group-focus-within/rail:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100 in-data-[show-timestamps=true]:opacity-100", align === "right" ? "right-0" : "left-0")}>
    {time && <span className="px-1 tabular-nums">{time}</span>}
    {text && <button type="button" aria-label={copied ? "Copied" : "Copy message"} onClick={() => void copy()} className="inline-flex size-5 items-center justify-center rounded-[var(--radius-inner,4px)] text-muted-foreground-1 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">{copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}</button>}
  </div>;
}
