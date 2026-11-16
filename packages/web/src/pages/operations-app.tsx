import { WhatsNewHost } from "@/components/whats-new-dialog";
import { queryKeys } from "@/queries";
import { pollInterval } from "@/lib/polling";
import { v } from "@/lib/vocabulary";
import { Suspense, useEffect, useEffectEvent, useRef, useState } from "react";
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
  CommandPalette, ConsolePage, FindingsApiAccessPage, FindingsPage, LearningPage, PageFallback, SavedConversationPage,
  ExtensionsPage, SkillCatalogDetailPage, SentinelPage, SentinelsPage, SkillsPage, TeamSettingsPage, WebConsoleControlsPage, WorkersPage, useRoutePrefetch,
} from "@/pages/lazy-pages";
import { NotFoundPage } from "@/pages/not-found-page";
import { matchShortcut } from "@/lib/shortcuts";
import { LEGACY_REDIRECTS } from "@/lib/workspace-navigation";
import { usePageTitle } from "@/lib/page-title";
import { RouteErrorBoundary } from "@/components/route-error-boundary";

export function OperationsApp() {
  const { client, getDashboard } = useBackendApi();
  const location = useLocation();
  useRoutePrefetch();
  usePageTitle(location.pathname);
  const findingsVisible = /^\/findings(?:\/|$)/.test(location.pathname);
  const searchReturnFocus = useRef<HTMLElement | null>(null);
  const rememberSearchFocus = () => { searchReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const [searchMode, setSearchMode] = useState<SearchMode>("all");
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Mounted on first open and kept, so cmdk and the palette stay out of every route's first load.
  const [paletteMounted, setPaletteMounted] = useState(false);
  useEffect(() => { if (paletteOpen) setPaletteMounted(true); }, [paletteOpen]);
  const dashboardQuery = useQuery({ queryKey: queryKeys.dashboard(client.backendId), queryFn: getDashboard, enabled: findingsVisible || paletteOpen, refetchInterval: query => pollInterval(query.state.data?.scans.some(scan => scan.status === "running") ?? true, 5000, 30_000) });
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

  const legacyRedirect = ({ from, to, keep }: typeof LEGACY_REDIRECTS[number]) => (
    <Navigate to={{ pathname: keep === "path" ? `${to}${location.pathname.slice(from.length)}` : to, ...(keep === "none" ? {} : { search: location.search, hash: location.hash }) }} replace />
  );
  const dashboard = dashboardQuery.data;
  const startChat = (
    <Button variant="accent" size="sm" render={<NavLink to="/chats" />}>{v("Start {a mission}")}</Button>
  );
  const findings = dashboardQuery.isLoading ? <LoadingState label="Loading" /> : dashboardQuery.error ? <ErrorState error={dashboardQuery.error} /> : dashboard ? <FindingsPage dashboard={dashboard} /> : <EmptyState title="No findings yet" action={startChat} />;
  return (
    <DashboardPanelProvider>
      <MissionNotifications />
      <WhatsNewHost />
      <AppShell>
        {paletteMounted && <RouteErrorBoundary silent resetKey={String(paletteOpen)}><Suspense fallback={null}><CommandPalette returnFocus={searchReturnFocus} mode={searchMode} onModeChange={setSearchMode} open={paletteOpen} onOpenChange={setPaletteOpen} dashboard={dashboard} /></Suspense></RouteErrorBoundary>}
        <RouteErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/chats" replace />} />
          <Route path="/chats" element={<Suspense fallback={null}><ConsolePage /></Suspense>} />
          <Route path="/chats/:sessionId" element={<Suspense fallback={<ConversationSkeleton />}><ConsolePage /></Suspense>} />
          <Route path="/chats/saved/:savedId" element={<Suspense fallback={<ConversationSkeleton />}><SavedConversationPage /></Suspense>} />
          {["connections", "models", "settings", "doctor", "tools", "project", "fix"].map((route) => (
            <Route key={route} path={`/${route}`} element={<WebConsoleControlsPage />} />
          ))}
          <Route path="/agents" element={<SentinelsPage />} />
          <Route path="/agents/:sentinelId" element={<SentinelPage />} />
          <Route path="/api-access" element={<FindingsApiAccessPage />} />
          <Route path="/team" element={<TeamSettingsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/skills/catalog/:id" element={<SkillCatalogDetailPage />} />
          <Route path="/extensions" element={<ExtensionsPage />} />
          <Route path="/memory" element={<LearningPage />} />
          <Route path="/findings" element={findings} />
          <Route path="/computers" element={<WorkersPage />} />
          <Route path="/findings/:fingerprint" element={findings} />
          {LEGACY_REDIRECTS.flatMap(row => row.routes.map(route => <Route key={route} path={route} element={legacyRedirect(row)} />))}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>
        </RouteErrorBoundary>
      </AppShell>
    </DashboardPanelProvider>
  );
}
