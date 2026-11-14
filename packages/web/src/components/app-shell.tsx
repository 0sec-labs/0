import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useReconnecting } from "@/lib/network-resilience";
import { useResolvedSessionId } from "@/console/session-recovery";
import { AppNoticeHost, AppNoticeProvider } from "./app-notice";
import { createPortal } from "react-dom";
import { HostSidebarChatHistory } from "./host-sidebar-chat-history";
import { SidebarHistoryContext } from "./sidebar-history";
import { useLocation, useNavigate } from "react-router-dom";
import { useDashboardPanel } from "@/components/dashboard-panel";
import { SharedWorkspaceLayout } from "@/components/shared-workspace-layout";
import { SettingsNavigation } from "@/console/settings-navigation";
import { consoleReturn } from "@/components/console-control/control-ui";
import { ConsoleNavigationOpenButton, ConsoleNavigationRail, useShellNavigationShortcuts, useSidebarShortcut } from "@/console/navigation-rail";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { SidebarLayout, SIDEBAR_DEFAULT_WIDTH, useMobileSidebar } from "@/ui/components/sidebar";
import { usePersistentState } from "@/lib/use-persistent-state";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { BreadcrumbProvider } from "@/lib/breadcrumbs";
import { STORAGE_KEYS } from "@/lib/storage";

/** Drawer copy of the sidebar: closing and navigating dismiss the drawer rather than touching the docked state. */
function MobileSidebar({ settings, returnTo, settingsHref, onHistorySlot }: { settings: boolean; returnTo: string; settingsHref: string; onHistorySlot: (element: HTMLDivElement | null) => void }) {
  const drawer = useMobileSidebar();
  const { pathname, search } = useLocation();
  const setOpen = drawer?.setOpen;
  // Close only when the route changes after mount; closing on mount would shut the drawer the instant it opens.
  const mountedAt = useRef(pathname + search);
  useEffect(() => {
    if (mountedAt.current === pathname + search) return;
    mountedAt.current = pathname + search;
    setOpen?.(false);
  }, [pathname, search, setOpen]);
  const close = useCallback(() => setOpen?.(false), [setOpen]);
  return settings ? <SettingsNavigation returnTo={returnTo} onToggle={close} /> : <ConsoleNavigationRail onToggle={close} onHistorySlot={onHistorySlot} settingsHref={settingsHref} />;
}

/** Muted, only after an outage has lasted; recovery refetches everything once any request succeeds again. */
function ReconnectingNotice() {
  const reconnecting = useReconnecting();
  const queryClient = useQueryClient();
  useEffect(() => {
    const refetch = () => { void queryClient.invalidateQueries(); };
    window.addEventListener("0-network-recovered", refetch);
    window.addEventListener("online", refetch);
    return () => { window.removeEventListener("0-network-recovered", refetch); window.removeEventListener("online", refetch); };
  }, [queryClient]);
  return reconnecting ? <div role="status" aria-live="polite" data-testid="reconnecting" className="pointer-events-none fixed bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-md border-[0.5px] border-border-2 bg-background px-2.5 py-1 text-xs text-muted-foreground shadow-sm">Reconnecting…</div> : null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  const [historySlot, setHistorySlot] = useState<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = usePersistentState(STORAGE_KEYS.sidebarOpen, true);
  const [sidebarWidth, setSidebarWidth] = usePersistentState(STORAGE_KEYS.sidebarWidth, SIDEBAR_DEFAULT_WIDTH);
  const [drawerHistorySlot, setDrawerHistorySlot] = useState<HTMLDivElement | null>(null);
  const toggleSidebar = useCallback(() => setSidebarOpen(value => !value), [setSidebarOpen]);
  useSidebarShortcut(toggleSidebar);
  const { panel, dismissPanel } = useDashboardPanel();
  const isConsole = pathname.startsWith("/chats");
  const routeSessionId = isConsole && !pathname.startsWith("/chats/saved/") ? pathname.split("/")[2] : undefined;
  // One alias map decides which live session the address-bar id currently means.
  const sessionId = useResolvedSessionId(routeSessionId);
  const workerId = new URLSearchParams(search).get("worker");
  const controlsQuery = sessionId
    ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(`/chats/${routeSessionId}${workerId ? `?worker=${encodeURIComponent(workerId)}` : ""}`)}`
    : "?return=/chats";
  useShellNavigationShortcuts(isConsole ? `/settings${controlsQuery}` : "/settings");
  const SETTINGS_PATHS = ["/settings", "/connections", "/models", "/project", "/doctor", "/tools", "/fix"];
  const isSettings = SETTINGS_PATHS.includes(pathname.replace(/^\/console\//, "/").replace(/\/$/, ""));
  // Keep the sidebar mounted across route changes so scroll position and focus survive.
  return <SidebarHistoryContext.Provider value={drawerHistorySlot ?? historySlot}><BreadcrumbProvider><AppNoticeProvider><div className="relative flex h-dvh min-w-0 flex-col overflow-hidden bg-[var(--chrome,var(--background))] text-foreground"><AppNoticeHost /><ReconnectingNotice /><KeyboardShortcutsDialog />
    <SidebarLayout open={sidebarOpen} width={sidebarWidth} onWidthChange={setSidebarWidth} onOpenChange={setSidebarOpen}
      sidebar={isSettings ? <SettingsNavigation returnTo={consoleReturn(search)} onToggle={toggleSidebar} /> : <ConsoleNavigationRail onToggle={toggleSidebar} onHistorySlot={setHistorySlot} settingsHref={isConsole ? `/settings${controlsQuery}` : "/settings"} />}
      mobileSidebar={<MobileSidebar settings={isSettings} returnTo={consoleReturn(search)} settingsHref={isConsole ? `/settings${controlsQuery}` : "/settings"} onHistorySlot={setDrawerHistorySlot} />}
      openControl={<ConsoleNavigationOpenButton onToggle={toggleSidebar} />}>
      {!isConsole && (drawerHistorySlot ?? historySlot) && createPortal(<HostSidebarChatHistory />, (drawerHistorySlot ?? historySlot)!)}
      {isConsole ? children : <SharedWorkspaceLayout onNew={() => navigate("/chats?new=1")}>
        {children}
        <Sheet open={Boolean(panel)} onOpenChange={(open) => { if (!open) dismissPanel(); }}>
          <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
            {panel && <><SheetHeader className="pr-12"><SheetTitle>{panel.title}</SheetTitle><SheetDescription>{panel.description}</SheetDescription></SheetHeader><div className="min-h-0 flex-1 overflow-y-auto">{panel.content}</div></>}
          </SheetContent>
        </Sheet>
      </SharedWorkspaceLayout>}
    </SidebarLayout>
  </div></AppNoticeProvider></BreadcrumbProvider></SidebarHistoryContext.Provider>;
}
