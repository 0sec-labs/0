import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plug } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useBackendApi } from "@/api";
import type { PluginItem, PluginsResponse } from "@/components/console-control/contracts";

export interface IntegrationMentionReplacement { start: number; end: number; text: string }

/** Match the mention at the caret, without treating email addresses as mentions. */
export function integrationMentionAt(draft: string, caret: number) {
  const end = Math.max(0, Math.min(draft.length, caret));
  const match = /(?:^|\s)@([^\s@]*)$/.exec(draft.slice(0, end));
  const suffix = /^[^\s@]*/.exec(draft.slice(end))?.[0] ?? "";
  return match ? { start: end - match[1]!.length - 1, end: end + suffix.length, query: match[1]! } : null;
}

export function useIntegrationPicker({ draft, caret, onSelect }: {
  draft: string;
  caret: number;
  onSelect: (plugin: PluginItem, replacement: IntegrationMentionReplacement) => void;
}) {
  const { webFetchJson } = useBackendApi();
  const id = useId();
  const mention = integrationMentionAt(draft, caret);
  const key = mention ? `${mention.start}:${mention.end}:${mention.query}` : "";
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selection, setSelection] = useState({ key: "", index: 0 });
  const open = !!mention && dismissed !== key;
  const inventory = useQuery({
    queryKey: ["console-plugins"],
    queryFn: ({ signal }) => webFetchJson<PluginsResponse>("/api/console/plugins", { signal }),
    enabled: open,
    staleTime: 10_000,
  });
  const items = (inventory.data?.items ?? []).filter(plugin =>
    plugin.kind === "plugin" && plugin.state === "enabled" && plugin.loaded && !plugin.error &&
    `${plugin.name} ${plugin.id}`.toLowerCase().includes(mention?.query.toLowerCase() ?? ""));
  const index = Math.min(selection.key === key ? selection.index : 0, Math.max(0, items.length - 1));
  function select(plugin: PluginItem) {
    if (!mention) return;
    // This is message context. Existing server-owned tool and consent gates still apply.
    onSelect(plugin, { start: mention.start, end: mention.end, text: `@${plugin.id} ` });
    setDismissed(key);
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return false;
    if (event.key === "Escape") { event.preventDefault(); setDismissed(key); return true; }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
      event.preventDefault();
      setSelection({ key, index: (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length });
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.nativeEvent.isComposing && items[index]) {
      event.preventDefault(); select(items[index]!); return true;
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); return true; }
    return false;
  }
  return { open, items, index, select, onKeyDown, id,
    loading: inventory.isPending, error: inventory.error,
    textareaProps: {
      "aria-controls": open ? id : undefined,
      "aria-autocomplete": "list" as const,
      "aria-activedescendant": open && items[index] ? `${id}-${index}` : undefined,
    },
  };
}

/**
 * Floating suggestion popup anchored inside the composer card. Like Capy it opens below the first text
 * line (covering the toolbar) when the viewport has room and flips above the card otherwise. It uses the
 * shared popup chrome and motion, and stays mounted briefly so dismissal can fade out.
 */
export function ComposerPickerSurface({ open, children, className = "", label }: { open: boolean; children: ReactNode; className?: string; label: string }) {
  const [mounted, setMounted] = useState(open);
  const [above, setAbove] = useState(false);
  const [shown, setShown] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setMounted(true); }, [open]);
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node || !open) return;
    const card = node.offsetParent as HTMLElement | null;
    if (!card) return;
    const top = card.getBoundingClientRect().top + 38;
    setAbove(window.innerHeight - top - 12 < Math.min(node.offsetHeight, 240) && card.getBoundingClientRect().top > node.offsetHeight);
  }, [open, mounted, children]);
  useEffect(() => {
    if (!mounted) { setShown(false); return; }
    const frame = requestAnimationFrame(() => setShown(open));
    return () => cancelAnimationFrame(frame);
  }, [open, mounted]);
  if (!mounted) return null;
  return <div ref={surface} aria-label={label} aria-hidden={!open} inert={!open || undefined} data-side={above ? "top" : "bottom"}
    data-starting-style={!shown || undefined}
    onTransitionEnd={event => { if (event.target === event.currentTarget && !open) setMounted(false); }}
    className={`ui-popup absolute left-5 z-30 overflow-hidden rounded-[var(--radius-overlay,8px)] border-[0.5px] border-border-2 bg-popover p-1 font-sans text-popover-foreground shadow-[var(--sh-overlay)] ${above ? "bottom-full mb-2 origin-bottom-left" : "top-[38px] origin-top-left"} ${!open ? "pointer-events-none opacity-0" : ""} ${className}`}>{children}</div>;
}

export function IntegrationPicker({ picker }: { picker: ReturnType<typeof useIntegrationPicker> }) {
  useEffect(() => { if (picker.open) document.getElementById(`${picker.id}-${picker.index}`)?.scrollIntoView({ block: "nearest" }); }, [picker.id, picker.index, picker.open]);
  return <ComposerPickerSurface open={picker.open} label="Plugins" className="w-80 max-w-full">
    <div id={picker.id} role="listbox" aria-label="Available plugins" className="max-h-[232px] overflow-y-auto overscroll-contain scroll-fade-y">
      {picker.items.map((plugin, index) => <Tooltip key={plugin.id} content={plugin.description || plugin.name} shortcut={index === picker.index ? "Enter / Tab" : undefined} side="right"><button id={`${picker.id}-${index}`} type="button" role="option" aria-selected={index === picker.index}
        onMouseDown={event => event.preventDefault()} onClick={() => picker.select(plugin)}
        className={`flex min-h-[var(--h-menu-row,28px)] w-full items-center gap-2 rounded-md px-2 py-1 text-left leading-5 outline-none text-[13px] font-[450] tracking-[-0.01em] focus-visible:outline-ring-inset ${index === picker.index ? "bg-secondary" : "hover:bg-secondary/60"}`}>
        <Plug className="size-3.5 shrink-0 text-icon-muted" strokeWidth={1.5} aria-hidden="true" />
        <span className="min-w-0 flex-1"><span className="block truncate text-foreground">{plugin.name}</span>{plugin.description && <span className="block truncate text-xs font-[450] leading-4 tracking-normal text-muted-foreground-2">{plugin.description}</span>}</span>
      </button></Tooltip>)}
    </div>
    {picker.items.length === 0 && <p role="status" className="px-2 py-1.5 text-[13px] text-muted-foreground-1">{picker.loading ? "Loading plugins…" : picker.error ? "Couldn't load plugins." : "No matching plugins."}</p>}
    <Link to="/plugins" className="mt-1 flex min-h-[var(--h-menu-row,28px)] items-center gap-2 rounded-md px-2 py-1 leading-5 outline-none focus-visible:outline-ring-inset text-[13px] font-[450] text-muted-foreground-1 hover:bg-secondary hover:text-foreground">Manage plugins</Link>
  </ComposerPickerSurface>;
}
