import { useState, type ReactNode } from "react";
import { AppNoticeHost, AppNoticeProvider } from "./app-notice";
import { createPortal } from "react-dom";
import { HostSidebarChatHistory } from "./host-sidebar-chat-history";
import { SidebarHistoryContext } from "./sidebar-history";
import { useLocation, useNavigate } from "react-router-dom";
import { useDashboardPanel } from "@/components/dashboard-panel";
import { SharedWorkspaceLayout } from "@/components/shared-workspace-layout";
import { ConsoleNavigationRail } from "@/console/navigation-rail";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  const [historySlot, setHistorySlot] = useState<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const { panel, dismissPanel } = useDashboardPanel();
  const isConsole = pathname.startsWith("/console");
  const sessionId = isConsole && !pathname.startsWith("/console/saved/") ? pathname.split("/")[2] : undefined;
  const workerId = new URLSearchParams(search).get("worker");
  const controlsQuery = sessionId
    ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(`/console/${sessionId}${workerId ? `?worker=${encodeURIComponent(workerId)}` : ""}`)}`
    : "?return=/console";
  const isOnboarding = ["/onboarding", "/setup", "/console/onboarding", "/console/setup"].includes(pathname.replace(/\/$/, ""));
  if (isOnboarding) return <AppNoticeProvider><div className="console-frame relative console-onboarding-frame flex min-w-0 flex-col overflow-hidden bg-background text-foreground"><AppNoticeHost /><main className="min-h-0 flex-1 overflow-y-auto">{children}</main></div></AppNoticeProvider>;
  // Keep the rail mounted across route changes so its hover/focus survives.
  return <SidebarHistoryContext.Provider value={historySlot}><AppNoticeProvider><div className="console-frame relative flex min-w-0 flex-col overflow-hidden bg-background text-foreground"><AppNoticeHost /><div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
    <ConsoleNavigationRail onHistorySlot={setHistorySlot} settingsHref={isConsole ? `/settings${controlsQuery}` : "/settings"} />
    {!isConsole && historySlot && createPortal(<HostSidebarChatHistory />, historySlot)}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {isConsole ? children : <SharedWorkspaceLayout onNew={() => navigate("/console?new=1")}>
    {children}
    <Sheet open={Boolean(panel)} onOpenChange={(open) => { if (!open) dismissPanel(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
        {panel && <><SheetHeader className="pr-12"><SheetTitle>{panel.title}</SheetTitle><SheetDescription>{panel.description}</SheetDescription></SheetHeader><div className="min-h-0 flex-1 overflow-y-auto">{panel.content}</div></>}
      </SheetContent>
    </Sheet>
    </SharedWorkspaceLayout>}
    </div>
  </div></div></AppNoticeProvider></SidebarHistoryContext.Provider>;
}
