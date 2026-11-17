import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { CapyComposeIcon, CapySearchIcon, CapyPlusIcon, CapyIssueDashedIcon, CapySparkleFourIcon, CapyDatabaseIcon, CapyDevicesIcon, CapyPuzzleIcon, CapyAutomationsIcon, CapyChevronRightIcon, CapySettingsIcon, CapyThreadListIcon } from "@/ui/icons/capy";
import { PanelLeftIcon } from "@/ui/icons/panel";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { SidebarFooter, SidebarGroup, SidebarHeader, SidebarKbd, SidebarLabel, sidebarItemClasses } from "@/ui/components/sidebar";
import { cn } from "@/lib/utils";
import { AGENTS, FOLDERS, THREADS } from "./fixtures";
import { AGENT_NOUN, AGENT_NOUN_PLURAL, agentWord } from "./vocab";
import { AgentTile, NeedsYou, StatusGlyph } from "./parts";
import { useOverviewAgent, useVariant } from "./flag";

const NAV = [
  { to: "/findings", label: "Findings", icon: CapyIssueDashedIcon, badge: 3 },
  { to: "/workflows", label: "Workflows", icon: CapyAutomationsIcon },
  { to: "/skills", label: "Skills", icon: CapySparkleFourIcon },
  { to: "/memory", label: "Memory", icon: CapyDatabaseIcon },
  { to: "/computers", label: "Computers", icon: CapyDevicesIcon },
  { to: "/extensions", label: "Extensions", icon: CapyPuzzleIcon },
] as const;

const sectionLabel = "flex h-7 items-center gap-1 px-2 text-xs font-medium text-muted-foreground-1";
const rowBase = "group/row relative flex w-full min-w-0 shrink-0 items-center gap-2.5 rounded-md px-2 text-left outline-none select-none transition-colors duration-100 hover:bg-foreground/5 focus-visible:outline-ring-inset aria-[current=page]:bg-foreground/7";
const title = "min-w-0 flex-1 truncate text-sm leading-5 font-[450] tracking-[-0.02em] text-foreground/80 group-hover/row:text-foreground group-aria-[current=page]/row:text-foreground";

function AgentRow({ agent }: { agent: (typeof AGENTS)[number] }) {
  return <NavLink to={`/agents/${agent.id}`} className={cn(rowBase, "h-[46px]")}>
    <span className="relative"><AgentTile agent={agent} size="sm" /></span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-center gap-2"><span className={title}>{agent.name}</span><NeedsYou count={agent.needsYou} /><StatusGlyph status={agent.status} /></span>
      <span className="truncate text-xs leading-4 text-muted-foreground-1">{agent.short}</span>
    </span>
  </NavLink>;
}

function ThreadRow({ id, text, age, unread }: { id: string; text: string; age: string; unread?: boolean }) {
  return <NavLink to={`/chats/${id}`} className={cn(rowBase, "h-8")}>
    <span className={title}>{text}</span>
    {unread && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-label="Unread" />}
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground-1">{age}</span>
  </NavLink>;
}

function HistoryButton() {
  return <NavLink to="/history" className={cn(sidebarItemClasses, "text-muted-foreground-1")}><CapyThreadListIcon aria-hidden="true" /><SidebarLabel>History</SidebarLabel><SidebarKbd aria-hidden="true">⌘⇧H</SidebarKbd></NavLink>;
}

function FolderGroup({ name }: { name: string }) {
  const [open, setOpen] = useState(name !== "infra");
  const rows = THREADS.filter(thread => thread.folder === name).slice(0, 3);
  return <div>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className={cn(rowBase, "h-7 text-muted-foreground-1")}>
      <CapyChevronRightIcon aria-hidden="true" className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/80">{name}</span>
      <span className="text-xs tabular-nums">{THREADS.filter(thread => thread.folder === name).length}</span>
    </button>
    {open && <div className="ml-3 border-l-[0.5px] border-border-2 pl-1">{rows.map(thread => <ThreadRow key={thread.id} id={thread.id} text={thread.title} age={thread.age} unread={thread.unread} />)}</div>}
  </div>;
}

export function MockSidebar({ onToggle }: { onToggle: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [variant] = useVariant();
  const [overviewOn] = useOverviewAgent(variant);
  const agents = AGENTS.filter(agent => agent.id !== "overview" || overviewOn);
  const recent = THREADS.slice(0, 5);
  return <nav aria-label="Navigation" className="flex h-full min-h-0 w-full flex-col pt-2">
    <SidebarHeader>
      <a href="/chats" onClick={event => { event.preventDefault(); navigate("/chats"); }} aria-label="Home" className="-ml-1 flex h-(--h-control-sm) shrink-0 items-center rounded-(--radius-button) px-1 hover:bg-secondary"><BrandMark className="h-auto w-28" /></a>
      <div className="ml-auto flex items-center">
        <Button variant="ghost" size="icon-sm" aria-label="Search anything" className="text-muted-foreground-1"><CapySearchIcon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close sidebar" onClick={onToggle} className="text-muted-foreground-1"><PanelLeftIcon filled /></Button>
      </div>
    </SidebarHeader>
    {/* The text navigation block the owner likes stays exactly where it was. */}
    <SidebarGroup aria-label="Primary destinations">
      <NavLink to="/chats" end data-active={pathname === "/chats" || undefined} className={sidebarItemClasses}><CapyComposeIcon aria-hidden="true" /><SidebarLabel>New thread</SidebarLabel><SidebarKbd aria-hidden="true">⇧⌘O</SidebarKbd></NavLink>
      {NAV.map(({ to, label, icon: Icon, ...rest }) => <NavLink key={to} to={to} className={sidebarItemClasses}><Icon aria-hidden="true" /><SidebarLabel>{label}</SidebarLabel>
        {"badge" in rest && <span aria-label={`${rest.badge} to review`} className="ml-auto inline-flex h-4 min-w-4.5 shrink-0 items-center justify-center rounded-md bg-primary px-1 text-[11px] leading-none font-bold tabular-nums text-primary-foreground">{rest.badge}</span>}
      </NavLink>)}
    </SidebarGroup>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div className={sectionLabel}><span className="flex-1">{AGENT_NOUN_PLURAL}</span><Tooltip content={`New ${agentWord}`} side="right"><Button variant="ghost" size="icon-xs" aria-label={`New ${agentWord}`} className="text-muted-foreground-1"><CapyPlusIcon /></Button></Tooltip></div>
      <div className="flex flex-col gap-px" data-testid="mock-agents">{agents.map(agent => <AgentRow key={agent.id} agent={agent} />)}</div>
      {variant === "a" ? <>
        <div className={cn(sectionLabel, "mt-3")}>Recent threads</div>
        <div className="flex flex-col gap-px" data-testid="mock-recent">{recent.map(thread => <ThreadRow key={thread.id} id={thread.id} text={thread.title} age={thread.age} unread={thread.unread} />)}<HistoryButton /></div>
      </> : <>
        <div className={cn(sectionLabel, "mt-3")}><span className="flex-1">Folders</span><Button variant="ghost" size="icon-xs" aria-label="Add folder" className="text-muted-foreground-1"><CapyPlusIcon /></Button></div>
        <div className="flex flex-col gap-px" data-testid="mock-folders">{FOLDERS.map(folder => <FolderGroup key={folder} name={folder} />)}<HistoryButton /></div>
      </>}
    </div>
    <SidebarFooter>
      <NavLink to="/settings" className={sidebarItemClasses}><CapySettingsIcon aria-hidden="true" /><SidebarLabel>Settings</SidebarLabel></NavLink>
    </SidebarFooter>
  </nav>;
}
