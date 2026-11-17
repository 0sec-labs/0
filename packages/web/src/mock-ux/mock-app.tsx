import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { SidebarLayout, SIDEBAR_DEFAULT_WIDTH } from "@/ui/components/sidebar";
import { ConsoleNavigationOpenButton } from "@/console/navigation-rail";
import { Button } from "@/components/ui/button";
import { MockSidebar } from "./sidebar";
import { AgentPage } from "./agent-page";
import { HistoryPage } from "./history-page";
import { NewThreadPage, ProposeWorkflowThread, ThreadPage } from "./thread-pages";
import { WorkflowDetailPage, WorkflowsPage } from "./workflow-pages";
import { useOverviewAgent, useVariant } from "./flag";
import { AGENT_NOUN } from "./vocab";

function Placeholder({ name }: { name: string }) {
  return <div className="mx-auto w-full max-w-(--page-width-list) px-6 pt-12"><h1 className="text-[22px]/7 font-medium tracking-[-0.02em]">{name}</h1><p className="mt-2 text-sm text-muted-foreground-1">Unchanged by this prototype. The real page lives in the production app.</p></div>;
}

/** Floating prototype control: variant, the optional Overview agent, and the way out. */
function MockControl() {
  const [variant, setVariant] = useVariant();
  const [overview, setOverview] = useOverviewAgent(variant);
  return <div data-testid="mock-control" className="fixed right-3 bottom-3 z-50 flex items-center gap-1 rounded-md border-[0.5px] border-border-2 bg-popover p-1 text-xs shadow-md">
    <span className="px-1.5 text-muted-foreground-1">Prototype</span>
    {(["a", "b"] as const).map(item => <Button key={item} size="xs" variant={variant === item ? "secondary" : "ghost"} aria-pressed={variant === item} onClick={() => setVariant(item)}>Variant {item.toUpperCase()}</Button>)}
    <Button size="xs" variant={overview ? "secondary" : "ghost"} aria-pressed={overview} onClick={() => setOverview(!overview)}>Overview {AGENT_NOUN.toLowerCase()}: {overview ? "on" : "off"}</Button>
    <Button size="xs" variant="ghost" onClick={() => { window.location.href = "/chats?mock=off"; }}>Exit</Button>
  </div>;
}

export function MockUxApp() {
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_WIDTH + 24);
  const toggle = () => setOpen(value => !value);
  return <div className="relative flex h-dvh min-w-0 flex-col overflow-hidden bg-[var(--chrome,var(--background))] text-foreground" data-mock-ux>
    <SidebarLayout open={open} width={width} onWidthChange={setWidth} onOpenChange={setOpen} sidebar={<MockSidebar onToggle={toggle} />} mobileSidebar={<MockSidebar onToggle={toggle} />} openControl={<ConsoleNavigationOpenButton onToggle={toggle} />}>
      <Routes>
        <Route path="/" element={<Navigate to="/chats" replace />} />
        <Route path="/chats" element={<NewThreadPage />} />
        <Route path="/chats/:id" element={<ThreadPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/new" element={<ProposeWorkflowThread />} />
        <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
        <Route path="/agents/:id" element={<AgentPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="*" element={<Placeholder name="This page" />} />
      </Routes>
    </SidebarLayout>
    <MockControl />
  </div>;
}
