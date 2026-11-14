import { queryKeys } from "@/queries";
import { VOCAB, v } from "@/lib/vocabulary";
import { LoadingState } from "@/components/state-panel";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { CapyAppearanceIcon, CapyAutomationsIcon, CapyChatIcon, CapyCheckIcon, CapyCloseIcon as X, CapyComposeIcon, CapyDatabaseIcon, CapyDevicesIcon, CapyEyeIcon, CapyIssueDashedIcon, CapyPlugIcon, CapyPuzzleIcon, CapyRepositoriesIcon, CapySettingsIcon, CapyShieldIcon, CapySlidersIcon, CapySparkleFourIcon, CapySubagentsIcon, CapyThreadListIcon, CapyXCircleIcon } from "@/ui/icons/capy";
import { useLocation, useNavigate } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { setWebTheme } from "@/lib/web-theme";
import { resolveSessionAlias } from "@/console/session-recovery";
import { WORKSPACE_DESTINATIONS } from "@/lib/workspace-navigation";
import { useBackendApi } from "@/api";
import { useBackendSelection } from "@/backend-context";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/ui/components/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { DashboardResponse, ScanRecord } from "@/types";
import type { SecurityWorkflow, ServicePluginsResponse } from "@0/engine/shared";
import { visibleWebSetting, categoryFor, settingLabel } from "./console-control/settings-control";
import type { PluginsResponse, SettingsResponse } from "./console-control/contracts";
import type { LearningResponse } from "./learning-panel";
import { useTeamAccess } from "./team-access";
import { useSentinels } from "@/sentinels/api";
import { sentinelHref } from "@/sentinels/model";
import { filterAppSearch, plainPreview, searchKeywords, SEARCH_GROUPS, type SearchGroup } from "./app-search";

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

export { openAppSearch, type SearchMode, type SearchRequest } from "./search-events";
import type { SearchMode } from "./search-events";
import { errorText } from "@/lib/api-error";

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
  const sentinelsQuery = useSentinels({ enabled: inventoryEnabled, poll: false });
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
        if (!response.ok) throw new Error(`Couldn't search ${VOCAB.mission.plural} (${response.status}).`);
        if (!response.headers.get("content-type")?.includes("json")) throw new Error("The engine returned an unexpected search response.");
        const page = await response.json() as ChatSearchPage;
        signal.throwIfAborted(); client.signal.throwIfAborted();
        return page;
      }
      // Older engines have history lists but no conversational search endpoint.
      const [sessions, saved] = await Promise.all([listConsoleSessions(signal), listSavedConsoleSessions(signal)]);
      const live = sessions.slice(0, 1000).filter(session => session.status !== "closed" && ((session.messageCount ?? 0) > 0 || session.status !== "ready"));
      const activeIds = new Set(live.flatMap(session => [session.id, ...(session.savedId ? [session.savedId] : [])]));
      const results: ChatSearchResult[] = live.map(session => ({ id: session.id, title: session.title || session.target || v("Untitled {mission}"), preview: session.target || "", updatedAt: session.updatedAt, archived: false, source: "live" }));
      results.push(...saved.slice(0, 1000).filter(session => !activeIds.has(session.id) && session.messageCount > 0).map(session => ({ id: session.id, title: session.summary || session.target || session.preview || v("Past {mission}"), preview: session.preview, updatedAt: new Date(session.savedAt).toISOString(), archived: Boolean(session.archived), source: "saved" as const })));
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

  const selectedFamilyQuery = useQuery({
    queryKey: queryKeys.findingFamily(client.backendId, selectedFingerprint),
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
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.findingFamily(client.backendId, selectedFingerprint) }),
      ]);
    },
  });

  const items = useMemo<PaletteAction[]>(() => {
    const base: PaletteAction[] = [
      ...WORKSPACE_DESTINATIONS.map(({ to, label, icon }): PaletteAction => ({
        id: `page-${to.slice(1)}`, group: "Pages", label, icon,
        meta: to === "/automations" ? "Edit automations and manage schedules" : `Open ${label.toLowerCase()}`,
        keywords: [label, to.slice(1), ...(to === "/automations" ? ["automations workflows schedules audit"] : [])],
        run: () => {
          const sessionId = resolveSessionAlias(location.pathname.match(/^\/(?:console|chats)\/(?!saved\/)([^/]+)/)?.[1]);
          navigate(`${to}${sessionId && to === "/settings" ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(location.pathname)}` : ""}`);
        },
      })),
      {
        id: "new-console",
        group: "Actions",
        label: v("New {mission}"),
        meta: v("Start a new {mission}"),
        icon: CapyComposeIcon,
        keywords: [v("new {mission} chat conversation scan session")],
        run: () => navigate("/chats?new=1"),
      },
      ...[
        ["onboarding", "Onboarding", "Connect a model and pick a project"],
        ["connections", "Connections", "API keys and accounts"],
        ["models", "Models", "Choose which models 0 uses"],
        ["engagements", "Reports", "Assessment reports and handoff notes"],
        ["doctor", "Diagnostics", "Check that everything works"],
        ["tools", "Tools", "What 0 can use"],
        ["project", "Project", "Target and permissions"],
        ["fix", "Fix", "Review and apply a code fix"],
      ].map(([route, label, meta]): PaletteAction => ({
        id: `control-${route}`, group: "Pages", label: label!, meta: meta!, icon: route === "settings" ? CapySettingsIcon : route === "workers" ? CapyDevicesIcon : CapySlidersIcon,
        keywords: [route!, label!],
        run: () => {
          const sessionId = resolveSessionAlias(location.pathname.match(/^\/(?:console|chats)\/(?!saved\/)([^/]+)/)?.[1]);
          navigate(`/${route}${sessionId ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(location.pathname)}` : ""}`);
        },
      })),
      {
        id: "page-control",
        group: "Pages",
        label: "Overview",
        meta: "What 0 is doing",
        icon: CapyThreadListIcon,
        keywords: ["operations dashboard overview workers queue"],
        run: () => navigate("/dashboard"),
      },
    ];

    base.push({ id: "whitebox-code-pentest", group: "Actions", label: "Whitebox pentest", meta: v("Analyze a source repository · edit the plan in {a mission}"), icon: CapyRepositoriesIcon, keywords: ["whitebox white-box source code pentest repository security review audit"], run: () => navigate("/automations?template=repository-review") });

    if (sentinelsQuery.supported && sentinelsQuery.data) {
      base.push({ id: "new-sentinel", group: "Actions", label: v("New {sentinel}"), meta: v("Create {a sentinel} from a preset"), icon: CapyShieldIcon, keywords: [v("new create {sentinel} agent watcher preset")], run: () => navigate("/sentinels?new=1") });
      for (const sentinel of sentinelsQuery.sentinels) if (sentinel.status !== "archived") base.push({
        id: `sentinel-${sentinel.id}`, group: "Sentinels", label: sentinel.name, meta: sentinel.mission || v("{Sentinel}"), icon: CapyShieldIcon,
        keywords: searchKeywords(sentinel.mission, sentinel.role, v("{sentinel} agent")), run: () => navigate(sentinelHref(sentinel.id)),
      });
    }

    base.push({ id: "web-appearance", group: "Settings", label: "Web appearance", meta: "Light or Dark · saved in this browser", icon: CapyAppearanceIcon, keywords: ["theme appearance light dark browser"], run: () => navigate("/settings#setting-web-theme") });
    for (const theme of ["light", "dark"] as const) base.push({ id: `web-theme-${theme}`, group: "Settings", label: `Use ${theme === "light" ? "Light" : "Dark"} appearance`, meta: "This browser", icon: CapyAppearanceIcon, keywords: ["theme appearance browser", theme], run: () => setWebTheme(theme) });

    const selectedFindingId = selectedFamilyQuery.data?.latest.id;
    if (selectedFindingId) {
      base.unshift(
        {
          id: "finding-console",
          group: "Actions",
          label: "Investigate this finding",
          meta: v("Open it in a new {mission}"),
          icon: CapyChatIcon,
          keywords: [v("finding investigate console {mission} chat focus evidence")],
          run: () => navigate(`/chats?finding=${encodeURIComponent(selectedFindingId)}&intent=investigate`),
        },
        {
          id: "finding-impact",
          group: "Actions",
          label: "View impact",
          meta: "See how serious this finding is",
          icon: CapyEyeIcon,
          keywords: ["finding impact assessment stored"],
          run: () => navigate(`/chats?finding=${encodeURIComponent(selectedFindingId)}&intent=impact`),
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
          icon: CapyCheckIcon,
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
          icon: CapyXCircleIcon,
          keywords: ["suppress finding triage"],
          run: () => triageMutation.mutate({
            triageStatus: "suppressed",
            triageNote: selectedFamilyQuery.data?.latest.triageNote ?? "",
          }),
        },
      );
    }

    for (const group of dashboard?.groups ?? []) {
      base.push({
        id: `finding-${group.fingerprint}`,
        group: "Findings",
        label: group.latest.title,
        meta: `${group.latest.severity} · ${group.latest.triageStatus}`,
        icon: CapyIssueDashedIcon,
        keywords: [group.latest.title, group.latest.category, group.latest.severity, group.latest.triageStatus],
        run: () => navigate(`/findings/${group.fingerprint}`),
      });
    }

    for (const definition of settingsQuery.data?.definitions.filter(visibleWebSetting) ?? []) base.push({
      id: `setting-${definition.key}`, group: "Settings", label: settingLabel(definition), meta: definition.group, icon: CapySettingsIcon,
      keywords: searchKeywords(definition.key, definition.label, definition.description, "settings preferences", ...(definition.choices || [])),
      run: () => navigate(`/settings?section=${encodeURIComponent(categoryFor(definition))}#setting-${encodeURIComponent(definition.key)}`),
    });
    for (const workflow of workflowsQuery.data?.definitions ?? []) base.push({
      id: `workflow-${workflow.id}`, group: "Automations", label: workflow.name, meta: workflow.target || "Automation", icon: CapyAutomationsIcon,
      keywords: searchKeywords(workflow.id, workflow.target, workflow.instructions, "automation workflow schedules scheduled"),
      run: () => navigate(`/automations?workflow=${encodeURIComponent(workflow.id)}`),
    });
    for (const skill of skillsQuery.data?.skills ?? []) base.push({
      id: `skill-${skill.id}`, group: "Skills", label: skill.name, meta: skill.scope, icon: CapySparkleFourIcon,
      keywords: searchKeywords(skill.id, skill.description, "skill instructions"),
      run: () => navigate(`/plugins/skills?skill=${encodeURIComponent(skill.id)}`),
    });
    for (const plugin of pluginsQuery.data?.items.filter(item => item.kind === "plugin") ?? []) base.push({
      id: `plugin-${plugin.kind}-${plugin.id}`, group: "Plugins", label: plugin.name, meta: `Tool plugin · ${plugin.state}`, icon: CapyPlugIcon,
      keywords: searchKeywords(plugin.id, plugin.description, ...plugin.capabilities),
      run: () => navigate("/plugins"),
    });
    for (const service of servicesQuery.data?.items ?? []) base.push({
      id: `service-${service.id}`, group: "Plugins", label: service.name, meta: service.configured ? "MCP server · connected" : "MCP server", icon: CapyPuzzleIcon,
      keywords: searchKeywords(service.id, service.description, service.category),
      run: () => navigate("/plugins"),
    });
    for (const memory of memoryQuery.data?.knowledge ?? []) base.push({
      id: `memory-${memory.id}`, group: "Memory", label: memory.title || memory.summary || "Saved lesson", meta: memory.status, icon: CapyDatabaseIcon,
      keywords: searchKeywords(memory.content, memory.summary, memory.target, memory.scope, memory.projectId),
      run: () => navigate("/learning"),
    });
    for (const suggestion of memoryQuery.data?.improvements ?? []) base.push({
      id: `suggestion-${suggestion.id}`, group: "Memory", label: suggestion.title || suggestion.summary || "Memory suggestion", meta: suggestion.status, icon: CapyDatabaseIcon,
      keywords: searchKeywords(suggestion.kind, suggestion.summary, suggestion.targetId),
      run: () => navigate("/learning"),
    });
    for (const event of memoryQuery.data?.events ?? []) base.push({
      id: `memory-event-${event.id}`, group: "Memory", label: event.title || event.summary || "Memory event", meta: event.outcome || event.kind, icon: CapyDatabaseIcon,
      keywords: searchKeywords(event.summary, event.target, event.kind, event.projectId),
      run: () => navigate("/learning"),
    });
    for (const backend of connection?.backends ?? []) base.push({
      id: `computer-${backend.id}`, group: "Hosts", label: backend.name, meta: `Host · ${backend.status}`, icon: CapyDevicesIcon,
      keywords: searchKeywords(backend.id, backend.transport, "worker computer engine"),
      run: () => navigate("/engines"),
    });
    for (const worker of dashboard?.workers ?? []) base.push({
      id: `worker-${worker.id}`, group: "Engines", label: worker.label || worker.id, meta: worker.status, icon: CapySubagentsIcon,
      keywords: searchKeywords(worker.id, worker.host, worker.currentCaseTarget, worker.currentWorkItemTitle),
      run: () => navigate("/engines"),
    });

    const results = query.trim() === searchQuery ? chatsQuery.data?.pages.flatMap(page => page.results) ?? [] : [];
    const recent = searchQuery || mode === "chats" ? results : results.filter(session => !session.archived).slice(0, 6);
    const chats: PaletteAction[] = recent.map(session => ({
      id: `chat-${session.source}-${session.id}`, group: v("Recent {missions}"), label: session.title,
      meta: session.archived ? "Archived" : "", icon: CapyThreadListIcon,
      keywords: [session.title, session.preview],
      preview: searchQuery ? plainPreview(session.preview) || undefined : undefined,
      date: searchQuery ? new Date(session.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined,
      run: session.source === "live" ? () => navigate(`/chats/${session.id}`) : async () => { const resumed = await resumeConsoleSession(session.id); navigate(`/chats/${resumed.id}`); },
    }));
    return [...chats, ...base];
  }, [
    chatsQuery.data, searchQuery, query, mode, resumeConsoleSession,
    dashboard?.groups, dashboard?.workers, connection?.backends, workflowsQuery.data, sentinelsQuery.supported, sentinelsQuery.data, skillsQuery.data, pluginsQuery.data, servicesQuery.data, memoryQuery.data, settingsQuery.data,
    navigate,
    queryClient,
    selectedFingerprint,
    selectedFamilyQuery.data?.latest.triageNote,
    location.pathname,
    selectedFamilyQuery.data?.latest.id,
    triageMutation,
  ]);

  const filteredItems = useMemo(() => filterAppSearch(items, deferredQuery, mode), [deferredQuery, items, mode]);
  const inventories = [settingsQuery, workflowsQuery, skillsQuery, pluginsQuery, servicesQuery, memoryQuery];
  const inventoryLoading = inventoryEnabled && inventories.some(result => result.isPending);
  const unavailableSections = inventoryEnabled ? [settingsQuery.error && "settings", workflowsQuery.error && "automations", skillsQuery.error && "skills", pluginsQuery.error && "plugins", servicesQuery.error && "integrations", memoryQuery.error && "Memory"].filter(Boolean) : [];

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
      setOpenError(errorText(error, v("Couldn't open this {mission}. Try again.")));
    } finally { setOpeningChat(false); }
  }
  const chatsLoading = chatsQuery.isPending || searchQuery !== query.trim();
  const chatsError = chatsQuery.error;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Anchor the input while asynchronous results change the dialog height. */}
      <DialogContent overlayClassName="bg-transparent" style={{ top: "15dvh", translate: "-50% 0", maxHeight: "calc(100dvh - 15dvh - 1rem)" }} onOpenAutoFocus={() => { pendingSetting.current = null; restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => {
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
      }} className="gap-0 overflow-hidden rounded-[var(--radius-panel,12px)] p-0 sm:max-w-[720px] dark:bg-popover" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>{v("Search {missions}, pages, findings, automations, skills, plugins, Memory, hosts, engines, settings and runs. Use the arrow keys to select a result.")}</DialogDescription>
        </DialogHeader>
        <CommandPrimitive value={selection} onValueChange={setSelection} shouldFilter={false} loop className="flex min-h-0 min-w-0 w-full flex-col" label="Search">
          <div className="flex h-11 shrink-0 items-center gap-2.5 px-4">
            <CommandPrimitive.Input autoFocus value={query} onValueChange={setQuery} placeholder={mode === "chats" ? v("Search {missions}") : "Search anything…"} aria-label={mode === "chats" ? v("Search {missions}") : "Search anything"} className="min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:outline-none placeholder:text-muted-foreground" />
            {query && <Button variant="ghost" size="icon-sm" aria-label="Clear search" onClick={() => setQuery("")}><X className="size-3.5" /></Button>}
          </div>
          {onModeChange && <div className="flex gap-1 px-4 pb-2" role="group" aria-label="Search in">
            {(["all", "chats"] as const).map(value => <Button key={value} variant={mode === value ? "secondary" : "ghost"} size="xs" type="button" aria-pressed={mode === value} onClick={() => onModeChange(value)} className="rounded-full">{value === "all" ? "All" : v("{Missions}")}</Button>)}
          </div>}
          <CommandPrimitive.List className="max-h-[min(460px,60dvh)] min-w-0 w-full scroll-py-2 scroll-fade-y overflow-x-hidden overflow-y-auto px-2 pb-2" aria-label="Search results" aria-busy={openingChat || chatsLoading || inventoryLoading}>
            {GROUPS.map(group => {
              const entries = filteredItems.filter(item => item.group === group);
              if (!entries.length) return null;
              return <CommandPrimitive.Group key={group} heading={group === v("Recent {missions}") && deferredQuery.trim() ? v("{Missions}") : group} className="min-w-0 max-w-full [&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-7 [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground-2">
                {entries.map(item => <CommandPrimitive.Item key={item.id} value={item.id} disabled={openingChat} onSelect={() => void selectItem(item)} className="flex min-w-0 max-w-full cursor-pointer items-center gap-2.5 min-h-7 py-1 rounded-[var(--radius-overlay,8px)] px-2.5 text-sm font-normal outline-none transition-colors data-[selected=true]:bg-[var(--popover-hover)] data-[disabled=true]:opacity-50 motion-reduce:transition-none">
                  <item.icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1"><span className="block truncate leading-5">{item.label}</span>{item.preview && <span className="block truncate text-xs text-muted-foreground">{item.preview}</span>}</span>
                  {item.date && <span className="shrink-0 text-xs text-muted-foreground">{item.date}</span>}
                  {item.meta && item.group !== "Pages" && <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">{item.meta}</span>}
                </CommandPrimitive.Item>)}
              </CommandPrimitive.Group>;
            })}
            {(query.trim() || mode === "chats") && chatsQuery.hasNextPage && <Button variant="ghost" size="sm" type="button" className="mx-3 mt-2 rounded-[var(--radius-control,8px)] px-3 py-2 text-xs text-muted-foreground hover:bg-foreground/5 disabled:opacity-50" disabled={chatsQuery.isFetching} onClick={() => void chatsQuery.fetchNextPage()}>{v("Show more {missions}")}</Button>}
            {chatsQuery.data?.pages.some(page => page.previewOnly) && <p className="px-3 py-2 text-xs text-muted-foreground">{v("This engine searches {mission} titles and previews. Update the engine to search full {missions}.")}</p>}
            {chatsQuery.data?.pages.some(page => page.truncated) && <p className="px-3 py-2 text-xs text-muted-foreground">{v("Showing matches from recent {mission} history.")}</p>}
            {inventoryLoading && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Searching workspace…</p>}
            {unavailableSections.length > 0 && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Search unavailable for {unavailableSections.join(", ")}. Other results are still available.</p>}
            {chatsLoading && <LoadingState label={v("Loading {missions}…")} rows={3} className="px-3 py-2" />}
            {chatsError && <p role="alert" className="px-3 py-4 text-sm text-destructive">{v("Couldn't load {missions}. ")}<Button variant="link" size="sm" type="button" className="h-auto p-0" onClick={() => { void chatsQuery.refetch(); }}>Try again</Button></p>}
            {!filteredItems.length && !chatsLoading && !inventoryLoading && !chatsError && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{deferredQuery.trim() ? "No results" : v("No {missions} yet")}</p>}
            {openingChat && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Opening…</p>}
            {openError && <p role="alert" className="px-3 py-2 text-sm text-destructive">{openError}</p>}
          </CommandPrimitive.List>
        </CommandPrimitive>
        <div data-slot="palette-footer" className="flex h-10 shrink-0 items-center gap-4 border-t-[0.5px] border-border-1 px-3 text-xs text-muted-foreground-1">
          <span className="flex items-center gap-1.5"><Kbd>↵</Kbd>Open</span>
          <span className="flex items-center gap-1.5"><Kbd>↑↓</Kbd>Navigate</span>
          <span className="ml-auto flex items-center gap-1.5"><Kbd>esc</Kbd>Close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
