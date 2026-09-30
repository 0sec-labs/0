import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plug } from "lucide-react";
import { webFetchJson } from "@/api";
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

/** Keep dismissal in the DOM long enough for a quiet, cancellable fade. */
export function ComposerPickerSurface({ open, children, className = "", label }: { open: boolean; children: ReactNode; className?: string; label: string }) {
  const [mounted, setMounted] = useState(open);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setMounted(true); }, [open]);
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || node.closest('[data-reduced-motion="true"]')) {
      if (!open) setMounted(false);
      return;
    }
    const animation = node.animate(open ? [
      { opacity: 0, transform: "translateY(4px) scale(.99)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ] : [{ opacity: 1 }, { opacity: 0 }], { duration: open ? 150 : 100, easing: "ease-out", fill: "both" });
    animation.onfinish = () => { if (!open) setMounted(false); };
    return () => animation.cancel();
  }, [open, mounted]);
  if (!mounted) return null;
  return <div ref={surface} aria-label={label} aria-hidden={!open} inert={!open || undefined} className={`absolute bottom-full left-0 z-30 mb-2 rounded-2xl bg-popover p-2 font-sans shadow-lg ${!open ? "pointer-events-none" : ""} ${className}`}>{children}</div>;
}

export function IntegrationPicker({ picker }: { picker: ReturnType<typeof useIntegrationPicker> }) {
  useEffect(() => { if (picker.open) document.getElementById(`${picker.id}-${picker.index}`)?.scrollIntoView({ block: "nearest" }); }, [picker.id, picker.index, picker.open]);
  return <ComposerPickerSurface open={picker.open} label="Integrations" className="w-full max-w-sm">
    <div id={picker.id} role="listbox" aria-label="Available integrations" className="max-h-[280px] overflow-y-auto overscroll-contain">
      {picker.items.map((plugin, index) => <button key={plugin.id} id={`${picker.id}-${index}`} type="button" role="option" aria-selected={index === picker.index}
        onMouseDown={event => event.preventDefault()} onClick={() => picker.select(plugin)}
        className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors duration-100 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-primary ${index === picker.index ? "bg-muted" : "hover:bg-muted/60"}`}>
        <Plug className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0"><span className="block truncate font-medium">{plugin.name}</span>{plugin.description && <span className="block truncate text-xs text-muted-foreground">{plugin.description}</span>}</span>
      </button>)}
    </div>
    {picker.items.length === 0 && <p role="status" className="px-3 py-3 text-sm text-muted-foreground">{picker.loading ? "Loading integrations…" : picker.error ? "Couldn't load integrations." : "No matching integrations."}</p>}
    <Link to="/plugins" className="mt-1 block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">Manage integrations</Link>
  </ComposerPickerSurface>;
}
