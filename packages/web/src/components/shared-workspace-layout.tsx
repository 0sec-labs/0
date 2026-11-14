import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { NewChatButton } from "./new-chat-button";
import { PageTopBar } from "./page-top-bar";
import { Button } from "@/components/ui/button";
import { useMobileSidebar } from "@/ui/components/sidebar";

/** The same compact navigation and page rhythm used by the conversation workspace. */
export function SharedWorkspaceLayout({ children, onNew }: {
  children: ReactNode;
  onNew: () => void;
}) {
  const drawer = useMobileSidebar();
  return <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden text-foreground">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-has-topbar="">
      <PageTopBar
        leading={<Button className="lg:hidden [@media(hover:none)]:inline-flex" variant="ghost" size="icon-sm" aria-label="Open navigation" aria-haspopup="dialog" onClick={() => drawer?.setOpen(true)}><Menu className="size-4" /></Button>}
        trailing={<NewChatButton iconOnly className="lg:hidden" onClick={onNew} />} />
      <main className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="w-full min-w-0">{children}</div>
      </main>
    </div>
  </div>;
}
