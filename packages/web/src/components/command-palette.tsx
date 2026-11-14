import { queryKeys } from "@/queries";
import { VOCAB, v } from "@/lib/vocabulary";
import { Skeleton } from "@/ui/components/skeleton";
import { usePersistentState } from "@/lib/use-persistent-state";
import { STORAGE_KEYS } from "@/lib/storage";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { CapyAppearanceIcon, CapyAutomationsIcon, CapyChatIcon, CapyCheckIcon, CapyCloseIcon as X, CapyComposeIcon, CapyDatabaseIcon, CapyDevicesIcon, CapyEyeIcon, CapyIssueDashedIcon, CapyPlugIcon, CapyPuzzleIcon, CapyRepositoriesIcon, CapySettingsIcon, CapyShieldIcon, CapySlidersIcon, CapySparkleFourIcon, CapySubagentsIcon, CapyThreadListIcon, CapyXCircleIcon } from "@/ui/icons/capy";
import { useHref, useLocation, useNavigate } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { setWebTheme } from "@/lib/web-theme";
import { findBlankSession } from "@/console/blank-session";
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
import { searchSettings, settingsHref, settingsPages } from "./console-control/settings-index";
import type { PluginsResponse } from "./console-control/contracts";
import type { LearningResponse } from "./learning-panel";
import { useTeamAccess } from "./team-access";
import { useSentinels } from "@/sentinels/api";
import { sentinelHref } from "@/sentinels/model";
import { filterAppSearch, footerHints, highlightParts, LOCAL_RECENT_GROUP, nextTab, parseRecents, plainPreview, pushRecent, RECENT_GROUP, searchKeywords, SEARCH_GROUPS, SEARCH_TABS, type RecentEntry, type SearchGroup, type SearchTab } from "./app-search";

type PaletteAction = {
  id: string;
  group: SearchGroup;
  label: string;
  meta: string;
  icon: React.ComponentType<{ className?: string }>;
  /** May resolve to the href that was actually opened (a saved mission resumes under a new id). */
  run: () => void | string | Promise<void | string>;
  /** Route this row opens; enables Cmd+Enter (new browser tab) and the recents list. */
  href?: string;
  keywords: string[];
  prefiltered?: boolean;
  recent?: RecentEntry;
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
  const [tab, setTab] = useState<SearchTab>(mode);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  useEffect(() => { if (open) setTab(mode); }, [open, mode]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearchQuery(query.trim()); }, 120);
    return () => window.clearTimeout(timer);
  }, [query]);
  // Each source is fetched only while its own tab is active, or on All once a term is typed.
  const sourceEnabled = (own: SearchTab) => open && (tab === own || (tab === "all" && Boolean(searchQuery)));
  const lazyList = <T,>(name: string, path: string, own: SearchTab) => ({ queryKey: ["app-search", ...scope, name], queryFn: ({ signal }: { signal: AbortSignal }) => webFetchJson<T>(path, { signal }), enabled: sourceEnabled(own), staleTime: 15_000, retry: false });
  const workflowsQuery = useQuery(lazyList<{ definitions: SecurityWorkflow[] }>("workflows", "/api/console/workflow-definitions", "automations"));
  const skillsQuery = useQuery(lazyList<{ skills: Array<{ id: string; name: string; description: string; scope: string }> }>("skills", "/api/skills", "plugins"));
  const pluginsQuery = useQuery(lazyList<PluginsResponse>("plugins", "/api/console/plugins", "plugins"));
  const servicesQuery = useQuery(lazyList<ServicePluginsResponse>("services", "/api/console/service-plugins", "plugins"));
  const memoryQuery = useQuery({ ...lazyList<LearningResponse>("memory", "/api/console/learning", "all"), enabled: open && tab === "all" && Boolean(searchQuery) });
  const sentinelsQuery = useSentinels({ enabled: sourceEnabled("sentinels"), poll: false });
  const inventoryEnabled = open && (tab !== "all" || Boolean(searchQuery));
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const restoreFocus = useRef<HTMLElement | null>(null);
  const pendingSetting = useRef<PaletteAction | null>(null);
  const [, setStoredRecents, readRecents] = usePersistentState<RecentEntry[]>(STORAGE_KEYS.paletteRecents, [], { observe: false });
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [, setDrafts] = usePersistentState<Record<string, string>>(STORAGE_KEYS.drafts, {}, { observe: false });
  useEffect(() => { if (open) setRecents(parseRecents(readRecents())); }, [open, readRecents]);
  const [selection, setSelection] = useState("");
  const [openingChat, setOpeningChat] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
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
    enabled: open && (tab === "all" || tab === "chats"),
    refetchInterval: open && !searchQuery && (tab === "all" || tab === "chats") ? 5000 : false,
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

  const settingRows = useMemo(() => {
    const term = deferredQuery.trim();
    if (!term) return tab === "settings" ? settingsPages.map(page => ({ label: page.label, meta: "Settings", href: settingsHref(page.id) })) : [];
    if (tab !== "all" && tab !== "settings") return [];
    return searchSettings(term).flatMap(group => [
      ...(group.categoryMatches ? [{ label: group.category.label, meta: "Settings", href: settingsHref(group.category.id) }] : []),
      ...group.entries.map(entry => ({ label: entry.title, meta: entry.categoryLabel, href: entry.href })),
    ]);
  }, [deferredQuery, tab]);

  const items = useMemo<PaletteAction[]>(() => {
    const base: PaletteAction[] = [
      ...WORKSPACE_DESTINATIONS.map(({ to, label, icon }): PaletteAction => ({
        id: `page-${to.slice(1)}`, group: "Pages", label, icon, href: to,
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
        href: "/chats?new=1",
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
        id: `control-${route}`, group: "Pages", href: `/${route}`, label: label!, meta: meta!, icon: route === "settings" ? CapySettingsIcon : route === "workers" ? CapyDevicesIcon : CapySlidersIcon,
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
        href: "/dashboard",
        run: () => navigate("/dashboard"),
      },
    ];

    base.push({ id: "whitebox-code-pentest", group: "Actions", label: "Whitebox pentest", meta: v("Analyze a source repository · edit the plan in {a mission}"), icon: CapyRepositoriesIcon, keywords: ["whitebox white-box source code pentest repository security review audit"], run: () => navigate("/automations?template=repository-review") });

    if (sentinelsQuery.supported && sentinelsQuery.data) {
      base.push({ id: "new-sentinel", group: "Actions", label: v("New {sentinel}"), meta: v("Create {a sentinel} from a preset"), icon: CapyShieldIcon, keywords: [v("new create {sentinel} agent watcher preset")], run: () => navigate("/sentinels?new=1") });
      for (const sentinel of sentinelsQuery.sentinels) if (sentinel.status !== "archived") base.push({
        id: `sentinel-${sentinel.id}`, group: "Sentinels", href: sentinelHref(sentinel.id), label: sentinel.name, meta: sentinel.mission || v("{Sentinel}"), icon: CapyShieldIcon,
        keywords: searchKeywords(sentinel.mission, sentinel.role, v("{sentinel} agent")), run: () => navigate(sentinelHref(sentinel.id)),
      });
    }

    base.push({ id: "web-appearance", group: "Settings", label: "Web appearance", meta: "System, Light or Dark · saved in this browser", icon: CapyAppearanceIcon, keywords: ["theme appearance light dark browser"], run: () => navigate("/settings#setting-web-theme") });
    for (const theme of ["system", "light", "dark"] as const) base.push({ id: `web-theme-${theme}`, group: "Settings", label: `Use ${theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"} appearance`, meta: "This browser", icon: CapyAppearanceIcon, keywords: ["theme appearance browser", theme], run: () => setWebTheme(theme) });

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
        href: `/findings/${group.fingerprint}`,
        run: () => navigate(`/findings/${group.fingerprint}`),
      });
    }

    for (const row of settingRows) base.push({
      id: `setting-${row.href}`, group: "Settings", label: row.label, meta: row.meta, icon: CapySettingsIcon, href: row.href, keywords: [], prefiltered: true,
      run: () => navigate(row.href),
    });
    for (const workflow of workflowsQuery.data?.definitions ?? []) base.push({
      id: `workflow-${workflow.id}`, group: "Automations", href: `/automations?workflow=${encodeURIComponent(workflow.id)}`, label: workflow.name, meta: workflow.target || "Automation", icon: CapyAutomationsIcon,
      keywords: searchKeywords(workflow.id, workflow.target, workflow.instructions, "automation workflow schedules scheduled"),
      run: () => navigate(`/automations?workflow=${encodeURIComponent(workflow.id)}`),
    });
    for (const skill of skillsQuery.data?.skills ?? []) base.push({
      id: `skill-${skill.id}`, group: "Skills", href: `/plugins/skills?skill=${encodeURIComponent(skill.id)}`, label: skill.name, meta: skill.scope, icon: CapySparkleFourIcon,
      keywords: searchKeywords(skill.id, skill.description, "skill instructions"),
      run: () => navigate(`/plugins/skills?skill=${encodeURIComponent(skill.id)}`),
    });
    for (const plugin of pluginsQuery.data?.items.filter(item => item.kind === "plugin") ?? []) base.push({
      id: `plugin-${plugin.kind}-${plugin.id}`, group: "Plugins", href: "/plugins", label: plugin.name, meta: `Tool plugin · ${plugin.state}`, icon: CapyPlugIcon,
      keywords: searchKeywords(plugin.id, plugin.description, ...plugin.capabilities),
      run: () => navigate("/plugins"),
    });
    for (const service of servicesQuery.data?.items ?? []) base.push({
      id: `service-${service.id}`, group: "Plugins", href: "/plugins", label: service.name, meta: service.configured ? "MCP server · connected" : "MCP server", icon: CapyPuzzleIcon,
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
    // Without a term, All leads with the locally remembered recents instead of the server's list.
    const recent = tab === "all" && !searchQuery && recents.length ? [] : searchQuery || tab === "chats" ? results : results.filter(session => !session.archived).slice(0, 6);
    const chats: PaletteAction[] = recent.map(session => ({
      id: `chat-${session.source}-${session.id}`, group: v("Recent {missions}"), label: session.title,
      meta: session.archived ? "Archived" : "", icon: CapyThreadListIcon,
      keywords: [session.title, session.preview],
      preview: searchQuery ? plainPreview(session.preview) || undefined : undefined,
      date: searchQuery ? new Date(session.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined,
      href: session.source === "live" ? `/chats/${session.id}` : undefined,
      run: session.source === "live" ? () => navigate(`/chats/${session.id}`) : async () => { const resumed = await resumeConsoleSession(session.id); navigate(`/chats/${resumed.id}`); return `/chats/${resumed.id}`; },
    }));
    const remembered: PaletteAction[] = tab === "all" && !searchQuery ? recents.map(entry => ({
      id: `recent-${entry.id}`, group: LOCAL_RECENT_GROUP, label: entry.label, meta: entry.kind === "mission" ? v("{Mission}") : "Page",
      icon: entry.kind === "mission" ? CapyThreadListIcon : CapyChatIcon, href: entry.href, keywords: [], recent: entry, run: () => navigate(entry.href),
    })) : [];
    return [...remembered, ...chats, ...base];
  }, [
    chatsQuery.data, searchQuery, query, tab, recents, settingRows, resumeConsoleSession,
    dashboard?.groups, dashboard?.workers, connection?.backends, workflowsQuery.data, sentinelsQuery.supported, sentinelsQuery.data, skillsQuery.data, pluginsQuery.data, servicesQuery.data, memoryQuery.data, sentinelsQuery.sentinels,
    navigate,
    queryClient,
    selectedFingerprint,
    selectedFamilyQuery.data?.latest.triageNote,
    location.pathname,
    selectedFamilyQuery.data?.latest.id,
    triageMutation,
  ]);

  const filteredItems = useMemo(() => filterAppSearch(items, deferredQuery, tab), [deferredQuery, items, tab]);
  const inventories = [workflowsQuery, skillsQuery, pluginsQuery, servicesQuery, memoryQuery];
  const inventoryLoading = inventories.some(result => result.isFetching && !result.data) || (sentinelsQuery.isFetching && !sentinelsQuery.data);
  const unavailableSections = inventoryEnabled ? [workflowsQuery.error && "automations", skillsQuery.error && "skills", pluginsQuery.error && "plugins", servicesQuery.error && "integrations", memoryQuery.error && "Memory"].filter(Boolean) : [];

  const orderedItems = useMemo(() => GROUPS.flatMap(group => filteredItems.filter(item => item.group === group)), [filteredItems]);
  const firstResult = orderedItems[0]?.id ?? "";
  useEffect(() => { setSelection(firstResult); }, [firstResult, deferredQuery, tab, open]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setOpenError(null);
      setSearchQuery("");
    }
  }, [open]);
  const selected = orderedItems.find(item => item.id === selection);
  // cmdk highlights the row but does not point the combobox at it, so mirror that for assistive tech.
  useEffect(() => {
    if (!open) return;
    const input = document.querySelector("[cmdk-input]");
    const row = document.querySelector("[cmdk-item][data-selected='true']");
    if (row?.id) input?.setAttribute("aria-activedescendant", row.id); else input?.removeAttribute("aria-activedescendant");
  }, [selection, orderedItems, open]);
  const newTabHref = useHref(selected?.href ?? "/");
  const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

  function remember(item: PaletteAction, opened?: string) {
    const href = opened ?? item.href;
    const entry = item.recent ?? (href && item.group !== "Actions" ? { id: item.id, kind: item.group === RECENT_GROUP ? "mission" as const : "page" as const, label: item.label, href } : null);
    if (entry) setStoredRecents(previous => pushRecent(parseRecents(previous), entry));
  }
  function chooseTab(next: SearchTab) {
    setTab(next);
    if (next === "all" || next === "chats") onModeChange?.(next);
  }
  async function startMissionFromQuery() {
    const text = query.trim();
    if (!text) return;
    // Home reuses an existing blank mission, so the draft goes where its composer will read it.
    let target = "new";
    try { target = findBlankSession(await listConsoleSessions(), undefined, team.enabled)?.id ?? "new"; } catch { /* no host answer: fall back to the fresh-Home draft */ }
    setDrafts(previous => ({ ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}), [`${target}:root`]: text }));
    onOpenChange(false);
    navigate(target === "new" ? "/chats?new=1" : `/chats/${target}`);
  }
  function openInNewTab(item: PaletteAction) {
    const link = document.createElement("a");
    link.href = newTabHref; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.click();
    remember(item);
    onOpenChange(false);
  }
  function onPaletteKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Keep focus inside the dialog; with text it becomes a new mission.
      event.preventDefault();
      void startMissionFromQuery();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && input) {
      // Arrows keep editing the text; they switch tab only when the caret has nowhere to go.
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      if (event.key === "ArrowLeft" ? atStart : atEnd) { event.preventDefault(); chooseTab(nextTab(tab, event.key === "ArrowRight" ? 1 : -1)); }
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (selected?.href) openInNewTab(selected);
    }
  }

  async function selectItem(item: PaletteAction) {
    if (openingChat) return;
    setOpenError(null);
    setOpeningChat(true);
    try {
      if (item.group === "Settings") {
        // Navigate after the dialog releases focus, so its restoration cannot
        // override the destination row's focus (including asynchronously loaded rows).
        pendingSetting.current = item;
        remember(item);
        onOpenChange(false);
        return;
      }
      const opened = await item.run();
      remember(item, typeof opened === "string" ? opened : undefined);
      onOpenChange(false);
    } catch (error) {
      setOpenError(errorText(error, v("Couldn't open this {mission}. Try again.")));
    } finally { setOpeningChat(false); }
  }
  const chatsActive = tab === "all" || tab === "chats";
  const chatsLoading = chatsActive && !(tab === "all" && !searchQuery && recents.length > 0) && (chatsQuery.isPending || searchQuery !== query.trim());
  const chatsError = chatsActive ? chatsQuery.error : null;
  const loading = chatsLoading || inventoryLoading;
  const hints = footerHints({ hasSelection: Boolean(selected), canOpenInTab: Boolean(selected?.href), hasQuery: Boolean(query.trim()), mod: isMac ? "⌘" : "Ctrl+" });
  const emptyText = deferredQuery.trim() ? "No results" : tab === "chats" || tab === "all" ? v("No {missions} yet") : `Nothing in ${SEARCH_TABS.find(entry => entry.id === tab)?.label.toLowerCase()} yet.`;
  const headingFor = (group: SearchGroup) => group === RECENT_GROUP && deferredQuery.trim() ? v("{Missions}") : group;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Anchor the input while asynchronous results change the dialog height. Phones get a full-width sheet. */}
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
      }} className="gap-0 overflow-hidden rounded-[var(--radius-panel,12px)] p-0 sm:max-w-[720px] dark:bg-popover max-sm:top-0! max-sm:left-0! max-sm:[translate:0_0]! max-sm:max-h-dvh! max-sm:w-full max-sm:max-w-full max-sm:rounded-t-none" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>{v("Search {missions}, pages, findings, automations, skills, plugins, Memory, hosts, engines, settings and runs. Use the arrow keys to select a result.")}</DialogDescription>
        </DialogHeader>
        <CommandPrimitive value={selection} onValueChange={setSelection} onKeyDown={onPaletteKeyDown} shouldFilter={false} loop className="flex min-h-0 min-w-0 w-full flex-col" label="Search">
          <div className="flex h-11 shrink-0 items-center gap-2.5 px-4">
            <CommandPrimitive.Input autoFocus value={query} onValueChange={setQuery} placeholder={tab === "chats" ? v("Search {missions}") : "Search anything…"} aria-label={tab === "chats" ? v("Search {missions}") : "Search anything"} className="min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:outline-none placeholder:text-muted-foreground" />
            {query && <Button variant="ghost" size="icon-sm" aria-label="Clear search" onClick={() => setQuery("")}><X className="size-3.5" /></Button>}
          </div>
          <div role="tablist" aria-label="Search in" className="no-scrollbar scroll-fade-x flex shrink-0 gap-1 overflow-x-auto px-4 pb-2">
            {SEARCH_TABS.map(entry => <Button key={entry.id} role="tab" aria-selected={tab === entry.id} tabIndex={-1} variant={tab === entry.id ? "secondary" : "ghost"} size="xs" type="button" onMouseDown={event => event.preventDefault()} onClick={() => chooseTab(entry.id)} className="shrink-0 rounded-full">{entry.label}</Button>)}
          </div>
          <CommandPrimitive.List className={`max-h-[min(460px,60dvh)] min-w-0 w-full scroll-py-2 scroll-fade-y overflow-x-hidden overflow-y-auto px-2 pb-2 max-sm:max-h-[calc(100dvh-8.5rem)] ${loading && !orderedItems.length ? "min-h-32" : ""}`} aria-label="Search results" aria-busy={openingChat || loading}>
            {GROUPS.map(group => {
              const entries = filteredItems.filter(item => item.group === group);
              if (!entries.length) return null;
              return <CommandPrimitive.Group key={group} heading={headingFor(group)} className="min-w-0 max-w-full [&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-7 [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground-2">
                {entries.map(item => <CommandPrimitive.Item key={item.id} value={item.id} disabled={openingChat} onSelect={() => void selectItem(item)} className="flex min-w-0 max-w-full cursor-pointer items-center gap-2.5 min-h-7 py-1 rounded-[var(--radius-overlay,8px)] px-2.5 text-sm font-normal outline-none transition-colors data-[selected=true]:bg-[var(--popover-hover)] data-[disabled=true]:opacity-50 motion-reduce:transition-none">
                  <item.icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1"><span className="block truncate leading-5">{highlightParts(item.label, deferredQuery).map((part, index) => part.match ? <strong key={index} className="font-semibold">{part.text}</strong> : part.text)}</span>{item.preview && <span className="block truncate text-xs text-muted-foreground">{item.preview}</span>}</span>
                  {item.date && <span className="shrink-0 text-xs text-muted-foreground">{item.date}</span>}
                  {item.meta && item.group !== "Pages" && <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">{item.meta}</span>}
                </CommandPrimitive.Item>)}
              </CommandPrimitive.Group>;
            })}
            {chatsActive && (query.trim() || tab === "chats") && chatsQuery.hasNextPage && <Button variant="ghost" size="sm" type="button" className="mx-3 mt-2 rounded-[var(--radius-control,8px)] px-3 py-2 text-xs text-muted-foreground hover:bg-foreground/5 disabled:opacity-50" disabled={chatsQuery.isFetching} onClick={() => void chatsQuery.fetchNextPage()}>{v("Show more {missions}")}</Button>}
            {chatsActive && chatsQuery.data?.pages.some(page => page.previewOnly) && <p className="px-3 py-2 text-xs text-muted-foreground">{v("This engine searches {mission} titles and previews. Update the engine to search full {missions}.")}</p>}
            {chatsActive && chatsQuery.data?.pages.some(page => page.truncated) && <p className="px-3 py-2 text-xs text-muted-foreground">{v("Showing matches from recent {mission} history.")}</p>}
            {loading && !orderedItems.length && <div aria-hidden="true" className="space-y-0.5 px-2 pt-1">{[0, 1, 2, 3].map(row => <Skeleton key={row} className="h-7 w-full" />)}</div>}
            {loading && <p role="status" className="sr-only">Searching…</p>}
            {unavailableSections.length > 0 && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Search unavailable for {unavailableSections.join(", ")}. Other results are still available.</p>}
            {chatsError && <p role="alert" className="px-3 py-4 text-sm text-destructive">{v("Couldn't load {missions}. ")}<Button variant="link" size="sm" type="button" className="h-auto p-0" onClick={() => { void chatsQuery.refetch(); }}>Try again</Button></p>}
            {!filteredItems.length && !loading && !chatsError && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>}
            {openingChat && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Opening…</p>}
            {openError && <p role="alert" className="px-3 py-2 text-sm text-destructive">{openError}</p>}
          </CommandPrimitive.List>
        </CommandPrimitive>
        <div data-slot="palette-footer" className="flex h-10 shrink-0 items-center gap-4 overflow-hidden border-t-[0.5px] border-border-1 px-3 text-xs text-muted-foreground-1">
          {hints.map((hint, index) => <span key={hint.keys} className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap ${index === hints.length - 1 ? "ml-auto" : ""} ${hint.keys === "←/→" || hint.keys === "Tab" || hint.keys.endsWith("↵") && hint.keys !== "↵" ? "max-sm:hidden" : ""}`}><Kbd>{hint.keys}</Kbd>{hint.label}</span>)}
        </div>
      </DialogContent>
    </Dialog>
  );
}
