import { TeamAccount } from "./team-access";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Menu, BookOpen, MessageSquare, Plus, Plug, Settings, ShieldCheck, Workflow, Library, Server } from "lucide-react";
import { HostSidebarChatHistory } from "./host-sidebar-chat-history";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const destinations = [
  { to: "/console", label: "Chat", icon: MessageSquare },
  { to: "/findings", label: "Findings", icon: ShieldCheck },
  { to: "/automations", label: "Automations", icon: Workflow },
  { to: "/skills", label: "Skills", icon: Library },
  { to: "/workers", label: "Hosts", icon: Server },
  { to: "/plugins", label: "Plugins", icon: Plug },
  { to: "/learning", label: "Memory", icon: BookOpen },
  { to: "/settings", label: "Settings", icon: Settings },
];

/** The same compact navigation and page rhythm used by the conversation workspace. */
export function SharedWorkspaceLayout({ children, onNew }: {
  children: ReactNode;
  onNew: () => void;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  return <div className="console-page-workspace flex h-full min-h-0 min-w-0 flex-1 overflow-hidden text-foreground">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="console-sidebar-surface flex shrink-0 items-center justify-between gap-2 px-3 py-3 sm:px-5 lg:hidden [@media(hover:none)]:flex">
        <div className="flex min-w-0 items-center gap-2">
          <Button className="lg:hidden [@media(hover:none)]:inline-flex" variant="ghost" size="icon-sm" aria-label="Open navigation" onClick={() => setNavigationOpen(true)}><Menu className="size-4" /></Button>
        </div>
        <div className="flex items-center gap-1">
          <Button className="lg:hidden" variant="ghost" size="icon-sm" aria-label="New chat" onClick={onNew}><Plus className="size-4" /></Button>
        </div>
      </header>
      <main className="m-2 min-h-0 flex-1 overflow-y-auto rounded-[var(--radius-panel)] bg-card shadow-[inset_0_0_0_1px_var(--border)]">
        <div className="w-full min-w-0 px-5 py-5 sm:px-8">{children}</div>
      </main>
    </div>
    <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
      <SheetContent side="left" className="console-sidebar-surface flex w-64 flex-col p-3">
        <SheetHeader className="px-3 py-4"><BrandMark compact className="size-7" /><SheetTitle className="sr-only">Command Center navigation</SheetTitle></SheetHeader>
        <div className="min-h-0 flex-1 overflow-hidden"><HostSidebarChatHistory onSelect={() => setNavigationOpen(false)} /></div>
        <nav aria-label="Command Center pages" className="flex flex-col gap-1">
          {destinations.map(({ to, label, icon: Icon }) => <Button key={to} variant="ghost" asChild className="justify-start"><Link to={to} onClick={() => setNavigationOpen(false)}><Icon className="size-4" />{label}</Link></Button>)}
        </nav>
        <div className="mt-auto"><TeamAccount /></div>
      </SheetContent>
    </Sheet>
  </div>;
}
