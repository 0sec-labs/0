import { v } from "@/lib/vocabulary";
import { LoadingState } from "@/components/state-panel";
import { ControlDisclosure } from "./control-disclosure";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Blocks, ChevronRight, GitBranch, Sparkles, Store, Terminal } from "lucide-react";
import { CapyPlusIcon as Plus, CapySearchIcon as Search } from "@/ui/icons/capy";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SettingsCard, SettingsCardRow } from "@/ui/components/settings-card";
import { usePersistentState } from "@/lib/use-persistent-state";
import { SettingsSection } from "./settings-section";
import { AddGithubPluginSheet, AddMcpServerSheet, McpServerSheet, mcpStatus } from "./mcp-sheets";
import { useMcpServers } from "./mcp-api";
import { EntryLogo, ToolSkillLists } from "./mcp-ui";
import { SETUP_PROMPT, entrySubtitle } from "./mcp-model";
import { CardHeaderRow, LogoTile, StatusPill } from "./connection-ui";
import { ServiceIcon, ServicePluginSheet, useServicePlugins } from "./service-plugins-control";
import { Facts, Feedback, SubmitButton, jsonBody } from "./control-ui";
import type { PluginItem, PluginResult, PluginsResponse } from "./contracts";

type Selected = { kind: "plugin"; id: string } | { kind: "service"; id: string } | { kind: "mcp"; id: string };
interface ListEntry { key: string; selection: Selected; name: string; version?: string; logo?: string; subtitle: string; tone: "ok" | "warn" | "muted"; status: string; icon: React.ReactNode; search: string }

export function PluginsControl({ sessionId }: { sessionId?: string }) {
  const { webFetchJson } = useBackendApi();
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const queryClient = useQueryClient();
  const inventory = useQuery({ queryKey: ["console-plugins"], queryFn: ({ signal }) => webFetchJson<PluginsResponse>("/api/console/plugins", { signal }), refetchInterval: 5000 });
  const service = useServicePlugins();
  const mcp = useMcpServers();
  const navigate = useNavigate();
  const [, setDrafts] = usePersistentState<Record<string, string>>("0-console-drafts", {}, { observe: false });
  const [addSheet, setAddSheet] = useState<"mcp" | "github" | null>(null);
  const setUpWithZero = () => { setDrafts(previous => ({ ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}), "new:root": SETUP_PROMPT })); navigate("/console"); };
  const isolated = inventory.data?.executionProfile === "smolvm";
  const [filter, setFilter] = useState("");
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [marketplace, setMarketplace] = useState(false);
  const [confirmation, setConfirmation] = useState<{ action: "install" | "enable" | "run"; item: PluginItem } | null>(null);
  const [technicalMessage, setTechnicalMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mutate = useMutation({ mutationFn: async ({ action, target, approved = false }: { action: "install" | "enable" | "disable" | "run"; target: PluginItem; approved?: boolean }) => {
    if (target.kind !== "plugin") throw new Error("Only web plugins can be managed here.");
    if ((action === "enable" || action === "run" || action === "install") && !approved) throw new Error("Confirm this action first.");
    const payload = action === "install" ? { id: target.id, kind: target.kind }
      : action === "enable" ? { id: target.id, approved: true, capabilities: target.capabilities, version: target.version }
      : { id: target.id };
    const result = await webFetchJson<PluginResult>(`/api/console/plugins/${action}`, jsonBody(payload));
    if (!result.ok && !(action === "run" && result.deferred)) throw new Error(result.message);
    if (action === "enable" && !isolated) {
      const loaded = await webFetchJson<PluginResult>("/api/console/plugins/run", jsonBody({ id: target.id }));
      if (!loaded.ok && !loaded.deferred) throw new Error(loaded.message);
      return loaded;
    }
    return result;
  }, onSuccess: async (result, { action }) => {
    await Promise.all([inventory.refetch(), queryClient.invalidateQueries({ queryKey: ["console-settings"] }), queryClient.invalidateQueries({ queryKey: ["console-tools"] })]);
    setConfirmation(null);
    setTechnicalMessage(result.message);
    setMessage(action === "enable" ? result.deferred ? "Enabled. Loading after the current response finishes." : "Enabled." : action === "disable" ? v("Disabled for new {missions}.") : action === "install" ? "Installed." : result.deferred ? "Loading is waiting for the current response to finish." : "Loaded.");
  }, onError: () => { void inventory.refetch(); } });
  const requestConfirmation = (action: "install" | "enable" | "run", target: PluginItem, trigger?: HTMLElement) => { confirmationTrigger.current = trigger ?? null; mutate.reset(); setConfirmation({ action, item: target }); };

  const plugins = inventory.data?.items.filter(entry => entry.kind === "plugin") ?? [];
  const installed = plugins.filter(entry => entry.state !== "available");
  const available = plugins.filter(entry => entry.state === "available");
  const services = service.inventory.data?.items ?? [];
  const serviceLogo = (item: unknown) => (item as { logo?: string }).logo;
  const entries: ListEntry[] = [
    ...services.map((item): ListEntry => ({ key: `service:${item.id}`, selection: { kind: "service", id: item.id }, name: item.name, logo: serviceLogo(item), subtitle: entrySubtitle("MCP server", { tools: item.configured && item.tools.length ? item.tools.length : undefined, extra: item.category }), tone: item.configured ? item.enabled && !item.error ? "ok" : "muted" : "warn", status: !item.configured ? "Needs connection" : item.error ? "Needs attention" : item.enabled ? "Connected" : "Off", icon: <ServiceIcon id={item.id} />, search: `${item.name} ${item.description} ${item.category}` })),
    ...mcp.servers.map((item): ListEntry => { const view = mcpStatus(item); return { key: `mcp:${item.id}`, selection: { kind: "mcp", id: item.id }, name: item.name, version: item.version, logo: item.logo, subtitle: entrySubtitle("MCP server", { tools: item.status === "untested" && item.toolCount === 0 ? undefined : item.toolCount, skills: item.skillCount || undefined }), tone: view.tone, status: view.label, icon: <Terminal aria-hidden="true" className="size-4" />, search: `${item.name} ${item.command ?? item.url ?? ""}` }; }),
    ...installed.map((item): ListEntry => ({ key: `plugin:${item.id}`, selection: { kind: "plugin", id: item.id }, name: item.name, version: item.version, logo: item.logo, subtitle: entrySubtitle("Plugin", { tools: item.toolCount, skills: item.skillCount, extra: `${item.capabilities.length} ${item.capabilities.length === 1 ? "permission" : "permissions"}` }), tone: item.error ? "warn" : item.state === "enabled" ? "ok" : "muted", status: item.error ? "Needs attention" : item.state === "enabled" ? "Connected" : "Off", icon: <Blocks aria-hidden="true" className="size-4" />, search: `${item.name} ${item.id} ${item.description}` })),
  ];
  const needle = filter.trim().toLowerCase();
  const shown = entries.filter(entry => !needle || entry.search.toLowerCase().includes(needle));
  const pluginItem = selected?.kind === "plugin" ? plugins.find(item => item.id === selected.id) ?? null : null;
  const serviceItem = selected?.kind === "service" ? services.find(item => item.id === selected.id) ?? null : null;
  const mcpItem = selected?.kind === "mcp" ? mcp.servers.find(item => item.id === selected.id) ?? null : null;
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
      <button type="button" onClick={() => setMarketplace(true)} className="group/row flex w-full items-center justify-between gap-6 p-4 text-left outline-none transition-colors duration-100 hover:bg-secondary/40 focus-visible:outline-ring-inset focus-visible:outline-2">
        <LogoTile><Store aria-hidden="true" className="size-4" /></LogoTile>
        <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Explore the marketplace</span><span className="block text-sm text-muted-foreground-2">{inventory.data ? (available.length > 0 ? `${available.length} ${available.length === 1 ? "plugin" : "plugins"} available from the registry` : "Plugins listed by the configured registry") : "Plugins listed by the configured registry"}</span></span>
        <ChevronRight aria-hidden="true" className="size-(--icon-sm) shrink-0 text-muted-foreground-2" />
      </button>
    </SettingsCard>

    <SettingsSection id="mcp-plugins" title="Shared on this host" description={isolated ? v("Approved plugins are copied into each new SmolVM {mission} and run inside its VM. Changes apply to new {missions}.") : sessionId ? v("Changes apply to new {missions}, not this one.") : v("Connected once for everyone; changes apply to new {missions}.")}>
      <CardHeaderRow title={`${entries.length} ${entries.length === 1 ? "plugin or MCP server" : "plugins and MCP servers"}`}>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Search plugins and MCP servers" aria-pressed={searching} onClick={() => { setSearching(value => !value); setFilter(""); }}><Search /></Button>
        <DropdownMenu>
          <DropdownMenu.Trigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Add" />}><Plus /></DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" sideOffset={4}>
            <DropdownMenu.Item icon={<Store />} onClick={() => setMarketplace(true)}>From marketplace</DropdownMenu.Item>
            {mcp.supported && <DropdownMenu.Item icon={<GitBranch />} onClick={() => setAddSheet("github")}>From GitHub repository</DropdownMenu.Item>}
            {mcp.supported ? <DropdownMenu.Item icon={<Terminal />} onClick={() => setAddSheet("mcp")}>MCP server</DropdownMenu.Item> : <DropdownMenu.Item icon={<Blocks />} disabled>MCP server (not supported by this host)</DropdownMenu.Item>}
          </DropdownMenu.Content>
        </DropdownMenu>
      </CardHeaderRow>
      {searching && <div className="p-3"><Input autoFocus data-1p-ignore data-lpignore="true" autoComplete="off" aria-label="Search plugins and MCP servers" type="search" placeholder="Search plugins and MCP servers" value={filter} onChange={event => setFilter(event.target.value)} /></div>}
      {loading && <div className="p-4"><LoadingState label="Loading plugins…" variant="cards" /></div>}
      {error && <div className="flex flex-col items-start gap-3 p-4"><Feedback error={error} /><Button variant="outline" onClick={refetchAll}>Try again</Button></div>}
      {!loading && !error && shown.length === 0 && <div className="flex items-center justify-between gap-4 p-4 text-sm text-muted-foreground-2"><span>{needle ? "Nothing matches your search." : "No plugins or MCP servers yet."}</span>{needle && <Button variant="ghost" size="sm" onClick={() => setFilter("")}>Clear search</Button>}</div>}
      {shown.map(entry => <button key={entry.key} type="button" aria-label={entry.name} onClick={event => { confirmationTrigger.current = event.currentTarget; setSelected(entry.selection); }} className="group/row flex w-full items-center gap-3 p-4 text-left outline-none transition-colors duration-100 hover:bg-secondary/40 focus-visible:outline-ring-inset focus-visible:outline-2">
        <EntryLogo logo={entry.logo} fallback={entry.icon} />
        <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-sm font-medium text-foreground">{entry.name}</span>{entry.version && <span className="shrink-0 rounded-full border-[0.5px] border-border-2 px-1.5 text-xs text-muted-foreground-1">{entry.version}</span>}</span><span className="block truncate text-sm text-muted-foreground-2">{entry.subtitle}</span></span>
        <StatusPill tone={entry.tone}>{entry.status}</StatusPill>
        <ChevronRight aria-hidden="true" className="size-(--icon-sm) shrink-0 text-muted-foreground-2" />
      </button>)}
    </SettingsSection>

    {inventory.data && <ControlDisclosure title="Registry details"><div className="mt-4 space-y-4">
      {inventory.data.registry.error ? <Feedback error={inventory.data.registry.error} /> : !inventory.data.registry.available && <Feedback error="The plugin registry is offline. Installed plugins are still listed above." />}
      <Facts entries={[["Registry", inventory.data.registry.url], ...(!isolated ? [["Loaded plugins", inventory.data.host.loadedPluginIds.length ? inventory.data.host.loadedPluginIds.join(", ") : "None"], ["Waiting to load", inventory.data.deferred.length ? inventory.data.deferred.join(", ") : "None"]] as [string, string][] : [])]} />
      {!isolated && inventory.data.host.tools.length > 0 && <div className="space-y-3"><p className="text-xs text-muted-foreground">Plugin tools</p><ul className="space-y-3">{inventory.data.host.tools.map(tool => <li key={tool.name}><p className="text-sm font-medium">{tool.name}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{tool.description}</p></li>)}</ul></div>}
    </div></ControlDisclosure>}

    <ServicePluginSheet item={serviceItem} actions={service} onClose={() => setSelected(null)} />
    <McpServerSheet item={mcpItem} actions={mcp} onClose={() => setSelected(null)} />
    <AddMcpServerSheet open={addSheet === "mcp"} onOpenChange={open => setAddSheet(open ? "mcp" : null)} actions={mcp} hostName="this machine" />
    <AddGithubPluginSheet open={addSheet === "github"} onOpenChange={open => setAddSheet(open ? "github" : null)} actions={mcp} />

    <Sheet open={Boolean(pluginItem)} onOpenChange={open => { if (!open && !mutate.isPending) { setSelected(null); mutate.reset(); setMessage(null); } }}>
      <SheetContent className="w-full data-[side=right]:sm:max-w-[640px]">
        {pluginItem && <PluginDetail item={pluginItem} inventory={inventory.data} isolated={isolated} pending={mutate.isPending} error={mutate.variables?.target.id === pluginItem.id ? mutate.error : null} message={mutate.variables?.target.id === pluginItem.id ? message : null} technicalMessage={mutate.variables?.target.id === pluginItem.id ? technicalMessage : null} onRequest={requestConfirmation} onDisable={() => mutate.mutate({ action: "disable", target: pluginItem })} />}
      </SheetContent>
    </Sheet>

    <Sheet open={marketplace} onOpenChange={setMarketplace}>
      <SheetContent className="w-full data-[side=right]:sm:max-w-[640px]">
        <SheetHeader><SheetTitle>Plugin marketplace</SheetTitle><SheetDescription>Plugins from the configured registry. Install one, then review its permissions before enabling it.</SheetDescription></SheetHeader>
        <div className="flex flex-col gap-4 px-6 pb-6">
          {inventory.data?.registry.error ? <Feedback error={inventory.data.registry.error} /> : inventory.data && !inventory.data.registry.available && <Feedback error="The plugin registry is offline." />}
          {inventory.isPending && <LoadingState label="Loading plugins…" variant="cards" />}
          {inventory.data && available.length === 0 && <p className="text-sm text-muted-foreground-2">No new plugins are available right now.</p>}
          {available.length > 0 && <SettingsCard className="mx-0">{available.map(item => <SettingsCardRow key={item.id}>
            <EntryLogo logo={item.logo} fallback={<Blocks aria-hidden="true" className="size-4" />} />
            <div className="min-w-0 flex-1"><h3 className="flex items-center gap-2 text-sm font-medium"><span className="truncate">{item.name}</span><span className="shrink-0 rounded-full border-[0.5px] border-border-2 px-1.5 text-xs text-muted-foreground-1">{item.version}</span></h3><p className="line-clamp-2 text-sm text-muted-foreground-2">{item.description || `${item.capabilities.length} permissions`}</p></div>
            <Button variant="outline" size="sm" disabled={!inventory.data?.registry.available || Boolean(item.error)} onClick={event => requestConfirmation("install", item, event.currentTarget)}>Install</Button>
          </SettingsCardRow>)}</SettingsCard>}
        </div>
      </SheetContent>
    </Sheet>

    <Dialog open={Boolean(confirmation)} onOpenChange={open => { if (!open && !mutate.isPending) { setConfirmation(null); mutate.reset(); } }}><DialogContent showCloseButton={!mutate.isPending} onCloseAutoFocus={event => { event.preventDefault(); confirmationTrigger.current?.focus(); }} onEscapeKeyDown={event => { if (mutate.isPending) event.preventDefault(); }} onInteractOutside={event => { if (mutate.isPending) event.preventDefault(); }}><DialogHeader><DialogTitle>{confirmation?.action === "enable" ? "Enable" : confirmation?.action === "run" ? "Load" : "Install"} {confirmation?.item.name}</DialogTitle><DialogDescription>{confirmation?.action === "enable" ? isolated ? v("Approve this version and its permissions for new SmolVM {missions}. Its files will be copied and its code loaded inside the VM automatically. Existing {missions} keep their current tools.") : v("Approve this version and its permissions, and allow its code to load in the local host. Existing {missions} keep their current tools.") : confirmation?.action === "run" ? "This runs the plugin's code in the local host. An active response may defer loading." : "Install this artifact from the configured registry."}</DialogDescription></DialogHeader>
      {confirmation && <div className="space-y-3 text-sm"><p className="text-muted-foreground">{confirmation.item.name} {confirmation.item.version}</p>{confirmation.action === "install" && confirmation.item.signature === "unverified" && <p className="leading-6">The signature is unverified. Only install if you trust this source.</p>}{confirmation.action !== "run" && <div><p className="font-medium">Permissions</p>{confirmation.item.capabilities.length ? <ul className="mt-2 list-inside list-disc space-y-1 break-words">{confirmation.item.capabilities.map(capability => <li key={capability}>{capability}</li>)}</ul> : <p className="mt-2 text-muted-foreground">No extra permissions.</p>}</div>}<Feedback error={mutate.error} /></div>}
      <DialogFooter><Button variant="ghost" disabled={mutate.isPending} onClick={() => { setConfirmation(null); mutate.reset(); }}>Cancel</Button><SubmitButton pending={mutate.isPending} onClick={() => { if (confirmation) mutate.mutate({ action: confirmation.action, target: confirmation.item, approved: true }); }}>{confirmation?.action === "enable" ? "Approve and enable" : confirmation?.action === "run" ? "Allow and load" : "Install"}</SubmitButton></DialogFooter>
    </DialogContent></Dialog>
  </>;
}

/** Detail drawer for one registry plugin: status, enable switch, and the permissions it asks for. */
function PluginDetail({ item, inventory, isolated, pending, error, message, technicalMessage, onRequest, onDisable }: { item: PluginItem; inventory?: PluginsResponse; isolated: boolean; pending: boolean; error: unknown; message: string | null; technicalMessage: string | null; onRequest: (action: "install" | "enable" | "run", item: PluginItem, trigger?: HTMLElement) => void; onDisable: () => void }) {
  const enabled = item.state === "enabled";
  const description = item.description && !/^[a-z][a-z0-9_]*(?:, [a-z][a-z0-9_]*)+$/.test(item.description) && !/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(item.description) && !inventory?.host.tools.some(tool => tool.name === item.description) ? item.description : "";
  return <>
    <SheetHeader className="flex-row items-start gap-3">
      <EntryLogo logo={item.logo} className="size-10" fallback={<Blocks aria-hidden="true" className="size-5" />} />
      <div className="min-w-0"><SheetTitle className="text-xl">{item.name}</SheetTitle>{description && <SheetDescription>{description}</SheetDescription>}</div>
    </SheetHeader>
    <div className="flex flex-col gap-8 px-6 pb-6">
      <SettingsCard className="mx-0">
        <SettingsCardRow><div className="min-w-0"><h3 className="text-sm font-medium">Status</h3><p className="text-sm text-muted-foreground-2">{item.version} from {item.source === "github" ? `GitHub${item.repo ? ` ${item.repo}` : ""}${item.sha ? ` @ ${item.sha.slice(0, 12)}. Pinned; never updates by itself` : ""}` : "the registry"} · signature {item.signature}</p></div><StatusPill tone={item.error ? "warn" : enabled ? "ok" : "muted"}>{item.error ? "Needs attention" : enabled ? "Connected" : "Off"}</StatusPill></SettingsCardRow>
        <SettingsCardRow><div className="min-w-0"><h3 className="text-sm font-medium">Enabled</h3><p className="text-sm text-muted-foreground-2">{isolated ? enabled ? v("Loads automatically inside new SmolVM {missions}.") : v("Off for new SmolVM {missions}.") : enabled ? inventory?.deferred.includes(item.id) ? "Loading when the current response finishes." : item.loaded ? v("Ready for new {missions}.") : v("Enabled for new {missions}.") : v("Off for new {missions}.")}</p></div>
          <Switch aria-label={`Enable ${item.name}`} checked={enabled} disabled={pending || (Boolean(item.error) && !enabled)} onCheckedChange={checked => checked ? onRequest("enable", item) : onDisable()} /></SettingsCardRow>
      </SettingsCard>
      {item.error && <Feedback error={item.error} />}
      <Feedback error={error} message={message} />
      {technicalMessage && <p className="text-sm text-muted-foreground-2">{technicalMessage}</p>}
      <section className="flex flex-col gap-3">
        <div><h3 className="text-base font-medium">Permissions</h3><p className="text-sm text-muted-foreground-2">What this plugin may do once enabled</p></div>
        <SettingsCard className="mx-0">{item.capabilities.length ? item.capabilities.map(capability => <div key={capability} className="p-4 text-sm break-words">{capability}</div>) : <div className="p-4 text-sm text-muted-foreground-2">No extra permissions.</div>}</SettingsCard>
      </section>
      <ToolSkillLists tools={item.tools ?? []} skills={item.skills ?? []} />
      {enabled && !item.loaded && !isolated && <div className="flex flex-col items-start gap-2"><p className="text-sm text-muted-foreground-2">Enabling saves your preference. Loading executes plugin code in the local host; an active response may defer it.</p><Button variant="outline" size="sm" disabled={pending} onClick={event => onRequest("run", item, event.currentTarget)}>Load plugin</Button></div>}
    </div>
  </>;
}
