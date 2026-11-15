import { WhatsNewHost } from "@/components/whats-new-dialog";
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
import { MissionNotifications } from "@/console/mission-notifications";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { Button } from "@/components/ui/button";
import {
  CommandPalette, ConsolePage, EngagementsPage, FindingsApiAccessPage, FindingsPage, LearningPage, PageFallback, ReportPage, SavedConversationPage,
  PluginDetailPage, ExplorePage, SkillCatalogDetailPage, SentinelPage, SentinelsPage, SkillsPage, TeamSettingsPage, WebConsoleControlsPage, WorkersPage, WorkflowsPage, useRoutePrefetch,
} from "@/pages/lazy-pages";
import { NotFoundPage } from "@/pages/not-found-page";
import { matchShortcut } from "@/lib/shortcuts";
import { LEGACY_REDIRECTS } from "@/lib/workspace-navigation";
import { usePageTitle } from "@/lib/page-title";
import { RouteErrorBoundary } from "@/components/route-error-boundary";

export function OperationsApp() {
  const { client, getDashboard, getScans } = useBackendApi();
  const location = useLocation();
  useRoutePrefetch();
  usePageTitle(location.pathname);
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
    const hit = matchShortcut(event);
    if (hit?.handler !== "palette.toggle") return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      if (!paletteOpen) rememberSearchFocus();
      setSearchMode("all");
      setPaletteOpen((value) => !value);
    } else if (!paletteOpen && !document.querySelector("[data-search-owner]")) {
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
  const legacyRedirect = ({ from, to, keep }: typeof LEGACY_REDIRECTS[number]) => (
    <Navigate to={{ pathname: keep === "path" ? `${to}${location.pathname.slice(from.length)}` : to, ...(keep === "none" ? {} : { search: location.search, hash: location.hash }) }} replace />
  );
  const dashboard = dashboardQuery.data;
  const scans = scansQuery.data ?? [];
  const startChat = (
    <Button variant="accent" size="sm" render={<NavLink to="/chats" />}>{v("Start {a mission}")}</Button>
  );
  const findings = operations(dashboard ? <FindingsPage dashboard={dashboard} /> : <EmptyState title="No findings yet" action={startChat} />);
  return (
    <DashboardPanelProvider>
      <MissionNotifications />
      <WhatsNewHost />
      <AppShell>
        {paletteMounted && <RouteErrorBoundary silent resetKey={String(paletteOpen)}><Suspense fallback={null}><CommandPalette returnFocus={searchReturnFocus} mode={searchMode} onModeChange={setSearchMode} open={paletteOpen} onOpenChange={setPaletteOpen} dashboard={dashboard} scans={scansQuery.data} /></Suspense></RouteErrorBoundary>}
        <RouteErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/chats" replace />} />
          <Route path="/chats" element={<Suspense fallback={null}><ConsolePage /></Suspense>} />
          <Route path="/chats/:sessionId" element={<Suspense fallback={<ConversationSkeleton />}><ConsolePage /></Suspense>} />
          <Route path="/chats/saved/:savedId" element={<Suspense fallback={<ConversationSkeleton />}><SavedConversationPage /></Suspense>} />
          {["connections", "models", "settings", "plugins", "doctor", "tools", "project", "fix"].map((route) => (
            <Route key={route} path={`/${route}`} element={<WebConsoleControlsPage />} />
          ))}
          <Route path="/automations" element={<WorkflowsPage />} />
          <Route path="/agents" element={<SentinelsPage />} />
          <Route path="/agents/:sentinelId" element={<SentinelPage />} />
          <Route path="/api-access" element={<FindingsApiAccessPage />} />
          <Route path="/team" element={<TeamSettingsPage />} />
          <Route path="/plugins/skills" element={<SkillsPage />} />
          <Route path="/plugins/skills/catalog/:id" element={<SkillCatalogDetailPage />} />
          <Route path="/plugins/explore" element={<ExplorePage />} />
          <Route path="/plugins/:pluginId" element={<PluginDetailPage />} />
          <Route path="/memory" element={<LearningPage />} />
          <Route path="/scope" element={<EngagementsPage />} />
          <Route path="/findings" element={findings} />
          <Route path="/computers" element={<WorkersPage />} />
          <Route path="/findings/:fingerprint" element={findings} />
          <Route path="/runs/:scanId" element={operations(<ReportPage scans={scans} />)} />
          {LEGACY_REDIRECTS.flatMap(row => row.routes.map(route => <Route key={route} path={route} element={legacyRedirect(row)} />))}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>
        </RouteErrorBoundary>
      </AppShell>
    </DashboardPanelProvider>
  );
}
