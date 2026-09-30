import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDashboardPanel } from "@/components/dashboard-panel";
import { SharedWorkspaceLayout } from "@/components/shared-workspace-layout";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

function pageTitle(pathname: string): string {
  if (/^\/(?:threads|findings)(?:\/|$)/.test(pathname)) return "Findings";
  if (/^\/(?:runs|scans)(?:\/|$)/.test(pathname)) return "Activity";
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
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { panel, dismissPanel } = useDashboardPanel();
  // The conversation already owns this shared rail and its session sidebar.
  if (pathname.startsWith("/console")) return <>{children}</>;
  return <SharedWorkspaceLayout title={pageTitle(pathname)} onNew={() => navigate("/console?new=1")} onOpenPalette={onOpenPalette}>
    {children}
    <Sheet open={Boolean(panel)} onOpenChange={(open) => { if (!open) dismissPanel(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
        {panel && <><SheetHeader className="pr-12"><SheetTitle>{panel.title}</SheetTitle><SheetDescription>{panel.description}</SheetDescription></SheetHeader><div className="min-h-0 flex-1 overflow-y-auto">{panel.content}</div></>}
      </SheetContent>
    </Sheet>
  </SharedWorkspaceLayout>;
}
