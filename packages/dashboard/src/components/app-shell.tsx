import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDashboardPanel } from "@/components/dashboard-panel";
import { SharedWorkspaceLayout } from "@/components/shared-workspace-layout";
import { ConsoleNavigationRail } from "@/console/navigation-rail";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

function pageTitle(pathname: string): string {
  if (/^\/(?:threads|findings)(?:\/|$)/.test(pathname)) return "Findings";
  if (/^\/(?:runs|scans)(?:\/|$)/.test(pathname)) return "Run reports";
  if (/^\/(?:workflows|audits|launcher|launch)(?:\/|$)/.test(pathname)) return "Workflows";
  if (pathname.startsWith("/live")) return "Live activity";
  if (pathname.startsWith("/dashboard")) return "Dashboard";
  if (pathname.startsWith("/setup")) return "Set up 0";
  if (pathname.startsWith("/connections")) return "Connections";
  if (pathname.startsWith("/models")) return "Models";
  if (pathname.startsWith("/plugins")) return "Plugins";
  if (pathname.startsWith("/settings")) return "Settings";
  return "Workspace";
}

export function AppShell({ children, onOpenPalette }: { children: ReactNode; onOpenPalette: () => void }) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const { panel, dismissPanel } = useDashboardPanel();
  const isConsole = pathname.startsWith("/console");
  const sessionId = isConsole ? pathname.split("/")[2] : undefined;
  const workerId = new URLSearchParams(search).get("worker");
  const controlsQuery = sessionId
    ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(`/console/${sessionId}${workerId ? `?worker=${encodeURIComponent(workerId)}` : ""}`)}`
    : "?return=/console";
  // Keep the rail mounted across route changes so its hover/focus survives.
  return <div className="console-frame flex min-w-0 overflow-hidden bg-background text-foreground">
    <ConsoleNavigationRail settingsHref={isConsole ? `/settings${controlsQuery}` : "/settings"} />
    <div className="min-w-0 flex-1">
    {isConsole ? children : <SharedWorkspaceLayout title={pageTitle(pathname)} onNew={() => navigate("/console?new=1")} onOpenPalette={onOpenPalette}>
    {children}
    <Sheet open={Boolean(panel)} onOpenChange={(open) => { if (!open) dismissPanel(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
        {panel && <><SheetHeader className="pr-12"><SheetTitle>{panel.title}</SheetTitle><SheetDescription>{panel.description}</SheetDescription></SheetHeader><div className="min-h-0 flex-1 overflow-y-auto">{panel.content}</div></>}
      </SheetContent>
    </Sheet>
    </SharedWorkspaceLayout>}
    </div>
  </div>;
}
