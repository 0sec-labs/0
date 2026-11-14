import { queryKeys } from "@/queries";
import { pollInterval } from "@/lib/polling";
import { v } from "@/lib/vocabulary";
import { Suspense, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { AppShell } from "@/components/app-shell";
import type { SearchMode, SearchRequest } from "@/components/search-events";
import { ConversationSkeleton } from "@/console/loading-state";
import { DashboardPanelProvider } from "@/components/dashboard-panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { Button } from "@/components/ui/button";
import {
  CommandPalette, ConsolePage, EngagementsPage, FindingsApiAccessPage, FindingsPage, LearningPage, PageFallback, ReportPage, SavedConversationPage,
  SentinelPage, SentinelsPage, SkillsPage, TeamSettingsPage, WebConsoleControlsPage, WorkersPage, WorkflowsPage, useRoutePrefetch,
} from "@/pages/lazy-pages";
import { canonicalWorkspacePath } from "@/lib/workspace-navigation";

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable));
}

export function OperationsApp() {
  const { client, getDashboard, getScans } = useBackendApi();
  const location = useLocation();
  useRoutePrefetch();
  const operationsVisible = /^\/(?:operations|threads|findings|runs|scans)(?:\/|$)/.test(location.pathname);
  const searchReturnFocus = useRef<HTMLElement | null>(null);
  const rememberSearchFocus = () => { searchReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const [searchMode, setSearchMode] = useState<SearchMode>("all");
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Mounted on first open and kept, so cmdk and the palette stay out of every route's first load.
  const [paletteMounted, setPaletteMounted] = useState(false);
  useEffect(() => { if (paletteOpen) setPaletteMounted(true); }, [paletteOpen]);
  const scansQuery = useQuery({ queryKey: queryKeys.scans(client.backendId), queryFn: getScans, enabled: operationsVisible || paletteOpen, refetchInterval: query => pollInterval(query.state.data?.some(scan => scan.status === "running") ?? true, 5000, 30_000) });
  const dashboardQuery = useQuery({ queryKey: queryKeys.dashboard(client.backendId), queryFn: getDashboard, enabled: operationsVisible || paletteOpen, refetchInterval: pollInterval(scansQuery.data?.some(scan => scan.status === "running") ?? true, 5000, 30_000) });
  const handleHotkey = useEffectEvent((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!paletteOpen) rememberSearchFocus();
      setSearchMode("all");
      setPaletteOpen((value) => !value);
    } else if (!paletteOpen && event.key === "/" && !isTypingTarget(event.target) && !document.querySelector("[data-search-owner]")) {
      event.preventDefault();
      rememberSearchFocus();
      setSearchMode("all");
      setPaletteOpen(true);
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleHotkey(event);
    const openSearch = (event: Event) => {
      const request = (event as CustomEvent<SearchRequest>).detail;
      rememberSearchFocus();
      if (request.returnFocus) searchReturnFocus.current = request.returnFocus;
      setSearchMode(request.mode === "chats" ? "chats" : "all");
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", listener);
    window.addEventListener("zero:open-search", openSearch);
    return () => { window.removeEventListener("keydown", listener); window.removeEventListener("zero:open-search", openSearch); };
  }, [handleHotkey]);

  const operations = (content: ReactNode) => {
    if (dashboardQuery.isLoading || scansQuery.isLoading) return <LoadingState label="Loading" />;
    const error = dashboardQuery.error ?? scansQuery.error;
    if (error) return <ErrorState error={error} />;
    return content;
  };
  const compatibilityPage = <Navigate to={{ pathname: canonicalWorkspacePath(location.pathname), search: location.search, hash: location.hash }} replace />;
  const dashboard = dashboardQuery.data;
  const scans = scansQuery.data ?? [];
  const startChat = (
    <Button variant="accent" size="sm" render={<NavLink to="/chats" />}>{v("Start {a mission}")}</Button>
  );
  const findings = operations(dashboard ? <FindingsPage dashboard={dashboard} /> : <EmptyState title="No findings yet" action={startChat} />);
  return (
    <DashboardPanelProvider>
      <AppShell>
        {paletteMounted && <Suspense fallback={null}><CommandPalette returnFocus={searchReturnFocus} mode={searchMode} onModeChange={setSearchMode} open={paletteOpen} onOpenChange={setPaletteOpen} dashboard={dashboard} scans={scansQuery.data} /></Suspense>}
        <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/chats" replace />} />
          <Route path="/chats" element={<Suspense fallback={<ConversationSkeleton />}><ConsolePage /></Suspense>} />
          <Route path="/chats/:sessionId" element={<Suspense fallback={<ConversationSkeleton />}><ConsolePage /></Suspense>} />
          <Route path="/chats/saved/:savedId" element={<SavedConversationPage />} />
          {["/setup", "/console/setup", "/console/onboarding"].map(path => <Route key={path} path={path} element={<Navigate to={{ pathname: "/onboarding", search: location.search, hash: location.hash }} replace />} />)}
          {["onboarding", "connections", "models", "settings", "plugins", "doctor", "tools", "project", "fix"].map((route) => (
            <Route key={route} path={`/${route}`} element={<WebConsoleControlsPage />} />
          ))}
          <Route path="/automations" element={<WorkflowsPage />} />
          <Route path="/sentinels" element={<SentinelsPage />} />
          <Route path="/sentinels/:sentinelId" element={<SentinelPage />} />
          {["workflows", "audits", "launcher", "launch"].map(route => <Route key={route} path={`/${route}`} element={compatibilityPage} />)}
          <Route path="/api-access" element={<FindingsApiAccessPage />} />
          <Route path="/team" element={<TeamSettingsPage />} />
          <Route path="/plugins/skills" element={<SkillsPage />} />
          <Route path="/learning" element={<LearningPage />} />
          <Route path="/scope" element={<EngagementsPage />} />
          <Route path="/operations" element={compatibilityPage} />
          <Route path="/threads" element={compatibilityPage} />
          <Route path="/threads/:fingerprint" element={compatibilityPage} />
          <Route path="/findings" element={findings} />
          <Route path="/engines" element={<WorkersPage />} />
          <Route path="/findings/:fingerprint" element={findings} />
          {["/runs", "/dashboard", "/live"].map(path => <Route key={path} path={path} element={<Navigate to="/findings" replace />} />)}
          <Route path="/runs/:scanId" element={operations(<ReportPage scans={scans} />)} />
          {["console", "workers", "engagements", "skills"].map(route => <Route key={route} path={`/${route}`} element={compatibilityPage} />)}
          {["console", "workers", "engagements", "skills"].map(route => <Route key={`${route}-child`} path={`/${route}/*`} element={compatibilityPage} />)}
          <Route path="/scans" element={compatibilityPage} />
          <Route path="/scans/:scanId" element={compatibilityPage} />
          <Route path="*" element={<Navigate to="/chats" replace />} />
        </Routes>
        </Suspense>
      </AppShell>
    </DashboardPanelProvider>
  );
}
