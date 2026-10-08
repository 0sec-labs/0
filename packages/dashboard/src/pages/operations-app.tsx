import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { AppShell } from "@/components/app-shell";
import { CommandPalette, type SearchMode, type SearchRequest } from "@/components/command-palette";
import { DashboardPanelProvider } from "@/components/dashboard-panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { Button } from "@/components/ui/button";
import { FindingsPage } from "@/pages/findings-page";
import { LivePage } from "@/pages/live-page";
import { OverviewPage } from "@/pages/overview-page";
import { ScansPage } from "@/pages/scans-page";
import { ConsolePage } from "@/pages/console-page";
import { SavedConversationPage } from "@/pages/saved-conversation-page";
import { LearningPage } from "@/pages/learning-page";
import { EngagementsPage } from "@/pages/engagements-page";
import { WorkflowsPage } from "@/pages/workflows-page";
import { WebConsoleControlsPage } from "@/pages/console-controls-page";
import type { ThemesResponse } from "@/components/console-control/contracts";

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable));
}

export function OperationsApp() {
  const { client, getDashboard, getScans, webFetchJson } = useBackendApi();
  const location = useLocation();
  const operationsVisible = /^\/(?:dashboard|operations|threads|findings|runs|scans|live)(?:\/|$)/.test(location.pathname);
  const searchReturnFocus = useRef<HTMLElement | null>(null);
  const rememberSearchFocus = () => { searchReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const [searchMode, setSearchMode] = useState<SearchMode>("all");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const dashboardQuery = useQuery({ queryKey: ["dashboard", client.backendId], queryFn: getDashboard, enabled: operationsVisible || paletteOpen, refetchInterval: 5000 });
  const scansQuery = useQuery({ queryKey: ["scans", client.backendId], queryFn: getScans, enabled: operationsVisible || paletteOpen, refetchInterval: 5000 });
  const themesQuery = useQuery({
    queryKey: ["console-themes", client.backendId],
    queryFn: ({ signal }) => webFetchJson<ThemesResponse>("/api/console/themes", { signal }),
    refetchInterval: 5000,
  });
  useEffect(() => {
    const theme = themesQuery.data?.themes.find((item) => item.name === themesQuery.data?.active);
    if (!theme) return;
    const root = document.documentElement;
    const dark = theme.mode !== "light";
    root.classList.toggle("dark", dark);
    root.dataset.mode = dark ? "dark" : "light";
    root.style.colorScheme = dark ? "dark" : "light";
    const tokens: Record<string, string | undefined> = {
      "--background": dark ? "#0b0b0c" : "#ffffff",
      "--foreground": dark ? "#f4f4f5" : "#18181b",
      "--card": dark ? "#141415" : "#ffffff",
      "--card-foreground": dark ? "#f4f4f5" : "#18181b",
      "--popover": dark ? "#19191b" : "#ffffff",
      "--popover-foreground": dark ? "#f4f4f5" : "#18181b",
      "--primary": "#f97316",
      "--primary-text": dark ? "#fb923c" : "#c2410c",
      "--primary-foreground": "#ffffff",
      "--secondary": dark ? "#1b1b1e" : "#f4f4f5",
      "--secondary-foreground": dark ? "#f4f4f5" : "#18181b",
      "--muted": dark ? "#1b1b1e" : "#f4f4f5",
      "--muted-foreground": dark ? "#a1a1aa" : "#62626a",
      "--accent": dark ? "#222225" : "#f4f4f5",
      "--accent-foreground": dark ? "#f4f4f5" : "#18181b",
      "--border": dark ? "#29292d" : "#e4e4e7",
      "--input": dark ? "#343439" : "#d4d4d8",
      "--ring": "#f97316",
      "--destructive": theme.palette.ERROR,
      "--sidebar": dark ? "#111113" : "#fafafa",
      "--sidebar-foreground": dark ? "#f4f4f5" : "#18181b",
      "--sidebar-border": dark ? "#29292d" : "#e4e4e7",
    };
    for (const [token, value] of Object.entries(tokens)) {
      if (value && CSS.supports("color", value)) root.style.setProperty(token, value);
    }
  }, [themesQuery.data]);
  const handleHotkey = useEffectEvent((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!paletteOpen) rememberSearchFocus();
      setSearchMode("all");
      setPaletteOpen((value) => !value);
    } else if (!paletteOpen && event.key === "/" && !isTypingTarget(event.target)) {
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
  const dashboard = dashboardQuery.data;
  const scans = scansQuery.data ?? [];
  const startChat = (
    <Button asChild variant="accent" size="sm">
      <NavLink to="/console">Start a chat</NavLink>
    </Button>
  );
  const findings = operations(dashboard ? <FindingsPage dashboard={dashboard} /> : <EmptyState title="No findings yet" action={startChat} />);
  return (
    <DashboardPanelProvider>
      <AppShell>
        <CommandPalette returnFocus={searchReturnFocus} mode={searchMode} onModeChange={setSearchMode} open={paletteOpen} onOpenChange={setPaletteOpen} dashboard={dashboard} scans={scansQuery.data} />
        <Routes>
          <Route path="/" element={<Navigate to="/console" replace />} />
          <Route path="/console" element={<ConsolePage />} />
          <Route path="/console/:sessionId" element={<ConsolePage />} />
          <Route path="/console/saved/:savedId" element={<SavedConversationPage />} />
          {["setup", "connections", "models", "settings", "plugins", "doctor", "tools", "project", "fix"].map((route) => (
            <Route key={route} path={`/${route}`} element={<WebConsoleControlsPage />} />
          ))}
          {["workflows", "audits", "launcher", "launch"].map(route => <Route key={route} path={`/${route}`} element={<WorkflowsPage />} />)}
          <Route path="/learning" element={<LearningPage />} />
          <Route path="/engagements" element={<EngagementsPage />} />
          <Route path="/dashboard" element={operations(dashboard ? <OverviewPage data={dashboard} /> : <EmptyState title="Nothing here yet" action={startChat} />)} />
          <Route path="/operations" element={<Navigate to="/dashboard" replace />} />
          <Route path="/threads" element={findings} />
          <Route path="/threads/:fingerprint" element={findings} />
          <Route path="/findings" element={findings} />
          <Route path="/findings/:fingerprint" element={findings} />
          <Route path="/runs" element={operations(<ScansPage scans={scans} />)} />
          <Route path="/runs/:scanId" element={operations(<ScansPage scans={scans} />)} />
          <Route path="/scans" element={operations(<ScansPage scans={scans} />)} />
          <Route path="/scans/:scanId" element={operations(<ScansPage scans={scans} />)} />
          <Route path="/live" element={<LivePage />} />
          <Route path="*" element={<EmptyState title="Page not found" body="Press Cmd+K to find a page." />} />
        </Routes>
      </AppShell>
    </DashboardPanelProvider>
  );
}
