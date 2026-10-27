import { LoadingState } from "@/components/state-panel";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { X, FileSearch, LayoutDashboard, MessageSquare, PlayCircle, Settings, ShieldCheck, ShieldOff, SlidersHorizontal, BookOpen, Blocks, Brain, Users, Server } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { setWebTheme } from "@/lib/web-theme";
import { useBackendApi } from "@/api";
import { useBackendSelection } from "@/backend-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { DashboardResponse, ScanRecord } from "@/types";
import type { SecurityWorkflow, ServicePluginsResponse } from "@0/shared";
import { visibleWebSetting, categoryFor, settingLabel } from "./console-control/settings-control";
import type { PluginsResponse, SettingsResponse } from "./console-control/contracts";
import type { LearningResponse } from "./learning-panel";
import { useTeamAccess } from "./team-access";
import { filterAppSearch, searchKeywords, SEARCH_GROUPS, type SearchGroup } from "./app-search";

type PaletteAction = {
  id: string;
  group: SearchGroup;
  label: string;
  meta: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void | Promise<void>;
  keywords: string[];
  preview?: string;
  date?: string;
};

export type SearchMode = "all" | "chats";
export type SearchRequest = { mode: SearchMode; returnFocus?: HTMLElement };
export function openAppSearch(mode: SearchMode = "all", returnFocus?: HTMLElement) {
  window.dispatchEvent(new CustomEvent<SearchRequest>("zero:open-search", { detail: { mode, returnFocus } }));
}

const GROUPS = SEARCH_GROUPS;

export function CommandPalette({
  open,
  onOpenChange,
  dashboard,
  scans,
  mode = "all",
  onModeChange,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboard?: DashboardResponse;
  scans?: ScanRecord[];
  mode?: SearchMode;
  onModeChange?: (mode: SearchMode) => void;
  returnFocus?: React.RefObject<HTMLElement | null>;
}) {
  const { client, getFindingFamily, updateFindingFamilyTriage, webFetch, webFetchJson, listConsoleSessions, listSavedConsoleSessions, resumeConsoleSession } = useBackendApi();
  const team = useTeamAccess();
  const connection = useBackendSelection();
  const scope = [client.backendId, team.user?.workspaceId ?? "personal", team.user?.userId ?? "local"];
  const inventoryEnabled = open && mode === "all";
  const settingsQuery = useQuery({ queryKey: ["app-search", ...scope, "settings"], queryFn: ({ signal }) => webFetchJson<SettingsResponse>("/api/console/settings", { signal }), enabled: inventoryEnabled, staleTime: 15_000, retry: false });
  const workflowsQuery = useQuery({ queryKey: ["app-search", ...scope, "workflows"], queryFn: ({ signal }) => webFetchJson<{ definitions: SecurityWorkflow[] }>("/api/console/workflow-definitions", { signal }), enabled: inventoryEnabled, staleTime: 15_000, retry: false });
  const skillsQuery = useQuery({ queryKey: ["app-search", ...scope, "skills"], queryFn: ({ signal }) => webFetchJson<{ skills: Array<{ id: string; name: string; description: string; scope: string }> }>("/api/skills", { signal }), enabled: inventoryEnabled, staleTime: 15_000, retry: false });
  const pluginsQuery = useQuery({ queryKey: ["app-search", ...scope, "plugins"], queryFn: ({ signal }) => webFetchJson<PluginsResponse>("/api/console/plugins", { signal }), enabled: inventoryEnabled, staleTime: 15_000, retry: false });
  const servicesQuery = useQuery({ queryKey: ["app-search", ...scope, "services"], queryFn: ({ signal }) => webFetchJson<ServicePluginsResponse>("/api/console/service-plugins", { signal }), enabled: inventoryEnabled, staleTime: 15_000, retry: false });
  const memoryQuery = useQuery({ queryKey: ["app-search", ...scope, "memory"], queryFn: ({ signal }) => webFetchJson<LearningResponse>("/api/console/learning", { signal }), enabled: inventoryEnabled, staleTime: 15_000, retry: false });
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const restoreFocus = useRef<HTMLElement | null>(null);
  const pendingSetting = useRef<PaletteAction | null>(null);
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
    queryKey: ["search-chats", ...scope, searchQuery],
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
        ["onboarding", "Onboarding", "Connect a model and pick a project"],
        ["connections", "Connections", "API keys and accounts"],
        ["models", "Models", "Choose which models 0 uses"],
        ["settings", "Settings", "Preferences, shortcuts, appearance"],
        ["workers", "Hosts", "Your Mac, remote servers and SSH hosts"],
        ["engagements", "Reports", "Assessment reports and handoff notes"],
        ["skills", "Skills", "Reusable agent instructions"],
        ["plugins", "Plugins", "Add and manage extensions"],
        ["learning", "Memory", "Lessons that help with future reviews"],
        ["doctor", "Diagnostics", "Check that everything works"],
        ["tools", "Tools", "What 0 can use"],
        ["project", "Project", "Target and permissions"],
        ["fix", "Fix", "Review and apply a code fix"],
      ].map(([route, label, meta]): PaletteAction => ({
        id: `control-${route}`, group: "Pages", label: label!, meta: meta!, icon: route === "settings" ? Settings : route === "workers" ? Server : SlidersHorizontal,
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
        label: "Automations",
        meta: "Edit workflows in chat and manage schedules",
        icon: PlayCircle,
        keywords: ["workflows automations schedules scheduled agents audit security review scans whitebox pentest source repository"],
        run: () => navigate("/automations"),
      },
    ];

    base.push({ id: "whitebox-code-pentest", group: "Actions", label: "Whitebox pentest", meta: "Analyze a source repository · edit the plan in chat", icon: FileSearch, keywords: ["whitebox white-box source code pentest repository security review audit"], run: () => navigate("/automations?template=repository-review") });

    base.push({ id: "web-motion", group: "Settings", label: "Reduce motion", meta: "Browser accessibility", icon: Settings, keywords: ["animations accessibility reduced motion browser"], run: () => navigate("/settings#setting-web-motion") });
    base.push({ id: "web-appearance", group: "Settings", label: "Web appearance", meta: "Light or Dark · saved in this browser", icon: Settings, keywords: ["theme appearance light dark browser"], run: () => navigate("/settings#setting-web-theme") });
    for (const theme of ["light", "dark"] as const) base.push({ id: `web-theme-${theme}`, group: "Settings", label: `Use ${theme === "light" ? "Light" : "Dark"} appearance`, meta: "This browser", icon: SlidersHorizontal, keywords: ["theme appearance browser", theme], run: () => setWebTheme(theme) });

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

    for (const group of dashboard?.groups ?? []) {
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

    for (const scan of scans ?? []) {
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

    for (const definition of settingsQuery.data?.definitions.filter(visibleWebSetting) ?? []) base.push({
      id: `setting-${definition.key}`, group: "Settings", label: settingLabel(definition), meta: definition.group, icon: Settings,
      keywords: searchKeywords(definition.key, definition.label, definition.description, "settings preferences", ...(definition.choices || [])),
      run: () => navigate(`/settings?section=${encodeURIComponent(categoryFor(definition))}#setting-${encodeURIComponent(definition.key)}`),
    });
    for (const workflow of workflowsQuery.data?.definitions ?? []) base.push({
      id: `workflow-${workflow.id}`, group: "Automations", label: workflow.name, meta: workflow.target || "Workflow", icon: PlayCircle,
      keywords: searchKeywords(workflow.id, workflow.target, workflow.instructions, "workflow automation schedules scheduled"),
      run: () => navigate(`/automations?workflow=${encodeURIComponent(workflow.id)}`),
    });
    for (const skill of skillsQuery.data?.skills ?? []) base.push({
      id: `skill-${skill.id}`, group: "Skills", label: skill.name, meta: skill.scope, icon: BookOpen,
      keywords: searchKeywords(skill.id, skill.description, "skill instructions"),
      run: () => navigate(`/skills?skill=${encodeURIComponent(skill.id)}`),
    });
    for (const plugin of pluginsQuery.data?.items.filter(item => item.kind === "plugin") ?? []) base.push({
      id: `plugin-${plugin.kind}-${plugin.id}`, group: "Plugins", label: plugin.name, meta: `${plugin.kind} · ${plugin.state}`, icon: Blocks,
      keywords: searchKeywords(plugin.id, plugin.description, ...plugin.capabilities),
      run: () => navigate("/plugins"),
    });
    for (const service of servicesQuery.data?.items ?? []) base.push({
      id: `service-${service.id}`, group: "Plugins", label: service.name, meta: service.configured ? "Connected integration" : "Integration", icon: Blocks,
      keywords: searchKeywords(service.id, service.description, service.category),
      run: () => navigate("/plugins"),
    });
    for (const memory of memoryQuery.data?.knowledge ?? []) base.push({
      id: `memory-${memory.id}`, group: "Memory", label: memory.title || memory.summary || "Saved lesson", meta: memory.status, icon: Brain,
      keywords: searchKeywords(memory.content, memory.summary, memory.target, memory.scope, memory.projectId),
      run: () => navigate("/learning"),
    });
    for (const suggestion of memoryQuery.data?.improvements ?? []) base.push({
      id: `suggestion-${suggestion.id}`, group: "Memory", label: suggestion.title || suggestion.summary || "Memory suggestion", meta: suggestion.status, icon: Brain,
      keywords: searchKeywords(suggestion.kind, suggestion.summary, suggestion.targetId),
      run: () => navigate("/learning"),
    });
    for (const event of memoryQuery.data?.events ?? []) base.push({
      id: `memory-event-${event.id}`, group: "Memory", label: event.title || event.summary || "Memory event", meta: event.outcome || event.kind, icon: Brain,
      keywords: searchKeywords(event.summary, event.target, event.kind, event.projectId),
      run: () => navigate("/learning"),
    });
    for (const backend of connection?.backends ?? []) base.push({
      id: `computer-${backend.id}`, group: "Hosts", label: backend.name, meta: `Host · ${backend.status}`, icon: Server,
      keywords: searchKeywords(backend.id, backend.transport, "worker computer engine"),
      run: () => navigate("/workers"),
    });
    for (const worker of dashboard?.workers ?? []) base.push({
      id: `worker-${worker.id}`, group: "Workflow workers", label: worker.label || worker.id, meta: worker.status, icon: Users,
      keywords: searchKeywords(worker.id, worker.host, worker.currentCaseTarget, worker.currentWorkItemTitle),
      run: () => navigate(worker.currentScanId ? `/runs/${encodeURIComponent(worker.currentScanId)}` : "/workers"),
    });

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
    dashboard?.groups, dashboard?.workers, connection?.backends, workflowsQuery.data, skillsQuery.data, pluginsQuery.data, servicesQuery.data, memoryQuery.data, settingsQuery.data,
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

  const filteredItems = useMemo(() => filterAppSearch(items, deferredQuery, mode), [deferredQuery, items, mode]);
  const inventories = [settingsQuery, workflowsQuery, skillsQuery, pluginsQuery, servicesQuery, memoryQuery];
  const inventoryLoading = inventoryEnabled && inventories.some(result => result.isPending);
  const unavailableSections = inventoryEnabled ? [settingsQuery.error && "settings", workflowsQuery.error && "automations", skillsQuery.error && "skills", pluginsQuery.error && "extensions", servicesQuery.error && "integrations", memoryQuery.error && "Memory"].filter(Boolean) : [];

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
      if (item.group === "Settings") {
        // Navigate after the dialog releases focus, so its restoration cannot
        // override the destination row's focus (including asynchronously loaded rows).
        pendingSetting.current = item;
        onOpenChange(false);
        return;
      }
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
      <DialogContent onOpenAutoFocus={() => { pendingSetting.current = null; restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => {
        event.preventDefault();
        const setting = pendingSetting.current;
        pendingSetting.current = null;
        if (setting) {
          void setting.run();
          // A repeated result may already be mounted and need no route effect.
          const row = document.getElementById(setting.id);
          row?.scrollIntoView({ block: "start" });
          row?.focus({ preventScroll: true });
          return;
        }
        const target = returnFocus?.current ?? restoreFocus.current;
        if (target?.isConnected) target.focus();
      }} className="gap-0 overflow-hidden rounded-[var(--radius-panel,16px)] p-0 sm:max-w-[720px] dark:bg-popover" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Search chats, pages, findings, automations, skills, plugins, Memory, hosts, workflow workers, settings and runs. Use the arrow keys to select a result.</DialogDescription>
        </DialogHeader>
        <CommandPrimitive value={selection} onValueChange={setSelection} shouldFilter={false} loop className="flex min-h-0 min-w-0 w-full flex-col" label="Search">
          <div className="flex items-center gap-3 px-6 py-5">
            <CommandPrimitive.Input autoFocus value={query} onValueChange={setQuery} placeholder={mode === "chats" ? "Search chats" : "Search anything…"} aria-label={mode === "chats" ? "Search chats" : "Search anything"} className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground" />
            {query && <Button variant="ghost" size="icon-sm" aria-label="Clear search" onClick={() => setQuery("")}><X className="size-3.5" /></Button>}
            <Button variant="ghost" size="icon-sm" aria-label="Close search" onClick={() => onOpenChange(false)}><X className="size-4" /></Button>
          </div>
          {onModeChange && (query.trim() || mode === "chats") && <div className="flex gap-1 px-6 pb-2" role="group" aria-label="Search in">
            {(["all", "chats"] as const).map(value => <Button key={value} variant={mode === value ? "secondary" : "ghost"} size="xs" type="button" aria-pressed={mode === value} onClick={() => onModeChange(value)} className="rounded-full">{value === "all" ? "All" : "Chats"}</Button>)}
          </div>}
          <CommandPrimitive.List className="max-h-[min(460px,60dvh)] min-w-0 w-full scroll-py-2 overflow-x-hidden overflow-y-auto px-3 pb-3" aria-label="Search results" aria-busy={openingChat || chatsLoading || inventoryLoading}>
            {GROUPS.map(group => {
              const entries = filteredItems.filter(item => item.group === group);
              if (!entries.length) return null;
              return <CommandPrimitive.Group key={group} heading={group === "Recent chats" && deferredQuery.trim() ? "Chats" : group} className="min-w-0 max-w-full [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
                {entries.map(item => <CommandPrimitive.Item key={item.id} value={item.id} disabled={openingChat} onSelect={() => void selectItem(item)} className="flex min-w-0 max-w-full cursor-pointer items-center gap-3 rounded-[var(--radius-control,8px)] px-3 py-3 text-sm outline-none transition-colors data-[selected=true]:bg-foreground/10 data-[disabled=true]:opacity-50 motion-reduce:transition-none">
                  <item.icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1"><span className="block truncate">{item.label}</span>{item.preview && <span className="mt-1 block truncate text-xs text-muted-foreground">{item.preview}</span>}</span>
                  {item.date && <span className="shrink-0 text-xs text-muted-foreground">{item.date}</span>}
                  {item.meta && item.group !== "Pages" && <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">{item.meta}</span>}
                </CommandPrimitive.Item>)}
              </CommandPrimitive.Group>;
            })}
            {(query.trim() || mode === "chats") && chatsQuery.hasNextPage && <Button variant="ghost" size="sm" type="button" className="mx-3 mt-2 rounded-[var(--radius-control,8px)] px-3 py-2 text-xs text-muted-foreground hover:bg-foreground/5 disabled:opacity-50" disabled={chatsQuery.isFetching} onClick={() => void chatsQuery.fetchNextPage()}>Show more chats</Button>}
            {chatsQuery.data?.pages.some(page => page.previewOnly) && <p className="px-3 py-2 text-xs text-muted-foreground">This engine searches chat titles and previews. Update the engine to search full conversations.</p>}
            {chatsQuery.data?.pages.some(page => page.truncated) && <p className="px-3 py-2 text-xs text-muted-foreground">Showing matches from recent chat history.</p>}
            {inventoryLoading && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Searching workspace…</p>}
            {unavailableSections.length > 0 && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Search unavailable for {unavailableSections.join(", ")}. Other results are still available.</p>}
            {chatsLoading && <LoadingState label="Loading chats…" rows={3} className="px-3 py-2" />}
            {chatsError && <p role="alert" className="px-3 py-4 text-sm text-destructive">Couldn't load chats. <Button variant="link" size="sm" type="button" className="h-auto p-0" onClick={() => { void chatsQuery.refetch(); }}>Try again</Button></p>}
            {!filteredItems.length && !chatsLoading && !inventoryLoading && !chatsError && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{deferredQuery.trim() ? "No results" : "No chats yet"}</p>}
            {openingChat && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Opening…</p>}
            {openError && <p role="alert" className="px-3 py-2 text-sm text-destructive">{openError}</p>}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}
