import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { X, FileSearch, LayoutDashboard, MessageSquare, PlayCircle, Settings, ShieldCheck, ShieldOff, SlidersHorizontal } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { DashboardResponse, ScanRecord } from "@/types";

type PaletteAction = {
  id: string;
  group: "Recent chats" | "Actions" | "Pages" | "Findings" | "Runs";
  label: string;
  meta: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void | Promise<void>;
  keywords: string[];
  preview?: string;
  date?: string;
};

export type SearchMode = "all" | "chats";
export function openAppSearch(mode: SearchMode = "all") {
  window.dispatchEvent(new CustomEvent("zero:open-search", { detail: mode }));
}

const GROUPS: PaletteAction["group"][] = ["Recent chats", "Actions", "Pages", "Findings", "Runs"];

export function CommandPalette({
  open,
  onOpenChange,
  dashboard,
  scans,
  mode = "all",
  onModeChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboard?: DashboardResponse;
  scans?: ScanRecord[];
  mode?: SearchMode;
  onModeChange?: (mode: SearchMode) => void;
}) {
  const { client, getFindingFamily, updateFindingFamilyTriage, webFetch, listConsoleSessions, listSavedConsoleSessions, resumeConsoleSession } = useBackendApi();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const restoreFocus = useRef<HTMLElement | null>(null);
  const [selection, setSelection] = useState("");
  const [query, setQuery] = useState("");
  const [openingChat, setOpeningChat] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const [searchQuery, setSearchQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearchQuery(query.trim()); }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);
  type ChatSearchResult = { id: string; title: string; preview: string; updatedAt: string; archived: boolean; source: "live" | "saved" };
  type ChatSearchPage = { results: ChatSearchResult[]; hasMore: boolean; nextOffset: number | null; truncated: boolean; previewOnly?: boolean };
  const chatsQuery = useInfiniteQuery({
    queryKey: ["search-chats", client.backendId, searchQuery],
    initialPageParam: 0,
    queryFn: async ({ signal, pageParam }): Promise<ChatSearchPage> => {
      const response = await webFetch(`/api/console/search?q=${encodeURIComponent(searchQuery)}&limit=30&offset=${pageParam}`, { signal });
      if (response.status !== 404) {
        if (!response.ok) throw new Error(`Couldn't search chats (${response.status}).`);
        if (!response.headers.get("content-type")?.includes("json")) throw new Error("The engine returned an unexpected search response.");
        const page = await response.json() as ChatSearchPage;
        signal.throwIfAborted(); client.signal.throwIfAborted();
        return page;
      }
      // Older engines have history lists but no conversational search endpoint.
      const [sessions, saved] = await Promise.all([listConsoleSessions(signal), listSavedConsoleSessions(signal)]);
      const live = sessions.slice(0, 1000).filter(session => session.status !== "closed" && ((session.messageCount ?? 0) > 0 || session.status !== "ready"));
      const activeIds = new Set(live.flatMap(session => [session.id, ...(session.savedId ? [session.savedId] : [])]));
      const results: ChatSearchResult[] = live.map(session => ({ id: session.id, title: session.title || session.target || "Untitled chat", preview: session.target || "", updatedAt: session.updatedAt, archived: false, source: "live" }));
      results.push(...saved.slice(0, 1000).filter(session => !activeIds.has(session.id) && session.messageCount > 0).map(session => ({ id: session.id, title: session.summary || session.target || session.preview || "Past chat", preview: session.preview, updatedAt: new Date(session.savedAt).toISOString(), archived: Boolean(session.archived), source: "saved" as const })));
      const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
      const matching = results.filter(result => terms.every(term => `${result.title} ${result.preview}`.toLowerCase().includes(term))).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const nextOffset = pageParam + 30;
      return { results: matching.slice(pageParam, nextOffset), hasMore: nextOffset < matching.length, nextOffset: nextOffset < matching.length ? nextOffset : null, truncated: sessions.length > 1000 || saved.length > 1000, previewOnly: true };
    },
    getNextPageParam: page => page.hasMore && page.nextOffset != null ? page.nextOffset : undefined,
    enabled: open,
    refetchInterval: open && !searchQuery ? 5000 : false,
  });
  const selectedFingerprint = location.pathname.match(/^\/(?:threads|findings)\/([^/]+)/)?.[1] ?? null;
  const selectedScanId = location.pathname.match(/^\/(?:runs|scans)\/([^/]+)/)?.[1] ?? null;

  const selectedFamilyQuery = useQuery({
    queryKey: ["finding-family", client.backendId, selectedFingerprint],
    queryFn: () => getFindingFamily(selectedFingerprint!),
    enabled: open && Boolean(selectedFingerprint),
  });

  const triageMutation = useMutation({
    mutationFn: ({
      triageStatus,
      triageNote,
    }: {
      triageStatus: "new" | "accepted" | "suppressed";
      triageNote: string;
    }) => updateFindingFamilyTriage(selectedFingerprint!, triageStatus, triageNote),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["finding-family", client.backendId, selectedFingerprint] }),
      ]);
    },
  });

  const items = useMemo<PaletteAction[]>(() => {
    const base: PaletteAction[] = [
      {
        id: "page-console",
        group: "Pages",
        label: "Chat",
        meta: "Chat with 0",
        icon: MessageSquare,
        keywords: ["chat operator workspace session scope approvals console"],
        run: () => navigate("/console"),
      },
      {
        id: "new-console",
        group: "Actions",
        label: "New chat",
        meta: "Start a new conversation",
        icon: MessageSquare,
        keywords: ["new conversation chat audit session"],
        run: () => navigate("/console?new=1"),
      },
      ...[
        ["setup", "Setup", "Connect a model and pick a project"],
        ["connections", "Connections", "API keys and accounts"],
        ["models", "Models", "Choose which models 0 uses"],
        ["settings", "Settings", "Preferences, shortcuts, appearance"],
        ["plugins", "Plugins", "Add and manage extensions"],
        ["learning", "Learning", "Lessons that help with future reviews"],
        ["doctor", "Diagnostics", "Check that everything works"],
        ["tools", "Tools", "What 0 can use"],
        ["project", "Project", "Target and permissions"],
        ["fix", "Fix", "Review and apply a code fix"],
      ].map(([route, label, meta]): PaletteAction => ({
        id: `control-${route}`, group: "Pages", label: label!, meta: meta!, icon: route === "settings" ? Settings : SlidersHorizontal,
        keywords: [route!, label!],
        run: () => {
          const sessionId = location.pathname.match(/^\/console\/([^/]+)/)?.[1];
          navigate(`/${route}${sessionId ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(location.pathname)}` : ""}`);
        },
      })),
      {
        id: "page-findings",
        group: "Pages",
        label: "Findings",
        meta: "Issues 0 found",
        icon: FileSearch,
        keywords: ["findings families review evidence console handoff"],
        run: () => navigate("/findings"),
      },
      {
        id: "page-control",
        group: "Pages",
        label: "Overview",
        meta: "What 0 is doing",
        icon: LayoutDashboard,
        keywords: ["operations dashboard overview workers queue"],
        run: () => navigate("/dashboard"),
      },
      {
        id: "page-scans",
        group: "Pages",
        label: "Workflows",
        meta: "Create and run security workflows",
        icon: PlayCircle,
        keywords: ["workflows automations agents audit security review scans"],
        run: () => navigate("/workflows"),
      },
    ];

    const selectedFindingId = selectedFamilyQuery.data?.latest.id;
    if (selectedFindingId) {
      base.unshift(
        {
          id: "finding-console",
          group: "Actions",
          label: "Investigate this finding",
          meta: "Open it in a new chat",
          icon: MessageSquare,
          keywords: ["finding investigate console chat focus evidence"],
          run: () => navigate(`/console?finding=${encodeURIComponent(selectedFindingId)}&intent=investigate`),
        },
        {
          id: "finding-impact",
          group: "Actions",
          label: "View impact",
          meta: "See how serious this finding is",
          icon: FileSearch,
          keywords: ["finding impact assessment stored"],
          run: () => navigate(`/console?finding=${encodeURIComponent(selectedFindingId)}&intent=impact`),
        },
      );
    }
    if (selectedFingerprint) {
      base.unshift(
        {
          id: "triage-accept",
          group: "Actions",
          label: "Accept finding",
          meta: "Mark as real",
          icon: ShieldCheck,
          keywords: ["accept finding triage"],
          run: () => triageMutation.mutate({
            triageStatus: "accepted",
            triageNote: selectedFamilyQuery.data?.latest.triageNote ?? "",
          }),
        },
        {
          id: "triage-suppress",
          group: "Actions",
          label: "Dismiss finding",
          meta: "Hide it from the list",
          icon: ShieldOff,
          keywords: ["suppress finding triage"],
          run: () => triageMutation.mutate({
            triageStatus: "suppressed",
            triageNote: selectedFamilyQuery.data?.latest.triageNote ?? "",
          }),
        },
      );
    }

    if (selectedScanId) {
      base.unshift({
        id: "scan-detail",
        group: "Actions",
        label: "Open this run",
        meta: "Run report",
        icon: PlayCircle,
        keywords: ["scan timeline detail current"],
        run: () => navigate(`/runs/${selectedScanId}`),
      });
    }

    for (const group of dashboard?.groups.slice(0, 14) ?? []) {
      base.push({
        id: `finding-${group.fingerprint}`,
        group: "Findings",
        label: group.latest.title,
        meta: `${group.latest.severity} · ${group.latest.triageStatus}`,
        icon: FileSearch,
        keywords: [group.latest.title, group.latest.category, group.latest.severity, group.latest.triageStatus],
        run: () => navigate(`/findings/${group.fingerprint}`),
      });
    }

    for (const scan of scans?.slice(0, 14) ?? []) {
      base.push({
        id: `scan-${scan.id}`,
        group: "Runs",
        label: scan.target?.trim() || `Run ${scan.id.slice(0, 8)}`,
        meta: scan.status,
        icon: PlayCircle,
        keywords: [scan.target, scan.status, scan.depth, scan.runtime, scan.mode],
        run: () => navigate(`/runs/${scan.id}`),
      });
    }

    const results = query.trim() === searchQuery ? chatsQuery.data?.pages.flatMap(page => page.results) ?? [] : [];
    const recent = searchQuery || mode === "chats" ? results : results.filter(session => !session.archived).slice(0, 6);
    const chats: PaletteAction[] = recent.map(session => ({
      id: `chat-${session.source}-${session.id}`, group: "Recent chats", label: session.title,
      meta: session.archived ? "Archived" : "", icon: MessageSquare,
      keywords: [session.title, session.preview],
      preview: searchQuery ? session.preview : undefined,
      date: searchQuery ? new Date(session.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined,
      run: session.source === "live" ? () => navigate(`/console/${session.id}`) : async () => { const resumed = await resumeConsoleSession(session.id); navigate(`/console/${resumed.id}`); },
    }));
    return [...chats, ...base];
  }, [
    chatsQuery.data, searchQuery, query, mode, resumeConsoleSession,
    dashboard?.groups,
    navigate,
    queryClient,
    scans,
    selectedFingerprint,
    selectedFamilyQuery.data?.latest.triageNote,
    location.pathname,
    selectedFamilyQuery.data?.latest.id,
    selectedScanId,
    triageMutation,
  ]);

  const filteredItems = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase();
    const visible = mode === "chats" ? items.filter(item => item.group === "Recent chats") : items;
    if (!normalized) return visible;

    return visible.filter(item => item.group === "Recent chats" || normalized.split(/\s+/).every(term => [item.label, item.meta, ...item.keywords].join(" ").toLowerCase().includes(term)));
  }, [deferredQuery, items, mode]);

  const firstResult = GROUPS.flatMap(group => filteredItems.filter(item => item.group === group))[0]?.id ?? "";
  useEffect(() => { setSelection(firstResult); }, [firstResult, deferredQuery, mode, open]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setOpenError(null);
      setSearchQuery("");
    }
  }, [open]);

  async function selectItem(item: PaletteAction) {
    if (openingChat) return;
    setOpenError(null);
    setOpeningChat(true);
    try {
      await item.run();
      onOpenChange(false);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Couldn't open this chat. Try again.");
    } finally { setOpeningChat(false); }
  }
  const chatsLoading = chatsQuery.isPending || searchQuery !== query.trim();
  const chatsError = chatsQuery.error;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onOpenAutoFocus={() => { restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus.current?.focus(); }} className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[720px] dark:bg-[#222222]" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Search chats, pages, findings and runs. Use the arrow keys to select a result.</DialogDescription>
        </DialogHeader>
        <CommandPrimitive value={selection} onValueChange={setSelection} shouldFilter={false} loop className="flex min-h-0 min-w-0 w-full flex-col" label="Search">
          <div className="flex items-center gap-3 px-6 py-5">
            <CommandPrimitive.Input autoFocus value={query} onValueChange={setQuery} placeholder={mode === "chats" ? "Search chats" : "Search"} aria-label={mode === "chats" ? "Search chats" : "Search chats, pages, findings and runs"} className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground" />
            {query && <Button variant="ghost" size="icon-sm" aria-label="Clear search" onClick={() => setQuery("")}><X className="size-3.5" /></Button>}
            <Button variant="ghost" size="icon-sm" aria-label="Close search" onClick={() => onOpenChange(false)}><X className="size-4" /></Button>
          </div>
          {onModeChange && (query.trim() || mode === "chats") && <div className="flex gap-1 px-6 pb-2" role="group" aria-label="Search in">
            {(["all", "chats"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => onModeChange(value)} className={`rounded-full px-3 py-1 text-xs transition-colors ${mode === value ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/5"}`}>{value === "all" ? "All" : "Chats"}</button>)}
          </div>}
          <CommandPrimitive.List className="max-h-[min(460px,60dvh)] min-w-0 w-full scroll-py-2 overflow-x-hidden overflow-y-auto px-3 pb-3" aria-label="Search results" aria-busy={openingChat || chatsLoading}>
            {GROUPS.map(group => {
              const entries = filteredItems.filter(item => item.group === group);
              if (!entries.length) return null;
              return <CommandPrimitive.Group key={group} heading={group === "Recent chats" && deferredQuery.trim() ? "Chats" : group} className="min-w-0 max-w-full [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
                {entries.map(item => <CommandPrimitive.Item key={item.id} value={item.id} disabled={openingChat} onSelect={() => void selectItem(item)} className="flex min-w-0 max-w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-sm outline-none transition-colors data-[selected=true]:bg-foreground/10 data-[disabled=true]:opacity-50 motion-reduce:transition-none">
                  <item.icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1"><span className="block truncate">{item.label}</span>{item.preview && <span className="mt-1 block truncate text-xs text-muted-foreground">{item.preview}</span>}</span>
                  {item.date && <span className="shrink-0 text-xs text-muted-foreground">{item.date}</span>}
                  {item.meta && item.group !== "Pages" && <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">{item.meta}</span>}
                </CommandPrimitive.Item>)}
              </CommandPrimitive.Group>;
            })}
            {(query.trim() || mode === "chats") && chatsQuery.hasNextPage && <button type="button" className="mx-3 mt-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-foreground/5 disabled:opacity-50" disabled={chatsQuery.isFetching} onClick={() => void chatsQuery.fetchNextPage()}>Show more chats</button>}
            {chatsQuery.data?.pages.some(page => page.previewOnly) && <p className="px-3 py-2 text-xs text-muted-foreground">This engine searches chat titles and previews. Update the engine to search full conversations.</p>}
            {chatsQuery.data?.pages.some(page => page.truncated) && <p className="px-3 py-2 text-xs text-muted-foreground">Showing matches from recent chat history.</p>}
            {chatsLoading && <p role="status" className="px-3 py-4 text-sm text-muted-foreground">Loading chats…</p>}
            {chatsError && <p role="alert" className="px-3 py-4 text-sm text-destructive">Couldn't load chats. <button type="button" className="underline" onClick={() => { void chatsQuery.refetch(); }}>Try again</button></p>}
            {!filteredItems.length && !chatsLoading && !chatsError && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{deferredQuery.trim() ? "No results" : "No chats yet"}</p>}
            {openingChat && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Opening…</p>}
            {openError && <p role="alert" className="px-3 py-2 text-sm text-destructive">{openError}</p>}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}
