import { useRef, useState } from "react";
import type { ServicePluginItem, ServicePluginsResponse } from "@0/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GithubLogo, MicrosoftTeamsLogo, SlackLogo } from "@phosphor-icons/react";
import { ArrowUpRight, Check, Cloud, CodeXml, Database, Layers, Plug, ShieldCheck, Waypoints } from "lucide-react";
import { webFetchJson } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { LoadingDots } from "@/console/loading-state";
import { Feedback } from "./control-ui";

function ServiceIcon({ id }: { id: string }) {
  const className = "size-6";
  if (id === "github") return <GithubLogo aria-hidden="true" className={className} weight="fill" />;
  if (id === "slack") return <SlackLogo aria-hidden="true" className={className} />;
  if (id === "teams") return <MicrosoftTeamsLogo aria-hidden="true" className={className} weight="fill" />;
  const Icon = ({ elastic: Database, semgrep: CodeXml, snyk: ShieldCheck, linear: Waypoints, jira: Layers, cloudflare: Cloud } as Record<string, typeof Plug>)[id] ?? Plug;
  return <Icon aria-hidden="true" className={className} />;
}

export function ServicePluginsControl({ filter = "" }: { filter?: string }) {
  const queryClient = useQueryClient();
  const inventory = useQuery({ queryKey: ["console-service-plugins"], queryFn: ({ signal }) => webFetchJson<ServicePluginsResponse>("/api/console/service-plugins", { signal }), refetchInterval: 15_000 });
  const [tab, setTab] = useState<"all" | "connected">("all");
  const [selected, setSelected] = useState<ServicePluginItem | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const trigger = useRef<HTMLButtonElement | null>(null);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["console-service-plugins"] }),
      queryClient.invalidateQueries({ queryKey: ["console-tools"] }),
      queryClient.invalidateQueries({ queryKey: ["workflow-tool-catalog"] }),
    ]);
  };
  const connect = useMutation({
    mutationFn: ({ id, fields: input }: { id: string; fields: Record<string, string> }) => webFetchJson(`/api/console/service-plugins/${encodeURIComponent(id)}/connect`, { method: "POST", body: JSON.stringify({ fields: input, approved: true }) }),
    onSuccess: async () => { await refresh(); setSelected(null); setFields({}); },
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => webFetchJson(`/api/console/service-plugins/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: refresh,
    onError: () => { void inventory.refetch(); },
  });
  const open = (item: ServicePluginItem, element: HTMLButtonElement) => {
    trigger.current = element;
    connect.reset();
    setFields({ ...item.values });
    setSelected(item);
  };
  const close = () => {
    if (connect.isPending) return;
    setSelected(null);
    setFields({});
    connect.reset();
  };
  const connectedCount = inventory.data?.items.filter(item => item.configured).length ?? 0;
  const items = inventory.data?.items.filter(item => (tab === "all" || item.configured) && `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return <section className="space-y-5" aria-label="Service plugins">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-medium">Service plugins</h2>
      <div className="flex gap-1 rounded-full bg-muted/50 p-1" role="group" aria-label="Filter service plugins">
        <Button variant={tab === "all" ? "secondary" : "ghost"} size="sm" aria-pressed={tab === "all"} onClick={() => setTab("all")}>All</Button>
        <Button variant={tab === "connected" ? "secondary" : "ghost"} size="sm" aria-pressed={tab === "connected"} onClick={() => setTab("connected")}>Connected{connectedCount > 0 ? ` · ${connectedCount}` : ""}</Button>
      </div>
    </div>
    {inventory.isPending && <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><LoadingDots className="console-loading-dots-compact" />Loading service plugins…</div>}
    {inventory.error && <div className="space-y-3"><Feedback error={inventory.error} /><Button variant="secondary" onClick={() => void inventory.refetch()} disabled={inventory.isFetching}>Try again</Button></div>}
    {inventory.data && items.length === 0 && <p className="py-8 text-sm text-muted-foreground">{filter.trim() ? "No service plugins match your search." : "Connect a service to see it here."}</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map(item => <article key={item.id} className="flex min-w-0 flex-col gap-4 rounded-2xl bg-muted/35 p-5 transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/55">
        <div className="flex items-center gap-3"><div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background/60 text-foreground"><ServiceIcon id={item.id} /></div><h3 className="min-w-0 flex-1 text-sm font-medium">{item.name}</h3>{item.configured && <Switch checked={item.enabled} aria-label={`Enable ${item.name}`} disabled={toggle.isPending && toggle.variables?.id === item.id} onCheckedChange={enabled => toggle.mutate({ id: item.id, enabled })} />}</div>
        <p className="flex-1 text-sm leading-6 text-muted-foreground">{item.description}</p>
        <div className="flex items-center justify-between gap-3">
          {item.configured ? <><span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">{item.enabled && <Check aria-hidden="true" className="size-3.5 text-primary-text" />}{item.enabled ? "Connected" : "Off"}</span><Button variant="ghost" size="sm" onClick={event => open(item, event.currentTarget)}>Manage</Button></> : <Button variant="secondary" size="sm" onClick={event => open(item, event.currentTarget)}>Connect</Button>}
        </div>
        {item.error && <Feedback error={item.error} />}
        {toggle.variables?.id === item.id && toggle.error && <Feedback error={toggle.error} />}
      </article>)}
    </div>
    <Dialog open={Boolean(selected)} onOpenChange={isOpen => { if (!isOpen) close(); }}>
      <DialogContent showCloseButton={!connect.isPending} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} onEscapeKeyDown={event => { if (connect.isPending) event.preventDefault(); }} onInteractOutside={event => { if (connect.isPending) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>{selected?.configured ? "Manage" : "Connect"} {selected?.name}</DialogTitle><DialogDescription>{selected?.description}</DialogDescription></DialogHeader>
        {selected && <form id="service-plugin-connect" className="space-y-4" onSubmit={event => { event.preventDefault(); connect.mutate({ id: selected.id, fields }); }}>
          {selected.fields.map(field => <div key={field.key} className="grid gap-2"><label htmlFor={`service-${selected.id}-${field.key}`} className="text-sm font-medium">{field.label}</label><Input id={`service-${selected.id}-${field.key}`} type={field.type === "secret" ? "password" : field.type === "url" ? "url" : "text"} value={fields[field.key] ?? ""} onChange={event => setFields(current => ({ ...current, [field.key]: event.target.value }))} required={field.required && !(selected.configured && field.type === "secret")} placeholder={field.type === "secret" && selected.configured ? "Saved · leave blank to keep" : undefined} disabled={connect.isPending} autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} /></div>)}
          {selected.credentialNote && <p className="text-xs leading-5 text-muted-foreground">{selected.credentialNote}</p>}
          {selected.configured && selected.tools.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">{selected.tools.length} available tools</summary><ul className="mt-3 space-y-3">{selected.tools.map(tool => <li key={tool.name}><p className="font-medium">{tool.name}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{tool.description}</p></li>)}</ul></details>}
          <Feedback error={connect.error} />
        </form>}
        <DialogFooter className="items-center sm:justify-between"><Button variant="link" asChild><a href={selected?.docsUrl} target="_blank" rel="noopener noreferrer">Setup instructions<ArrowUpRight className="size-3.5" /></a></Button><Button type="submit" form="service-plugin-connect" disabled={connect.isPending}>{connect.isPending ? <><LoadingDots className="console-loading-dots-compact" />Connecting…</> : selected?.configured ? "Save and reconnect" : "Connect"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
