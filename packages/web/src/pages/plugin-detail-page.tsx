import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Blocks, Terminal } from "lucide-react";
import { CapyArrowUpRightIcon as ArrowUpRight, CapyCheckIcon as Check, CapyMoreIcon as More } from "@/ui/icons/capy";
import { PageContent } from "@/components/page-header";
import { EmptyState, LoadingState } from "@/components/state-panel";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ConfirmDialog, FormDialog } from "@/ui/components/confirm-dialog";
import { LogoTile } from "@/ui/components/logo-tile";
import { SettingsCard, SettingsCardRow } from "@/ui/components/settings-card";
import { StatusBadge } from "@/ui/components/status-badge";
import { useBreadcrumbLabel } from "@/lib/breadcrumbs";
import { displayToolDescription, displayToolName } from "@/lib/mcp-tool-name";
import { EntryLogo } from "@/components/console-control/mcp-ui";
import { CardHeaderRow } from "@/components/console-control/connection-ui";
import { Feedback, TextField } from "@/components/console-control/control-ui";
import { useMcpServers, type McpActions } from "@/components/console-control/mcp-api";
import { STDIO_WARNING } from "@/components/console-control/mcp-sheets";
import { countLabel } from "@/components/console-control/mcp-model";
import { PluginConfirmDialog, usePluginManager, type PluginManager } from "@/components/console-control/plugin-manager";
import { ServiceIcon, useServicePlugins, type ServicePluginActions } from "@/components/console-control/service-plugins-control";
import { buildPluginView, parsePluginRef, sliceMore, type PluginPageView, type PluginSource } from "@/components/console-control/plugin-detail-model";
import type { McpServerEntry } from "@/components/console-control/mcp-contract";
import type { PluginItem } from "@/components/console-control/contracts";
import type { ServicePluginItem } from "@0/engine/shared";

/** One fact in the right rail: small muted label over the value. */
function RailFact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1"><dt className="text-sm text-muted-foreground-2">{label}</dt><dd className="min-w-0 text-sm break-words text-foreground">{children}</dd></div>;
}

/** Rows of name and description inside a card, with Capy's "View N more" below the card. */
function RowsCard({ title, rows, icon, empty }: { title: string; rows: { name: string; description: string }[]; icon: ReactNode; empty?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { visible, hidden, label } = sliceMore(rows, 5, expanded);
  return <section className="flex min-w-0 flex-col gap-3" aria-label={title}>
    <SettingsCard className="mx-0">
      <CardHeaderRow title={title} />
      {visible.length === 0 && empty && <div className="p-4 text-sm text-muted-foreground-2">{empty}</div>}
      {visible.map(row => {
        const description = displayToolDescription(row.description);
        return <SettingsCardRow key={row.name} className="items-start justify-start gap-4">
          <LogoTile className="size-8">{icon}</LogoTile>
          <div className="min-w-0 flex-1"><h3 title={row.name} className="text-sm font-medium break-words text-foreground">{displayToolName(row.name)}</h3>{description && <p className="text-sm break-words text-muted-foreground-2">{description}</p>}</div>
        </SettingsCardRow>;
      })}
    </SettingsCard>
    {label && <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setExpanded(true)} aria-label={`${label} ${hidden === 1 ? "row" : "rows"} in ${title}`}>{label}</Button>}
    {expanded && rows.length > 5 && <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setExpanded(false)}>Show fewer</Button>}
  </section>;
}

function McpCardView({ view }: { view: PluginPageView }) {
  const mcp = view.mcp;
  if (!mcp) return null;
  const fact = (label: string, value: ReactNode, mono = false) => <SettingsCardRow className="items-start gap-4"><span className="w-28 shrink-0 text-sm text-muted-foreground-2">{label}</span><span className={`min-w-0 flex-1 text-sm break-all text-foreground${mono ? " font-mono text-xs" : ""}`}>{value}</span></SettingsCardRow>;
  return <SettingsCard className="mx-0" aria-label="MCP server">
    <CardHeaderRow title="1 MCP server" />
    <SettingsCardRow className="justify-start gap-4"><LogoTile className="size-8"><Terminal aria-hidden="true" className="size-4" /></LogoTile><div className="min-w-0"><h3 className="text-sm font-medium break-words text-foreground">{view.name}</h3><p className="text-sm text-muted-foreground-2">{mcp.transport}</p></div></SettingsCardRow>
    {fact(mcp.target.label, mcp.target.value, mcp.target.label === "Command")}
    {mcp.cwd && fact("Runs in", mcp.cwd, true)}
    {mcp.envKeys.length > 0 && fact("Environment", <>{mcp.envKeys.join(", ")} <span className="text-muted-foreground-2">(values hidden)</span></>, true)}
    {mcp.headerNames.length > 0 && fact("Headers", <>{mcp.headerNames.join(", ")} <span className="text-muted-foreground-2">(values hidden)</span></>, true)}
    {fact("Last test", mcp.lastTest)}
  </SettingsCard>;
}

function PermissionsList({ items }: { items: string[] }) {
  return items.length ? <ul className="flex flex-col gap-2">{items.map(item => <li key={item} className="flex gap-2"><span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground-2" /><span>{item}</span></li>)}</ul> : <span className="text-muted-foreground-2">No extra permissions</span>;
}

function Rail({ view }: { view: PluginPageView }) {
  return <aside aria-label="Plugin details" className="flex min-w-0 flex-col gap-6 border-t-[0.5px] border-border-2 pt-8 lg:border-t-0 lg:pt-1">
    <dl className="flex flex-col gap-5">
      {view.rail.map(entry => <RailFact key={entry.label} label={entry.label}>{entry.href
        ? <a href={entry.href} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 underline-offset-4 hover:underline${entry.mono ? " font-mono text-xs" : ""}`}>{entry.value}<ArrowUpRight aria-hidden="true" className="size-(--icon-sm) shrink-0" /></a>
        : <span className={entry.mono ? "font-mono text-xs break-all" : undefined}>{entry.value}</span>}</RailFact>)}
      <RailFact label="Permissions"><PermissionsList items={view.permissions} /></RailFact>
    </dl>
    {view.reportUrl && <a href={view.reportUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-muted-foreground-1 underline-offset-4 hover:underline">Report an issue<ArrowUpRight aria-hidden="true" className="size-(--icon-sm)" /></a>}
  </aside>;
}

/** The Capy 'Added' state: a check and the word. Anything else is a quiet status badge. */
function StateLabel({ view }: { view: PluginPageView }) {
  if (view.status.added) return <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground-1"><Check aria-hidden="true" className="size-(--icon-sm)" />{view.status.label}</span>;
  return <StatusBadge appearance="outline" tone={view.status.tone}>{view.status.label}</StatusBadge>;
}

type Dialog = "connect" | "disconnect" | "remove" | "enable-mcp" | null;

/** Everything that changes the plugin: the primary state/button plus a menu of the rest. All dialogs live here so each action keeps its confirmation. */
function Actions({ view, source, manager, service, mcp, onDone }: { view: PluginPageView; source: PluginSource; manager: PluginManager; service: ServicePluginActions; mcp: McpActions; onDone: () => void }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [testNote, setTestNote] = useState<string | null>(null);
  const key = `${view.ref.kind}:${view.ref.id}`;
  useEffect(() => { setDialog(null); setTestNote(null); service.connect.reset(); service.toggle.reset(); service.forget.reset(); mcp.update.reset(); mcp.remove.reset(); mcp.test.reset(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const pending = manager.mutate.isPending;
  const close = () => setDialog(null);

  let primary: ReactNode = <StateLabel view={view} />;
  let menu: ReactNode = null;
  let dialogs: ReactNode = null;
  let errors: unknown = null;

  if (source.kind === "plugin") {
    const item: PluginItem = source.item;
    const registryDown = !manager.inventory.data?.registry.available && item.source !== "github";
    errors = manager.mutate.variables?.target.id === item.id ? manager.mutate.error : null;
    if (item.state === "available") primary = <Button disabled={pending || registryDown || Boolean(item.error)} onClick={event => manager.requestConfirmation("install", item, event.currentTarget)}>Add</Button>;
    else if (item.state === "installed") primary = <Button disabled={pending || Boolean(item.error)} onClick={event => manager.requestConfirmation("enable", item, event.currentTarget)}>Enable</Button>;
    if (item.state === "enabled") menu = <>
      {!item.loaded && !manager.isolated && <DropdownMenu.Item onClick={() => manager.requestConfirmation("run", item)}>Load plugin</DropdownMenu.Item>}
      <DropdownMenu.Item disabled={pending} onClick={() => manager.mutate.mutate({ action: "disable", target: item })}>Turn off</DropdownMenu.Item>
    </>;
  } else if (source.kind === "service") {
    const item = source.item as ServicePluginItem;
    errors = service.toggle.error ?? service.forget.error;
    primary = !item.configured ? <Button onClick={() => { setFields({ ...item.values }); service.connect.reset(); setDialog("connect"); }}>Connect</Button> : <StateLabel view={view} />;
    if (item.configured) menu = <>
      <DropdownMenu.Item disabled={service.toggle.isPending} onClick={() => service.toggle.mutate({ id: item.id, enabled: !item.enabled })}>{item.enabled ? "Turn off" : "Turn on"}</DropdownMenu.Item>
      <DropdownMenu.Item onClick={() => { setFields({ ...item.values }); service.connect.reset(); setDialog("connect"); }}>Edit connection</DropdownMenu.Item>
      <DropdownMenu.Item variant="danger" onClick={() => { service.forget.reset(); setDialog("disconnect"); }}>Disconnect</DropdownMenu.Item>
    </>;
    dialogs = <>
      <FormDialog open={dialog === "connect"} onOpenChange={open => { if (!open) close(); }} pending={service.connect.isPending} title={item.configured ? `Update ${item.name}` : `Connect ${item.name}`}
        description={item.configured ? "Leave a secret blank to keep it." : undefined}
        submitLabel={item.configured ? "Save and reconnect" : "Connect"} error={<Feedback error={service.connect.error} />}
        onSubmit={event => { event.preventDefault(); service.connect.mutate({ id: item.id, fields }, { onSuccess: close }); }}>
        {item.fields.map(field => <TextField key={field.key} label={field.label} type={field.type === "secret" ? "password" : field.type === "url" ? "url" : "text"} value={fields[field.key] ?? ""} onChange={event => setFields(current => ({ ...current, [field.key]: event.target.value }))} required={field.required && !(item.configured && field.type === "secret")} placeholder={field.type === "secret" && item.configured ? "Saved. Leave blank to keep" : undefined} disabled={service.connect.isPending} autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} />)}
        {item.credentialNote && <p className="text-sm text-muted-foreground-2">{item.credentialNote}</p>}
      </FormDialog>
      <ConfirmDialog open={dialog === "disconnect"} onOpenChange={open => { if (!open) close(); }} pending={service.forget.isPending} spinner destructive confirmLabel="Disconnect" title={`Disconnect ${item.name}?`}
        description="The saved credentials are deleted and its tools are hidden from new missions." error={<Feedback error={service.forget.error} />}
        onConfirm={() => service.forget.mutate({ id: item.id }, { onSuccess: close })} />
    </>;
  } else {
    const item: McpServerEntry = source.item;
    const stdio = item.transport === "stdio";
    errors = mcp.update.error ?? (mcp.test.isError ? mcp.test.error : null);
    if (!item.enabled) primary = <Button disabled={mcp.update.isPending} onClick={() => { mcp.update.reset(); setDialog("enable-mcp"); }}>Turn on</Button>;
    menu = <>
      <DropdownMenu.Item disabled={mcp.test.isPending} onClick={() => mcp.test.mutate({ id: item.id }, { onSuccess: result => setTestNote(`Connected. ${countLabel(result.toolCount, "tool")} available.`) })}>Test connection</DropdownMenu.Item>
      {item.enabled && <DropdownMenu.Item disabled={mcp.update.isPending} onClick={() => mcp.update.mutate({ id: item.id, enabled: false })}>Turn off</DropdownMenu.Item>}
      <DropdownMenu.Item variant="danger" onClick={() => { mcp.remove.reset(); setDialog("remove"); }}>Remove</DropdownMenu.Item>
    </>;
    dialogs = <>
      <ConfirmDialog open={dialog === "enable-mcp"} onOpenChange={open => { if (!open) close(); }} pending={mcp.update.isPending} spinner confirmDisabled={!item.fingerprint} confirmLabel="Approve and turn on" title={`Turn on ${item.name}`}
        description={stdio ? `Turning this on lets missions start the command below on this machine as your user. ${STDIO_WARNING}` : "Turning this on lets missions call this server's tools. Its output is untrusted data."} error={<Feedback error={mcp.update.error} />}
        onConfirm={() => mcp.update.mutate({ id: item.id, enabled: true, approvedFingerprint: item.fingerprint }, { onSuccess: close })}>
        {view.mcp && <pre aria-label="Exact command" className="overflow-x-auto rounded-md bg-secondary p-3 font-mono text-xs break-all whitespace-pre-wrap">{view.mcp.target.value}</pre>}
      </ConfirmDialog>
      <ConfirmDialog open={dialog === "remove"} onOpenChange={open => { if (!open) close(); }} pending={mcp.remove.isPending} spinner destructive confirmLabel="Remove" title={`Remove ${item.name}?`}
        description="Missions can no longer use its tools. Saved environment values and headers are deleted." error={<Feedback error={mcp.remove.error} />}
        onConfirm={() => mcp.remove.mutate({ id: item.id }, { onSuccess: () => { close(); onDone(); } })} />
    </>;
  }

  return <>
    <div className="flex shrink-0 items-center gap-2">
      {primary}
      {menu && <DropdownMenu>
        <DropdownMenu.Trigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`More actions for ${view.name}`} />}><More /></DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" sideOffset={4}>{menu}</DropdownMenu.Content>
      </DropdownMenu>}
    </div>
    {dialogs}
    <ActionFeedback error={errors} message={source.kind === "plugin" && manager.mutate.variables?.target.id === source.item.id ? manager.message : testNote} technical={source.kind === "plugin" ? manager.technicalMessage : null} />
  </>;
}

function ActionFeedback({ error, message, technical }: { error: unknown; message: string | null; technical: string | null }) {
  if (!error && !message) return null;
  return <div className="basis-full"><Feedback error={error} message={message} />{!error && technical && <p className="mt-2 text-sm text-muted-foreground-2">{technical}</p>}</div>;
}

export function PluginDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const ref = parsePluginRef(params.pluginId);
  const manager = usePluginManager();
  const service = useServicePlugins();
  const mcp = useMcpServers();

  let source: PluginSource | null = null;
  if (ref) {
    const plugin = manager.inventory.data?.items.find(item => item.kind === "plugin" && item.id === ref.id);
    const svc = service.inventory.data?.items.find(item => item.id === ref.id);
    const custom = mcp.servers.find(item => item.id === ref.id);
    const order = ref.kind ? [ref.kind] : ["service", "mcp", "plugin"] as const;
    for (const kind of order) {
      if (kind === "service" && svc) { source = { kind, item: svc }; break; }
      if (kind === "mcp" && custom) { source = { kind, item: custom }; break; }
      if (kind === "plugin" && plugin) { source = { kind, item: plugin }; break; }
    }
  }
  const loading = manager.inventory.isPending || service.inventory.isPending || (mcp.supported && mcp.query.isPending);
  const view = source ? buildPluginView(source, { toolNames: manager.inventory.data?.host.tools.map(tool => tool.name) }) : null;
  useBreadcrumbLabel(view?.name);

  if (!ref || (!source && !loading)) return <PageContent><EmptyState title="Plugin not found" body="It may have been removed, or the link is out of date." action={<Button variant="outline" render={<Link to="/plugins" />}>Back to plugins</Button>} /></PageContent>;
  if (!view || !source) return <PageContent width="wide"><LoadingState label="Loading plugin…" variant="cards" /></PageContent>;

  const icon = view.kindLabel === "MCP server" ? source.kind === "service" ? <ServiceIcon id={source.item.id} className="size-6" /> : <Terminal aria-hidden="true" className="size-6" /> : <Blocks aria-hidden="true" className="size-6" />;
  const hasTools = view.tools.length > 0;
  return <PageContent width="wide" className="gap-0">
    <div className="grid min-w-0 grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <article className="flex min-w-0 flex-col gap-8" aria-label={view.name}>
        <header className="flex min-w-0 flex-col gap-4">
          <div className="relative w-fit">
            <EntryLogo logo={view.logo} className="size-14 rounded-xl" fallback={icon} />
            {view.verified && <span role="img" aria-label={view.verifiedBy ? `Verified by ${view.verifiedBy}` : "Verified"} className="absolute -right-1.5 -bottom-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background"><Check aria-hidden="true" className="size-3" /></span>}
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3"><h1 className="text-2xl font-medium tracking-tight break-words text-foreground">{view.name}</h1><span className="text-sm text-muted-foreground-2">{view.kindLabel}</span></div>
            <Actions view={view} source={source} manager={manager} service={service} mcp={mcp} onDone={() => navigate("/plugins")} />
          </div>
          {view.description && <p className="text-base text-muted-foreground-1">{view.description}</p>}
        </header>
        {view.skills.length > 0 && <RowsCard title={countLabel(view.skills.length, "skill")} rows={view.skills} icon={<Blocks aria-hidden="true" className="size-4" />} />}
        {(hasTools || view.kindLabel === "MCP server") && <RowsCard title={countLabel(view.tools.length, "tool")} rows={view.tools} icon={<Blocks aria-hidden="true" className="size-4" />} empty={source.kind === "service" ? "Connect to see the tools this server offers." : "No tools listed yet. Run Test connection from the menu to list them."} />}
        <McpCardView view={view} />
        <PluginConfirmDialog manager={manager} />
      </article>
      <Rail view={view} />
    </div>
  </PageContent>;
}
