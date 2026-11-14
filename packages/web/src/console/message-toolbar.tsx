import { useEffect, useRef, useState } from "react";
import { Check, Copy, Link2, MoreHorizontal, Reply, FileText } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { plainText, quoteBlock, toolbarActions } from "./transcript-actions";
import { cn } from "@/lib/utils";

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

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
  return iso && !Number.isNaN(date.getTime())
    ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    : undefined;
}

/** Centered day/time stamp between turns. */
export function DayStamp({ iso }: { iso?: string }) {
  const label = formatStamp(iso);
  if (!label) return null;
  return (
    <div data-slot="chat-stamp" className="flex min-h-7 justify-center text-xs tabular-nums text-muted-foreground-2">
      {label}
    </div>
  );
}

const iconButton =
  "inline-flex size-5 items-center justify-center rounded-[var(--radius-inner,4px)] text-muted-foreground-1 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

/**
 * Hover/focus toolbar floating above a message: time, Reply, Copy and a More menu.
 * Parent must be `group/rail relative`. Edit and Retry-from-here are intentionally absent: the engine can neither
 * rewrite a sent message nor rewind a session to an earlier turn.
 */
export function MessageToolbar({
  iso,
  text,
  align = "right",
  onReply,
  link,
}: {
  iso?: string;
  text: string;
  align?: "left" | "right";
  /** Quote the message into the composer draft; absent when the reader cannot write. */
  onReply?: (quote: string) => void;
  /** Permalink to this message. */
  link?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const time = formatStamp(iso);
  const actions = toolbarActions({ text, canReply: Boolean(onReply), hasLink: Boolean(link) });
  if (!time && !actions.copy) return null;
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard may be unavailable; the text stays selectable. */
    }
  };
  return (
    <div
      data-slot="message-toolbar"
      data-menu-open={menuOpen || undefined}
      className={cn(
        "absolute -top-[22px] z-10 flex h-7 items-center gap-0.5 rounded-[var(--radius,6px)] border-[0.5px] border-border-2 bg-card px-1 text-xs text-muted-foreground-2 shadow-sm opacity-0 transition-opacity group-hover/rail:opacity-100 group-focus-within/rail:opacity-100 data-[menu-open]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100 in-data-[show-timestamps=true]:opacity-100",
        align === "right" ? "right-0" : "left-0",
      )}
    >
      {time && <span className="px-1 tabular-nums">{time}</span>}
      {actions.reply && onReply && (
        <button type="button" aria-label="Reply" title="Reply" onClick={() => onReply(quoteBlock(text))} className={iconButton}>
          <Reply aria-hidden="true" className="size-3.5" />
        </button>
      )}
      {actions.copy && (
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy message"}
          title="Copy message"
          onClick={() => void copy(plainText(text))}
          className={iconButton}
        >
          {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
        </button>
      )}
      {(actions.copyMarkdown || actions.copyLink) && (
        <DropdownMenu onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger render={<button type="button" aria-label="More" title="More" className={iconButton} />}>
            <MoreHorizontal aria-hidden="true" className="size-3.5" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" sideOffset={4}>
            {actions.copyMarkdown && (
              <DropdownMenu.Item icon={<FileText aria-hidden="true" />} onClick={() => void copy(text)}>
                Copy as markdown
              </DropdownMenu.Item>
            )}
            {actions.copyLink && link && (
              <DropdownMenu.Item icon={<Link2 aria-hidden="true" />} onClick={() => void copy(link)}>
                Copy message link
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>
      )}
    </div>
  );
}
