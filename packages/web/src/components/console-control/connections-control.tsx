import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CapyChevronDownIcon as ChevronDown, CapyMoreIcon as More, CapyPlusIcon as Plus } from "@/ui/icons/capy";
import { AgentOnboarding } from "@/console/agent-onboarding";
import { formatTokens } from "@/console/format-tokens";
import { useBackendSelection } from "@/backend-context";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CapyGripIcon as Grip } from "@/ui/icons/capy";
import { useConnectionExtras, useConnectionUsage } from "./mcp-api";
import { usageUnavailableNote } from "./mcp-contract";
import { accountDisplayName, disconnectCopy } from "./connection-model";
import { moveBefore, moveId, usageBar } from "./mcp-model";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ModelIcon, ProviderIcon } from "@/components/provider-icon";
import { ModelPicker } from "@/components/model-picker";
import { useModelCatalog } from "@/console/use-model-catalog";
import { SettingsRow, SettingsSection } from "./settings-section";
import { CardHeaderRow } from "./connection-ui";
import { LogoTile } from "@/ui/components/logo-tile";
import { StatusBadge } from "@/ui/components/status-badge";
import { ConnectionSheet, providerSubtitle, providerTitle } from "./connection-sheet";
import { ControlCard, Empty, Feedback, Field, QueryState, SubmitButton, TextField, jsonBody } from "./control-ui";
import type { ModelsResponse, Provider, ProvidersResponse, RuntimeSelection, SessionSnapshot, SessionSummary } from "./contracts";
import { ControlDisclosure } from "./control-disclosure";
import { GitHubPublicationControl } from "./github-publication-control";

export function useProviders() {
  const { webFetchJson } = useBackendApi();
  return useQuery({ queryKey: queryKeys.consoleProviders(), queryFn: ({ signal }) => webFetchJson<ProvidersResponse>("/api/console/providers", { signal }), refetchInterval: query => query.state.data?.providers.some(provider => provider.auth.phase === "running") ? 1000 : false });
}

const connected = (provider: Provider) => provider.configured && provider.diagnostics.valid;
interface ConnectionRow { key: string; provider: Provider; account?: Provider["accounts"][number] }

function connectionRows(providers: Provider[]): ConnectionRow[] {
  return providers.filter(provider => provider.configured || provider.accounts.length > 0).sort((a, b) => Number(b.configured) - Number(a.configured)).flatMap(provider => provider.accounts.length > 0
    ? provider.accounts.map(account => ({ key: `${provider.id}:${account.accountId}`, provider, account }))
    : [{ key: provider.id, provider }]);
}

function accountKind(row: ConnectionRow): string {
  const { provider, account } = row;
  if (!account) return "Provided by environment";
  if (account.status === "signed-out") return "Signed out";
  if (account.status === "reauth-required") return "Sign-in required";
  if (account.kind === "oauth") return account.sharing === false ? "Signed in, plan permission required" : "Subscription";
  return provider.methods.includes("oauth") ? "API key" : "API key";
}

/** One sortable connection row. The handle is the only drag target so the row's own buttons stay clickable. */
function SortableRow({ id, disabled, label, children }: { id: string; disabled: boolean; label: string; children: (handle: React.ReactNode) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const handle = disabled ? null : <Button ref={setActivatorNodeRef} type="button" variant="ghost" size="icon-sm" aria-label={`Reorder ${label}`} className="absolute top-1/2 left-0 z-10 size-6 -translate-y-1/2 cursor-grab touch-none text-muted-foreground-2 active:cursor-grabbing" {...attributes} {...listeners}><Grip /></Button>;
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={isDragging ? "relative z-10 bg-card shadow-lg" : "relative"}>{children(handle)}</div>;
}

/** Capy-style connections: provider tiles with status, an Add sheet, per-account switch and menu, and the models each one serves. */
export function ConnectionsControl({ onConnected, focused = false, onProviderChange }: { onConnected?: () => void; focused?: boolean; onProviderChange?: (providerId: string, connected: boolean) => void }) {
  const { client, webFetchJson } = useBackendApi();
  const hosts = useBackendSelection();
  const hostName = hosts?.backends.find(host => host.id === client.backendId)?.name ?? "this engine";
  const queryClient = useQueryClient();
  const providers = useProviders();
  const [sheet, setSheet] = useState<{ open: boolean; providerId: string | null }>({ open: false, providerId: null });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ConnectionRow | null>(null);
  const disconnectName = (row: ConnectionRow) => accountDisplayName(providerTitle(row.provider), extra.get(row.key)?.label ?? row.account?.label, row.account?.accountId);
  const [selected, setSelected] = useState("");
  const [showAllModels, setShowAllModels] = useState(false);
  const extras = useConnectionExtras();
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const models = useModelCatalog({ backendId: client.backendId, webFetchJson, enabled: Boolean(providers.data?.providers.some(connected)) });
  const list = providers.data?.providers ?? [];
  const extra = new Map((extras.state?.connections ?? []).map(connection => [connection.id, connection]));
  const rows = connectionRows(list).map((row, index) => ({ row, index })).sort((a, b) => a.row.provider.id === b.row.provider.id ? (extra.get(a.row.key)?.order ?? a.index) - (extra.get(b.row.key)?.order ?? b.index) : a.index - b.index).map(entry => entry.row);
  const reorderable = (providerId: string) => extras.supported && rows.filter(row => row.provider.id === providerId && row.account).length > 1;
  const accountIdsOf = (providerId: string) => rows.filter(row => row.provider.id === providerId && row.account).map(row => row.account!.accountId);
  const reorder = (providerId: string, accountIds: string[]) => { if (accountIds.join() !== accountIdsOf(providerId).join()) extras.reorder.mutate({ providerId, accountIds }); };
  const onDragEnd = (event: DragEndEvent) => {
    const from = rows.find(row => row.key === event.active.id); const to = rows.find(row => row.key === event.over?.id);
    if (!from?.account || !to?.account || from.provider.id !== to.provider.id) return;
    reorder(from.provider.id, moveBefore(accountIdsOf(from.provider.id), from.account.accountId, to.account.accountId));
  };
  const spreadProviders = extras.supported ? list.filter(provider => provider.accounts.length > 1) : [];
  const connectedList = list.filter(connected);

  // Onboarding reports which connected provider the next step should configure.
  useEffect(() => {
    if (!focused || !providers.data) return;
    const stillValid = connectedList.some(item => item.id === selected);
    if (!stillValid) setSelected(providers.data.preference?.providerId && connectedList.some(item => item.id === providers.data!.preference!.providerId) ? providers.data.preference.providerId : connectedList[0]?.id ?? "");
  }, [focused, providers.data, connectedList, selected]);
  useEffect(() => { if (focused) onProviderChange?.(selected, connectedList.some(item => item.id === selected)); }, [focused, selected, connectedList, onProviderChange]);

  const change = useMutation({
    mutationFn: (input: { providerId: string; action: "activate" | "disconnect"; accountId: string }) => webFetchJson<ProvidersResponse & { message?: string }>("/api/console/connections", jsonBody(input)),
    onSuccess: async data => { queryClient.setQueryData(queryKeys.consoleProviders(), data); setRemoving(null); await queryClient.invalidateQueries({ queryKey: queryKeys.consoleModels() }); },
  });
  const openSheet = (providerId: string | null = null) => { change.reset(); setSheet({ open: true, providerId }); };
  const modelsFor = (providerId: string) => (models.data?.models ?? []).filter(item => item.provider === providerId);

  const rowView = (row: ConnectionRow) => {
    const { provider, account } = row;
    const healthy = connected(provider) && account?.status !== "signed-out" && account?.status !== "reauth-required";
    const siblings = provider.accounts.length;
    const served = modelsFor(provider.id);
    const open = expanded === row.key;
    const conn = extra.get(row.key);
    const title = conn?.label && conn.label !== provider.label ? conn.label : account?.label && account.label !== provider.label ? account.label : providerTitle(provider);
    const canRename = extras.supported && Boolean(account);
    const editing = renaming?.key === row.key;
    const commitRename = () => { if (!renaming) return; const label = renaming.value.trim(); setRenaming(null); if (label === title) return; extras.rename.mutate({ id: row.key, label: label === "" || label === conn?.defaultLabel ? null : label }); };
    const disabledModels = conn?.disabledModels ?? [];
    const siblingIds = accountIdsOf(provider.id);
    const pickable = focused && healthy;
    return <SortableRow key={row.key} id={row.key} disabled={!account || !reorderable(provider.id)} label={title}>{handle => <div data-slot="connection-row" className={pickable && selected === provider.id ? "bg-secondary/40" : undefined}>
      <div className="group/row flex items-center justify-between gap-3 p-4">{handle}
        <LogoTile className="size-9"><ProviderIcon providerId={provider.id} className="size-5" /></LogoTile>
        <div className="min-w-0 flex-1">
          {editing ? <form className="flex items-center gap-2" onSubmit={event => { event.preventDefault(); commitRename(); }}><Input autoFocus aria-label={`Name for ${title}`} className="h-7 max-w-64" maxLength={80} value={renaming.value} placeholder={conn?.defaultLabel ?? providerTitle(provider)} autoComplete="off" data-1p-ignore data-lpignore="true" onChange={event => setRenaming({ key: row.key, value: event.target.value })} onBlur={commitRename} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setRenaming(null); } }} /></form> : <h3 className="truncate text-sm font-medium text-foreground">{pickable ? <button type="button" aria-pressed={selected === provider.id} onClick={() => setSelected(provider.id)} className="max-w-full truncate rounded-sm text-left outline-none focus-visible:outline-ring-inset focus-visible:outline-2">{title}</button> : title}</h3>}
          <p className="truncate text-sm font-normal text-muted-foreground-2">{providerTitle(provider)} · {accountKind(row)}{providers.data?.preference?.providerId === provider.id ? " · Default" : ""}</p>
          {account && extras.supported && <ConnectionUsageLine id={row.key} providerId={provider.id} title={title} expanded={open} />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge appearance="outline" tone={healthy ? "success" : "warning"}>{healthy ? (account?.active === false ? "Inactive" : "Connected") : "Needs connection"}</StatusBadge>
          {account && siblings > 1 && <Switch aria-label={`Use ${title}`} checked={account.active} disabled={account.active || !healthy || change.isPending} onCheckedChange={next => { if (next) change.mutate({ providerId: provider.id, action: "activate", accountId: account.accountId }); }} />}
          <DropdownMenu>
            <DropdownMenu.Trigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${title}`} />}><More /></DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" sideOffset={4}>
              {canRename && <DropdownMenu.Item onClick={() => setRenaming({ key: row.key, value: title })}>Rename</DropdownMenu.Item>}
              {account && reorderable(provider.id) && siblingIds.indexOf(account.accountId) > 0 && <DropdownMenu.Item onClick={() => reorder(provider.id, moveId(siblingIds, account.accountId, -1))}>Move up</DropdownMenu.Item>}
              {account && reorderable(provider.id) && siblingIds.indexOf(account.accountId) < siblingIds.length - 1 && <DropdownMenu.Item onClick={() => reorder(provider.id, moveId(siblingIds, account.accountId, 1))}>Move down</DropdownMenu.Item>}
              <DropdownMenu.Item onClick={() => openSheet(provider.id)}>Reconnect</DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => { void providers.refetch(); void queryClient.invalidateQueries({ queryKey: queryKeys.consoleModels() }); }}>Refresh status and models</DropdownMenu.Item>
              {account && <DropdownMenu.Item variant="danger" onClick={() => { change.reset(); setRemoving(row); }}>Disconnect</DropdownMenu.Item>}
            </DropdownMenu.Content>
          </DropdownMenu>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`${open ? "Collapse" : "Expand"} ${title}`} aria-expanded={open} onClick={() => setExpanded(open ? null : row.key)}><ChevronDown className={open ? "rotate-180" : undefined} /></Button>
        </div>
      </div>
      {open && <div className="flex flex-col gap-1 px-4 pb-4 pl-16 text-sm">
        {!healthy && provider.diagnostics.message && <p className="text-muted-foreground-2">{provider.diagnostics.message}</p>}
        <p className="text-muted-foreground-2">{served.length > 0 ? `Serves ${served.length} ${served.length === 1 ? "model" : "models"}` : models.isFetching ? "Loading models" : "No models listed for this connection yet"}</p>
        {served.map(item => { const off = disabledModels.includes(item.id); return <div key={item.id} className="flex min-w-0 items-center gap-2 text-foreground"><ModelIcon modelId={item.id} providerId={item.provider} /><span className={off ? "truncate text-muted-foreground-2" : "truncate"}>{item.id}</span>{off && <span className="ml-auto shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground-1">Turned off</span>}{item.contextWindowTokens ? <span className={off ? "shrink-0 text-xs text-muted-foreground-2" : "ml-auto shrink-0 text-xs text-muted-foreground-2"}>{formatTokens(item.contextWindowTokens)} context</span> : null}{canRename && <Switch className={item.contextWindowTokens || off ? undefined : "ml-auto"} aria-label={`Allow ${item.id} on ${title}`} checked={!off} disabled={extras.models.isPending} onCheckedChange={on => extras.models.mutate({ id: row.key, disabled: on ? disabledModels.filter(id => id !== item.id) : [...disabledModels, item.id] })} />}</div>; })}
      </div>}
    </div>}</SortableRow>;
  };

  const connectionsCard = <SettingsSection id="your-connections" title="Your connections" quiet={focused} description={focused ? undefined : `Subscriptions and API keys that run models on ${hostName}`}>
    <CardHeaderRow title={rows.length === 0 ? "No connections" : `${rows.length} ${rows.length === 1 ? "connection" : "connections"}`}><Button type="button" variant="ghost" size="icon-sm" aria-label="Add connection" onClick={() => openSheet()}><Plus /></Button></CardHeaderRow>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}><SortableContext items={rows.map(row => row.key)} strategy={verticalListSortingStrategy}>{rows.map(rowView)}</SortableContext></DndContext>
    {spreadProviders.map(provider => <div key={`spread:${provider.id}`} className="flex items-center justify-between gap-6 p-4"><div className="min-w-0"><h3 className="text-sm font-medium text-foreground">Spread usage across my {providerTitle(provider)} accounts</h3><p className="text-sm text-muted-foreground-2">{v("Each new {mission} starts on the next account in the order above. Chats already running keep theirs.")}</p></div><Switch aria-label={`Spread usage across my ${providerTitle(provider)} accounts`} checked={extras.state?.spread[provider.id] === true} disabled={extras.spread.isPending} onCheckedChange={enabled => extras.spread.mutate({ providerId: provider.id, enabled })} /></div>)}
    {providers.data && rows.length === 0 && <div className="flex items-center justify-between gap-4 p-4 text-sm text-muted-foreground-2"><span>Connect Codex or an API key to start.</span><Button type="button" variant="secondary" size="sm" onClick={() => openSheet()}>Add connection</Button></div>}
  </SettingsSection>;
  const sheetView = <ConnectionSheet open={sheet.open} onOpenChange={open => setSheet(current => ({ ...current, open }))} providers={list} initialProviderId={sheet.providerId} hostName={hostName} onConnected={id => { if (focused) setSelected(id); onConnected?.(); }} />;
  const feedback = <Feedback error={change.error ?? extras.rename.error ?? extras.reorder.error ?? extras.spread.error ?? extras.models.error} />;

  if (focused) return <div className="flex flex-col gap-4">
    <QueryState pending={providers.isPending} error={providers.error} retry={providers.refetch} />
    {providers.data && connectionsCard}{feedback}{sheetView}
  </div>;

  const allModels = models.data?.models.filter(item => list.some(provider => provider.id === item.provider && connected(provider))) ?? [];
  const shownModels = showAllModels ? allModels : allModels.slice(0, 8);
  return <>
    <QueryState pending={providers.isPending} error={providers.error} retry={providers.refetch} />
    {providers.data && <>
      {connectionsCard}{feedback}
      <SettingsSection id="models" title="Models" description="Every model served by your connections" action={<Button variant="ghost" size="sm" render={<Link to="/models" />}>Choose a model</Button>}>
        {allModels.length === 0 ? <div className="p-4 text-sm text-muted-foreground-2">{models.isFetching ? "Loading models" : "Connect a provider to see its models."}</div> : <>
          {shownModels.map(item => <div key={`${item.provider}:${item.id}`} className="flex items-center gap-3 px-4 py-3 text-sm"><ModelIcon modelId={item.id} providerId={item.provider} className="size-4" /><span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.id}</span><span className="hidden shrink-0 text-xs text-muted-foreground-2 sm:inline">{item.contextWindowTokens ? `${formatTokens(item.contextWindowTokens)} context` : "Context unknown"}</span><span className="shrink-0 text-xs text-muted-foreground-1">{providerTitle(list.find(provider => provider.id === item.provider) ?? { id: item.provider, label: item.provider })}</span></div>)}
          {allModels.length > shownModels.length && <button type="button" onClick={() => setShowAllModels(true)} className="w-full p-3 text-center text-sm text-muted-foreground-1 outline-none hover:bg-secondary/40 focus-visible:outline-ring-inset focus-visible:outline-2">Show {allModels.length - shownModels.length} more</button>}
        </>}
      </SettingsSection>
      <SettingsSection id="coding-agents" title="Coding agents" description={v("Run 0 from Claude Code, Codex, Cursor or OpenCode. This exposes 0's tools to that agent; it does not sign its account into web {missions}.")}>
        <SettingsRow id="coding-agent-setup" label="Use 0 from your coding agent" description="Copy the setup prompt and paste it into your agent."><AgentOnboarding /></SettingsRow>
      </SettingsSection>
      <GitHubPublicationControl />
    </>}
    <ConfirmDialog open={Boolean(removing)} onOpenChange={open => { if (!open) setRemoving(null); }} pending={change.isPending} spinner destructive
      title={`Disconnect ${removing ? disconnectName(removing) : ""}?`}
      description={removing ? disconnectCopy(removing.provider.id, disconnectName(removing), hostName, removing.provider.accounts.length) : ""}
      error={<Feedback error={change.error} />} confirmLabel="Disconnect" onConfirm={() => removing?.account && change.mutate({ providerId: removing.provider.id, action: "disconnect", accountId: removing.account.accountId })} />
    {sheetView}
  </>;
}

/** Real usage only. OpenRouter rows load on sight; other providers load on expand and show a muted note, never a made-up number. */
function ConnectionUsageLine({ id, providerId, title, expanded }: { id: string; providerId: string; title: string; expanded: boolean }) {
  const usage = useConnectionUsage(id, providerId === "openrouter" || expanded);
  if (usage.isPending || usage.isError || !usage.data) return null;
  const bar = usageBar(usage.data);
  if (bar) return <div className="mt-1.5 flex max-w-72 flex-col gap-1"><div role="progressbar" aria-label={`${title} ${bar.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar.usedPercent)} className="h-1 overflow-hidden rounded-full bg-secondary"><div className={bar.usedPercent >= 90 ? "h-full bg-warning" : "h-full bg-primary"} style={{ width: `${bar.usedPercent}%` }} /></div><p className="text-xs text-muted-foreground-2">{bar.caption}{bar.breakdown.length ? ` · ${bar.breakdown.join(" · ")}` : ""}</p></div>;
  return expanded ? <p className="mt-1 text-xs text-muted-foreground-2">{usageUnavailableNote(usage.data.reason)}</p> : null;
}

export { ModelsControl } from "./models-control";
