import { ControlDisclosure } from "./control-disclosure";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Blocks, Palette, RefreshCcw, Search } from "lucide-react";
import { webFetchJson } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingDots } from "@/console/loading-state";
import { Facts, Feedback, SubmitButton, jsonBody } from "./control-ui";
import type { PluginItem, PluginResult, PluginsResponse, SettingsResponse } from "./contracts";

export function PluginsControl({ sessionId }: { sessionId?: string }) {
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
  const queryClient = useQueryClient();
  const inventory = useQuery({ queryKey: ["console-plugins"], queryFn: ({ signal }) => webFetchJson<PluginsResponse>("/api/console/plugins", { signal }), refetchInterval: 5000 });
  const isolated = inventory.data?.executionProfile === "smolvm";
  const [filter, setFilter] = useState("");
  const [confirmation, setConfirmation] = useState<{ action: "install" | "enable" | "run"; item: PluginItem } | null>(null);
  const [technicalMessage, setTechnicalMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mutate = useMutation({ mutationFn: async ({ action, target, approved = false }: { action: "install" | "enable" | "disable" | "run" | "theme"; target: PluginItem; approved?: boolean }) => {
    if (action === "theme") {
      const result = await webFetchJson<SettingsResponse>("/api/console/settings", { method: "PATCH", body: JSON.stringify({ key: "theme", value: target.id, scope: "global" }) });
      if (result.persisted === false) throw new Error("Couldn't save the theme.");
      return { ok: true, message: "Theme applied." } satisfies PluginResult;
    }
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
    await Promise.all([inventory.refetch(), queryClient.invalidateQueries({ queryKey: ["console-themes"] }), queryClient.invalidateQueries({ queryKey: ["console-settings"] }), queryClient.invalidateQueries({ queryKey: ["console-tools"] })]);
    setConfirmation(null);
    setTechnicalMessage(result.message);
    setMessage(action === "enable" ? result.deferred ? "Enabled. Loading after the current response finishes." : "Enabled." : action === "disable" ? "Disabled for new sessions." : action === "install" ? "Installed." : action === "theme" ? "Theme applied." : result.deferred ? "Loading is waiting for the current response to finish." : "Loaded.");
  }, onError: () => { void inventory.refetch(); } });
  const requestConfirmation = (action: "install" | "enable" | "run", target: PluginItem) => { mutate.reset(); setConfirmation({ action, item: target }); };
  const items = inventory.data?.items.filter(entry => `${entry.name} ${entry.id} ${entry.description}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return <div className="space-y-6">
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input data-1p-ignore data-lpignore="true" autoComplete="off" aria-label="Search plugins and themes" type="search" placeholder="Search plugins and themes" value={filter} onChange={event => setFilter(event.target.value)} className="pl-9" />
        </div>
        <Button variant="ghost" size="icon" onClick={() => void inventory.refetch()} disabled={inventory.isFetching || mutate.isPending} aria-label="Refresh plugins and themes" title="Refresh plugins and themes"><RefreshCcw className="size-4" /></Button>
      </div>
      <p className="text-xs text-muted-foreground">{isolated ? "Approved plugins are copied into each new SmolVM chat and run inside its VM. Plugin changes apply to new chats." : sessionId ? "Plugin changes apply to new sessions, not this one." : "Plugin changes apply to new sessions."}</p>
    </div>
    {inventory.isPending && <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><LoadingDots className="console-loading-dots-compact" />Loading plugins and themes…</div>}
    {inventory.error && <div className="space-y-3"><Feedback error={inventory.error} /><Button variant="outline" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}>Try again</Button></div>}
    {inventory.data && <>
      {inventory.data.registry.error ? <Feedback error={inventory.data.registry.error} /> : !inventory.data.registry.available && <Feedback error="The plugin registry is offline. Installed plugins are still listed below." />}
      {items.length === 0 ? <div className="space-y-2 py-8 text-sm text-muted-foreground"><p>{filter.trim() ? "No plugins or themes match your search." : "No plugins or themes available."}</p>{filter && <Button variant="ghost" size="sm" onClick={() => setFilter("")}>Clear search</Button>}</div> :
        <div className="space-y-4" aria-label="Plugins and themes">
          {items.map(item => {
            const Icon = item.kind === "theme" ? Palette : Blocks;
            const feedbackForItem = mutate.variables?.target.id === item.id && mutate.variables?.target.kind === item.kind;
            const description = item?.description && !inventory.data?.host.tools.some(tool => tool.name === item.description) && !/^[a-z][a-z0-9_]*(?:, [a-z][a-z0-9_]*)+$/.test(item.description) && !/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(item.description) ? item.description : "";
            return <section key={`${item.kind}:${item.id}`} className="min-w-0 space-y-4 rounded-2xl border border-foreground/10 p-4" aria-label={item.name}>
            <div className="flex items-start gap-3">
              <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{item.name}</h3><p className="mt-1 text-xs text-muted-foreground">{item.kind === "theme" ? "Theme" : "Plugin"} · {item.version}</p></div>
              <Badge variant="outline" className="shrink-0 text-xs">{item.state}</Badge>
            </div>
            {description && <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>}
            {item.error && <Feedback error={item.error} />}
            {item.state === "available" && <SubmitButton pending={mutate.isPending} disabled={!inventory.data.registry.available || Boolean(item.error)} onClick={event => { confirmationTrigger.current = event.currentTarget; requestConfirmation("install", item); }}>Install {item.kind}</SubmitButton>}
            {item.kind === "plugin" && item.state !== "available" && <div className="flex items-center justify-between gap-4 border-t border-foreground/5 pt-4"><div><p className="text-sm font-medium">Enable plugin</p><p className="mt-1 text-xs text-muted-foreground">{isolated ? item.state === "enabled" ? "Loads automatically inside new SmolVM chats." : "Off for new SmolVM chats." : item.state === "enabled" ? inventory.data.deferred.includes(item.id) ? "Loading when the current response finishes." : item.loaded ? "Ready for new sessions." : "Enabled for new sessions." : "Off for new sessions."}</p></div><Switch onClick={event => { confirmationTrigger.current = event.currentTarget; }} aria-label={`Enable ${item.name}`} checked={item.state === "enabled"} disabled={mutate.isPending || (Boolean(item.error) && item.state !== "enabled")} onCheckedChange={checked => checked ? requestConfirmation("enable", item) : mutate.mutate({ action: "disable", target: item })} /></div>}
            {item.kind === "theme" && item.state === "installed" && <SubmitButton pending={mutate.isPending} onClick={() => mutate.mutate({ action: "theme", target: item })}>Use theme</SubmitButton>}
            {item.kind === "theme" && item.state === "active" && <p role="status" className="text-sm text-muted-foreground">In use. Change it in Settings.</p>}
            {feedbackForItem && <Feedback error={mutate.error} message={message} />}
            <ControlDisclosure title={item.kind === "theme" ? "Theme details" : "Permissions and details"}><div className="mt-4 space-y-4"><Facts entries={[["ID", item.id], ["Version", item.version], ["Signature", item.signature], ["Status", item.state], ["Loaded in current host", item.loaded ? "Yes" : "No"]]} />
              {item.kind === "plugin" && <div><p className="text-xs text-muted-foreground">Permissions</p>{item.capabilities.length ? <ul className="mt-2 list-inside list-disc space-y-1 text-sm break-words">{item.capabilities.map(capability => <li key={capability}>{capability}</li>)}</ul> : <p className="mt-1 text-sm">No extra permissions.</p>}</div>}
              {item.kind === "plugin" && item.state === "enabled" && !item.loaded && !isolated && <div className="space-y-2"><p className="text-xs leading-5 text-muted-foreground">Enabling saves your preference. Loading executes plugin code in the local host; an active response may defer it.</p><Button variant="secondary" disabled={mutate.isPending} onClick={event => { confirmationTrigger.current = event.currentTarget; requestConfirmation("run", item); }}>Load plugin</Button></div>}
              {feedbackForItem && technicalMessage && <p className="text-xs leading-5 text-muted-foreground">{technicalMessage}</p>}
            </div></ControlDisclosure>
          </section>;
          })}
        </div>}
      <ControlDisclosure title="Registry details"><div className="mt-4 space-y-4"><Facts entries={[["Registry", inventory.data.registry.url], ["Loaded plugins", inventory.data.host.loadedPluginIds.length ? inventory.data.host.loadedPluginIds.join(", ") : "None"], ["Waiting to load", inventory.data.deferred.length ? inventory.data.deferred.join(", ") : "None"]]} />
        {inventory.data.host.tools.length > 0 && <div className="space-y-3"><p className="text-xs text-muted-foreground">Plugin tools</p><ul className="space-y-3">{inventory.data.host.tools.map(tool => <li key={tool.name}><p className="text-sm font-medium">{tool.name}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{tool.description}</p></li>)}</ul></div>}
      </div></ControlDisclosure>
    </>}
    <Dialog open={Boolean(confirmation)} onOpenChange={open => { if (!open && !mutate.isPending) { setConfirmation(null); mutate.reset(); } }}><DialogContent showCloseButton={!mutate.isPending} onCloseAutoFocus={event => { event.preventDefault(); confirmationTrigger.current?.focus(); }} onEscapeKeyDown={event => { if (mutate.isPending) event.preventDefault(); }} onInteractOutside={event => { if (mutate.isPending) event.preventDefault(); }}><DialogHeader><DialogTitle>{confirmation?.action === "enable" ? "Enable" : confirmation?.action === "run" ? "Load" : "Install"} {confirmation?.item.name}</DialogTitle><DialogDescription>{confirmation?.action === "enable" ? isolated ? "Approve this version and its permissions for new SmolVM chats. Its files will be copied and its code loaded inside the VM automatically. Existing chats keep their current tools." : "Approve this version and its permissions, and allow its code to load in the local host. Existing sessions keep their current tools." : confirmation?.action === "run" ? "This runs the plugin's code in the local host. An active response may defer loading." : "Install this artifact from the configured registry."}</DialogDescription></DialogHeader>
      {confirmation && <div className="space-y-3 text-sm"><p className="text-muted-foreground">{confirmation.item.name} {confirmation.item.version}</p>{confirmation.action === "install" && confirmation.item.signature === "unverified" && <p className="leading-6">The signature is unverified. Only install if you trust this source.</p>}{confirmation.item.kind === "plugin" && confirmation.action !== "run" && <div><p className="font-medium">Permissions</p>{confirmation.item.capabilities.length ? <ul className="mt-2 list-inside list-disc space-y-1 break-words">{confirmation.item.capabilities.map(capability => <li key={capability}>{capability}</li>)}</ul> : <p className="mt-2 text-muted-foreground">No extra permissions.</p>}</div>}<Feedback error={mutate.error} /></div>}
      <DialogFooter><Button variant="ghost" disabled={mutate.isPending} onClick={() => { setConfirmation(null); mutate.reset(); }}>Cancel</Button><SubmitButton pending={mutate.isPending} onClick={() => { if (confirmation) mutate.mutate({ action: confirmation.action, target: confirmation.item, approved: true }); }}>{confirmation?.action === "enable" ? "Approve and enable" : confirmation?.action === "run" ? "Allow and load" : "Install"}</SubmitButton></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
