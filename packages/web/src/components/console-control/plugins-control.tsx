import { v } from "@/lib/vocabulary";
import { LoadingState } from "@/components/state-panel";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Blocks, ChevronRight, GitBranch, Sparkles, Store, Terminal } from "lucide-react";
import { CapyPlusIcon as Plus, CapySearchIcon as Search } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { SettingsCard } from "@/ui/components/settings-card";
import { SettingsSection } from "./settings-section";
import { AddGithubPluginSheet, AddMcpServerSheet, mcpStatus } from "./mcp-sheets";
import { useMcpServers } from "./mcp-api";
import { EntryLogo } from "./mcp-ui";
import { usePluginManager } from "./plugin-manager";
import { pluginPath, type PluginRef } from "./plugin-detail-model";
import { SETUP_PROMPT, entrySubtitle } from "./mcp-model";
import { CardHeaderRow } from "./connection-ui";
import { LogoTile } from "@/ui/components/logo-tile";
import { StatusBadge, type StatusTone } from "@/ui/components/status-badge";
import { ServiceIcon, useServicePlugins } from "./service-plugins-control";
import { Feedback } from "./control-ui";
import { queueComposerPrefill } from "@/lib/composer-prefill";

interface ListEntry { key: string; selection: PluginRef; name: string; version?: string; logo?: string; subtitle: string; tone: StatusTone; status: string; icon: React.ReactNode; search: string }

export function PluginsControl({ sessionId }: { sessionId?: string }) {
  const manager = usePluginManager();
  const { inventory, isolated } = manager;
  const service = useServicePlugins();
  const mcp = useMcpServers();
  const navigate = useNavigate();
  const [addSheet, setAddSheet] = useState<"mcp" | "github" | null>(null);
  const setUpWithZero = () => { queueComposerPrefill(SETUP_PROMPT); navigate("/chats"); };
  const [filter, setFilter] = useState("");
  const [searching, setSearching] = useState(false);
  const openExplore = () => navigate("/plugins/explore");

  const plugins = inventory.data?.items.filter(entry => entry.kind === "plugin") ?? [];
  const installed = plugins.filter(entry => entry.state !== "available");
  const available = plugins.filter(entry => entry.state === "available");
  const services = service.inventory.data?.items ?? [];
  const serviceLogo = (item: unknown) => (item as { logo?: string }).logo;
  const entries: ListEntry[] = [
    ...services.map((item): ListEntry => ({ key: `service:${item.id}`, selection: { kind: "service", id: item.id }, name: item.name, logo: serviceLogo(item), subtitle: entrySubtitle("MCP server", { tools: item.configured && item.tools.length ? item.tools.length : undefined, extra: item.category }), tone: item.configured ? item.enabled && !item.error ? "success" : "neutral" : "warning", status: !item.configured ? "Needs connection" : item.error ? "Needs attention" : item.enabled ? "Connected" : "Off", icon: <ServiceIcon id={item.id} />, search: `${item.name} ${item.description} ${item.category}` })),
    ...mcp.servers.map((item): ListEntry => { const view = mcpStatus(item); return { key: `mcp:${item.id}`, selection: { kind: "mcp", id: item.id }, name: item.name, version: item.version, logo: item.logo, subtitle: entrySubtitle("MCP server", { tools: item.status === "untested" && item.toolCount === 0 ? undefined : item.toolCount, skills: item.skillCount || undefined }), tone: view.tone, status: view.label, icon: <Terminal aria-hidden="true" className="size-4" />, search: `${item.name} ${item.command ?? item.url ?? ""}` }; }),
    ...installed.map((item): ListEntry => ({ key: `plugin:${item.id}`, selection: { kind: "plugin", id: item.id }, name: item.name, version: item.version, logo: item.logo, subtitle: entrySubtitle("Tool plugin", { tools: item.toolCount, skills: item.skillCount, extra: `${item.capabilities.length} ${item.capabilities.length === 1 ? "permission" : "permissions"}` }), tone: item.error ? "warning" : item.state === "enabled" ? "success" : "neutral", status: item.error ? "Needs attention" : item.state === "enabled" ? "Connected" : "Off", icon: <Blocks aria-hidden="true" className="size-4" />, search: `${item.name} ${item.id} ${item.description}` })),
  ];
  const needle = filter.trim().toLowerCase();
  const shown = entries.filter(entry => !needle || entry.search.toLowerCase().includes(needle));
  const loading = inventory.isPending || service.inventory.isPending || (mcp.query.isPending && mcp.supported);
  const error = inventory.error ?? service.inventory.error ?? (mcp.supported ? (mcp.query.error as Error | null) : null);
  const refetchAll = () => { void inventory.refetch(); void service.inventory.refetch(); void mcp.query.refetch(); };

  return <>
    <SettingsCard>
      <button type="button" onClick={setUpWithZero} className="group/row flex w-full items-center justify-between gap-6 p-4 text-left outline-none transition-colors duration-100 hover:bg-secondary/40 focus-visible:outline-ring-inset focus-visible:outline-2">
        <LogoTile><Sparkles aria-hidden="true" className="size-4" /></LogoTile>
        <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Set up with 0</span><span className="block text-sm text-muted-foreground-2">{v("Start a {mission} that finds, explains and configures an MCP server or plugin for you.")}</span></span>
        <ChevronRight aria-hidden="true" className="size-(--icon-sm) shrink-0 text-muted-foreground-2" />
      </button>
      <button type="button" onClick={openExplore} className="group/row flex w-full items-center justify-between gap-6 p-4 text-left outline-none transition-colors duration-100 hover:bg-secondary/40 focus-visible:outline-ring-inset focus-visible:outline-2">
        <LogoTile><Store aria-hidden="true" className="size-4" /></LogoTile>
        <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Explore the marketplace</span><span className="block text-sm text-muted-foreground-2">{inventory.data ? (available.length > 0 ? `${available.length} ${available.length === 1 ? "plugin" : "plugins"} available from the registry` : "Plugins listed by the configured registry") : "Plugins listed by the configured registry"}</span></span>
        <ChevronRight aria-hidden="true" className="size-(--icon-sm) shrink-0 text-muted-foreground-2" />
      </button>
    </SettingsCard>

    <SettingsSection id="mcp-plugins" title="Shared on this engine" description={isolated ? v("Approved plugins are copied into each new SmolVM {mission} and run inside its VM. Changes apply to new {missions}.") : sessionId ? v("Changes apply to new {missions}, not this one.") : v("Connected once for everyone; changes apply to new {missions}.")}>
      <CardHeaderRow title={`${entries.length} ${entries.length === 1 ? "plugin" : "plugins"}`}>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Search plugins" aria-pressed={searching} onClick={() => { setSearching(value => !value); setFilter(""); }}><Search /></Button>
        <DropdownMenu>
          <DropdownMenu.Trigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Add" />}><Plus /></DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" sideOffset={4}>
            <DropdownMenu.Item icon={<Store />} onClick={openExplore}>From marketplace</DropdownMenu.Item>
            {mcp.supported && <DropdownMenu.Item icon={<GitBranch />} onClick={() => setAddSheet("github")}>From GitHub repository</DropdownMenu.Item>}
            {mcp.supported ? <DropdownMenu.Item icon={<Terminal />} onClick={() => setAddSheet("mcp")}>MCP server</DropdownMenu.Item> : <DropdownMenu.Item icon={<Blocks />} disabled>MCP server (not supported by this host)</DropdownMenu.Item>}
          </DropdownMenu.Content>
        </DropdownMenu>
      </CardHeaderRow>
      {searching && <div className="p-3"><Input autoFocus data-1p-ignore data-lpignore="true" autoComplete="off" aria-label="Search plugins" type="search" placeholder="Search plugins" value={filter} onChange={event => setFilter(event.target.value)} /></div>}
      {loading && <div className="p-4"><LoadingState label="Loading plugins…" variant="cards" /></div>}
      {error && <div className="flex flex-col items-start gap-3 p-4"><Feedback error={error} /><Button variant="outline" onClick={refetchAll}>Try again</Button></div>}
      {!loading && !error && shown.length === 0 && <div className="flex items-center justify-between gap-4 p-4 text-sm text-muted-foreground-2"><span>{needle ? "Nothing matches your search." : "No plugins yet."}</span>{needle && <Button variant="ghost" size="sm" onClick={() => setFilter("")}>Clear search</Button>}</div>}
      {shown.map(entry => <button key={entry.key} type="button" aria-label={entry.name} onClick={() => navigate(pluginPath(entry.selection))} className="group/row flex w-full items-center gap-3 p-4 text-left outline-none transition-colors duration-100 hover:bg-secondary/40 focus-visible:outline-ring-inset focus-visible:outline-2">
        <EntryLogo logo={entry.logo} fallback={entry.icon} />
        <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-sm font-medium text-foreground">{entry.name}</span>{entry.version && <span className="shrink-0 rounded-full border-[0.5px] border-border-2 px-1.5 text-xs text-muted-foreground-1">{entry.version}</span>}</span><span className="block truncate text-sm text-muted-foreground-2">{entry.subtitle}</span></span>
        <StatusBadge appearance="outline" tone={entry.tone}>{entry.status}</StatusBadge>
        <ChevronRight aria-hidden="true" className="size-(--icon-sm) shrink-0 text-muted-foreground-2" />
      </button>)}
    </SettingsSection>

    {inventory.data?.registry.error ? <Feedback error={inventory.data.registry.error} /> : inventory.data && !inventory.data.registry.available && <Feedback error="The plugin registry is offline. Installed plugins are still listed above." />}

    <AddMcpServerSheet open={addSheet === "mcp"} onOpenChange={open => setAddSheet(open ? "mcp" : null)} actions={mcp} hostName="this machine" />
    <AddGithubPluginSheet open={addSheet === "github"} onOpenChange={open => setAddSheet(open ? "github" : null)} actions={mcp} />

  </>;
}

