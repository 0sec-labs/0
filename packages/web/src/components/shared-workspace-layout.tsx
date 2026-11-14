import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { NewChatButton } from "./new-chat-button";
import { Button } from "@/components/ui/button";
import { useMobileSidebar } from "@/ui/components/sidebar";

/** The same compact navigation and page rhythm used by the conversation workspace. */
export function SharedWorkspaceLayout({ children, onNew }: {
  children: ReactNode;
  onNew: () => void;
}) {
  const drawer = useMobileSidebar();
  return <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden text-foreground">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-3 sm:px-5 lg:hidden [@media(hover:none)]:flex">
        <div className="flex min-w-0 items-center gap-2">
          <Button className="lg:hidden [@media(hover:none)]:inline-flex" variant="ghost" size="icon-sm" aria-label="Open navigation" aria-haspopup="dialog" onClick={() => drawer?.setOpen(true)}><Menu className="size-4" /></Button>
        </div>
        <div className="flex items-center gap-1">
          <NewChatButton iconOnly className="lg:hidden" onClick={onNew} />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="w-full min-w-0 px-5 py-5 sm:px-8 lg:[html[data-sidebar=closed]_&]:pt-12">{children}</div>
      </main>
    </div>
  </div>;
}
