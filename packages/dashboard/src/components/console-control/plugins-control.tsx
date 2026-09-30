import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Blocks, Check as CheckIcon, ChevronDown, Palette, RefreshCcw, Search } from "lucide-react";
import { webFetchJson } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingDots } from "@/console/loading-state";
import { Check, Facts, Feedback, SubmitButton, jsonBody } from "./control-ui";
import type { PluginResult, PluginsResponse, SettingsResponse } from "./contracts";

export function PluginsControl({ sessionId }: { sessionId?: string }) {
  const queryClient = useQueryClient();
  const inventory = useQuery({ queryKey: ["console-plugins"], queryFn: ({ signal }) => webFetchJson<PluginsResponse>("/api/console/plugins", { signal }), refetchInterval: 5000 });
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [capabilityApproval, setCapabilityApproval] = useState(false);
  const [runApproval, setRunApproval] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const entries = inventory.data?.items;
    if (entries?.length && !entries.some(entry => `${entry.kind}:${entry.id}` === selectedId)) {
      setSelectedId(`${entries[0].kind}:${entries[0].id}`);
    }
  }, [inventory.data?.items, selectedId]);
  const item = inventory.data?.items.find(entry => `${entry.kind}:${entry.id}` === selectedId);
  const identity = item ? JSON.stringify([item.kind, item.id, item.version, item.capabilities, item.state]) : "";
  useEffect(() => { setCapabilityApproval(false); setRunApproval(false); setMessage(null); }, [identity]);
  const mutate = useMutation({ mutationFn: async (action: "install" | "enable" | "disable" | "run" | "theme") => {
    if (!item) throw new Error("Select a plugin or theme first.");
    if (action === "theme") {
      const result = await webFetchJson<SettingsResponse>("/api/console/settings", { method: "PATCH", body: JSON.stringify({ key: "theme", value: item.id, scope: "global" }) });
      if (result.persisted === false) throw new Error("Couldn't save the theme.");
      return { ok: true, message: "Theme applied." } satisfies PluginResult;
    }
    if (action === "enable" && !capabilityApproval) throw new Error("Approve the permissions first.");
    if (action === "run" && !runApproval) throw new Error("Allow running the plugin first.");
    const payload = action === "install" ? { id: item.id, kind: item.kind }
      : action === "enable" ? { id: item.id, approved: true, capabilities: item.capabilities, version: item.version }
      : { id: item.id };
    const result = await webFetchJson<PluginResult>(`/api/console/plugins/${action}`, jsonBody(payload));
    if (!result.ok) throw new Error(result.message);
    return result;
  }, onSuccess: async result => {
    setMessage(result.message); setCapabilityApproval(false); setRunApproval(false);
    await Promise.all([inventory.refetch(), queryClient.invalidateQueries({ queryKey: ["console-themes"] }), queryClient.invalidateQueries({ queryKey: ["console-settings"] }), queryClient.invalidateQueries({ queryKey: ["console-tools"] })]);
  } });
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
      <p className="text-xs text-muted-foreground">{sessionId ? "Plugin changes apply to new sessions, not this one." : "Plugin changes apply to new sessions."}</p>
    </div>
    {inventory.isPending && <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><LoadingDots className="console-loading-dots-compact" />Loading plugins and themes…</div>}
    {inventory.error && <div className="space-y-3"><Feedback error={inventory.error} /><Button variant="outline" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}>Try again</Button></div>}
    {inventory.data && <>
      {inventory.data.registry.error ? <Feedback error={inventory.data.registry.error} /> : !inventory.data.registry.available && <Feedback error="The plugin registry is offline. Installed plugins are still listed below." />}
      {items.length === 0 ? <div className="space-y-2 py-8 text-sm text-muted-foreground"><p>{filter.trim() ? "No plugins or themes match your search." : "No plugins or themes available."}</p>{filter && <Button variant="ghost" size="sm" onClick={() => setFilter("")}>Clear search</Button>}</div> :
        <div className="grid items-start gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="min-w-0 space-y-1" aria-label="Plugins and themes">
            {items.map(entry => {
              const selected = item?.id === entry.id && item?.kind === entry.kind;
              const Icon = entry.kind === "theme" ? Palette : Blocks;
              return <button key={`${entry.kind}:${entry.id}`} type="button" onClick={() => { setSelectedId(`${entry.kind}:${entry.id}`); mutate.reset(); }} disabled={mutate.isPending} className={`flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors motion-reduce:transition-none focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground/40 disabled:opacity-50 ${selected ? "bg-muted" : "hover:bg-muted/60"}`} aria-pressed={selected}>
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{entry.name}</p><p className="mt-1 text-xs text-muted-foreground">{entry.kind === "theme" ? "Theme" : "Plugin"} · {entry.version}</p><Badge variant="outline" className="mt-2 text-xs">{entry.state}</Badge></div>
                {selected && <CheckIcon className="mt-0.5 size-4 shrink-0" />}
              </button>;
            })}
          </div>
          {item && <section className="min-w-0 space-y-4" aria-label={`${item.name} details`}>
            <div><h3 className="text-base font-medium">{item.name}</h3>{item.description && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.description}</p>}</div>
            {item.error && <Feedback error={item.error} />}
            {item.signature === "unverified" && <p className="rounded-xl bg-muted/40 p-3 text-sm leading-relaxed">Unverified signature. Only install if you trust the source.</p>}
            {item.kind === "plugin" && <div className="space-y-2"><p className="text-sm font-medium">Permissions</p>{item.capabilities.length ? <ul className="list-inside list-disc space-y-1 rounded-xl bg-muted/40 p-3 text-sm break-words">{item.capabilities.map(capability => <li key={capability}>{capability}</li>)}</ul> : <p className="text-sm text-muted-foreground">No extra permissions.</p>}</div>}
            {item.state === "available" && <SubmitButton pending={mutate.isPending} disabled={!inventory.data.registry.available} onClick={() => mutate.mutate("install")}>Install {item.kind}</SubmitButton>}
            {item.kind === "plugin" && item.state === "installed" && <div className="space-y-3"><Check checked={capabilityApproval} onChange={setCapabilityApproval} disabled={mutate.isPending}>I allow {item.name} {item.version} these permissions.</Check><SubmitButton pending={mutate.isPending} disabled={!capabilityApproval} onClick={() => mutate.mutate("enable")}>Enable plugin</SubmitButton></div>}
            {item.kind === "plugin" && item.state === "enabled" && <div className="space-y-3"><Check checked={runApproval} onChange={setRunApproval} disabled={mutate.isPending}>I allow this plugin's code to run.</Check><div className="flex flex-wrap gap-2"><SubmitButton pending={mutate.isPending} disabled={!runApproval} onClick={() => mutate.mutate("run")}>Run plugin</SubmitButton><Button variant="outline" disabled={mutate.isPending} onClick={() => mutate.mutate("disable")}>Disable plugin</Button></div></div>}
            {item.kind === "theme" && item.state === "installed" && <SubmitButton pending={mutate.isPending} onClick={() => mutate.mutate("theme")}>Use theme</SubmitButton>}
            {item.kind === "theme" && item.state === "active" && <p role="status" className="text-sm text-muted-foreground">In use. Change it in Settings.</p>}
            <Feedback error={mutate.error} message={message} />
            <details className="group p-3"><summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-muted-foreground [&::-webkit-details-marker]:hidden"><ChevronDown className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />Plugin information</summary><div className="mt-4"><Facts entries={[["ID", item.id], ["Version", item.version], ["Signature", item.signature], ["Status", item.state], ["Loaded", item.loaded ? "Yes" : "No"]]} /></div></details>
          </section>}
        </div>}
      <details className="group p-3"><summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-muted-foreground [&::-webkit-details-marker]:hidden"><ChevronDown className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />Registry and loaded plugins</summary><div className="mt-4"><Facts entries={[["Registry", inventory.data.registry.url], ["Loaded plugins", inventory.data.host.loadedPluginIds.length ? inventory.data.host.loadedPluginIds.join(", ") : "None"], ["Waiting to load", inventory.data.deferred.length ? inventory.data.deferred.join(", ") : "None"]]} /></div></details>
      {inventory.data.host.tools.length > 0 && <section className="space-y-3"><h2 className="text-sm font-medium">Plugin tools</h2><ul className="space-y-3">{inventory.data.host.tools.map(tool => <li key={tool.name}><p className="text-sm font-medium">{tool.name}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{tool.description}</p></li>)}</ul></section>}
    </>}
  </div>;
}
