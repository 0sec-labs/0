import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Command, Menu, MessageSquare, Plus, Plug, Settings, ShieldCheck, Workflow } from "lucide-react";
import { ConsoleNavigationRail } from "@/console/navigation-rail";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const destinations = [
  { to: "/console", label: "Chats", icon: MessageSquare },
  { to: "/findings", label: "Findings", icon: ShieldCheck },
  { to: "/runs", label: "Assessment history", icon: Workflow },
  { to: "/plugins", label: "Integrations", icon: Plug },
  { to: "/settings", label: "Settings", icon: Settings },
];

/** The same compact navigation and page rhythm used by the conversation workspace. */
export function SharedWorkspaceLayout({ title, children, onNew, onOpenPalette }: {
  title: string;
  children: ReactNode;
  onNew: () => void;
  onOpenPalette: () => void;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  return <div className="console-frame flex min-w-0 overflow-hidden bg-background text-foreground">
    <ConsoleNavigationRail settingsHref="/settings" />
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Button className="lg:hidden [@media(hover:none)]:inline-flex" variant="ghost" size="icon-sm" aria-label="Open navigation" onClick={() => setNavigationOpen(true)}><Menu className="size-4" /></Button>
          <span className="truncate text-sm font-semibold">{title}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button className="lg:hidden" variant="ghost" size="icon-sm" aria-label="New chat" onClick={onNew}><Plus className="size-4" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Open commands" onClick={onOpenPalette}><Command className="size-4" /></Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-5 py-5 sm:px-8">{children}</div>
      </main>
    </div>
    <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
      <SheetContent side="left" className="w-64 p-3">
        <SheetHeader className="px-3 py-4"><BrandMark compact className="size-7" /><SheetTitle className="sr-only">Workspace navigation</SheetTitle></SheetHeader>
        <nav aria-label="All workspace pages" className="flex flex-col gap-1">
          {destinations.map(({ to, label, icon: Icon }) => <Button key={to} variant="ghost" asChild className="justify-start"><Link to={to} onClick={() => setNavigationOpen(false)}><Icon className="size-4" />{label}</Link></Button>)}
        </nav>
      </SheetContent>
    </Sheet>
  </div>;
}
