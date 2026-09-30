import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { webFetchJson } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, ControlCard, Empty, Facts, Feedback, QueryState, SubmitButton, TextField, jsonBody } from "./control-ui";
import type { PluginResult, PluginsResponse, SettingsResponse } from "./contracts";

export function PluginsControl({ sessionId }: { sessionId?: string }) {
  const queryClient = useQueryClient();
  const inventory = useQuery({ queryKey: ["console-plugins"], queryFn: ({ signal }) => webFetchJson<PluginsResponse>("/api/console/plugins", { signal }), refetchInterval: 5000 });
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [capabilityApproval, setCapabilityApproval] = useState(false);
  const [runApproval, setRunApproval] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
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
  return <div className="space-y-5"><QueryState pending={inventory.isPending} error={inventory.error} retry={inventory.refetch} />
    {inventory.data && <><ControlCard title="Plugins & themes">{inventory.data.registry.error ? <Feedback error={inventory.data.registry.error} /> : !inventory.data.registry.available && <Feedback error="Plugin registry is offline." />}<div className="flex items-end gap-3"><div className="min-w-0 flex-1"><TextField label="Search" type="search" value={filter} onChange={event => setFilter(event.target.value)} /></div><Button variant="outline" onClick={() => void inventory.refetch()} disabled={inventory.isFetching} aria-label="Refresh"><RefreshCcw className="size-4" /></Button></div><p className="text-xs text-muted-foreground">{sessionId ? "Changes apply to new sessions, not this one." : "Changes apply to new sessions."}</p><details><summary className="cursor-pointer text-xs text-muted-foreground">Details</summary><div className="mt-3"><Facts entries={[["Registry", inventory.data.registry.url], ["Loaded plugins", inventory.data.host.loadedPluginIds.length ? inventory.data.host.loadedPluginIds.join(", ") : "None"], ["Waiting to load", inventory.data.deferred.length ? inventory.data.deferred.join(", ") : "None"]]} /></div></details></ControlCard>
      <div className="grid gap-5 xl:grid-cols-[minmax(13rem,0.8fr)_minmax(0,1.2fr)]"><ControlCard title="Available">{items.length === 0 ? <Empty>Nothing found.</Empty> : <div className="space-y-2">{items.map(entry => <button key={`${entry.kind}:${entry.id}`} onClick={() => { setSelectedId(`${entry.kind}:${entry.id}`); mutate.reset(); }} className={`w-full rounded-md border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${item?.id === entry.id && item?.kind === entry.kind ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"}`} aria-pressed={item?.id === entry.id && item?.kind === entry.kind}><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{entry.name}</span><Badge variant="outline">{entry.state}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{entry.kind} · {entry.version}</p></button>)}</div>}</ControlCard>
        <ControlCard title={item?.name ?? "Details"} description={item?.description}>{item ? <><details><summary className="cursor-pointer text-xs text-muted-foreground">Details</summary><div className="mt-3"><Facts entries={[["ID", item.id], ["Version", item.version], ["Signature", item.signature], ["Status", item.state], ["Loaded", item.loaded ? "Yes" : "No"]]} /></div></details>{item.error && <Feedback error={item.error} />}{item.signature === "unverified" && <p className="rounded-md border border-border bg-muted/20 p-3 text-sm">Unverified signature. Only install if you trust the source.</p>}{item.kind === "plugin" && <section className="space-y-3"><h3 className="text-sm font-medium">Permissions</h3>{item.capabilities.length ? <ul className="list-inside list-disc space-y-1 rounded-md border border-border p-3 text-sm">{item.capabilities.map(capability => <li key={capability}>{capability}</li>)}</ul> : <p className="text-sm text-muted-foreground">No extra permissions.</p>}</section>}
          {item.state === "available" && <SubmitButton pending={mutate.isPending} disabled={!inventory.data.registry.available} onClick={() => mutate.mutate("install")}>Install</SubmitButton>}
          {item.kind === "plugin" && item.state === "installed" && <div className="space-y-3"><Check checked={capabilityApproval} onChange={setCapabilityApproval} disabled={mutate.isPending}>I allow {item.name} {item.version} these permissions.</Check><SubmitButton pending={mutate.isPending} disabled={!capabilityApproval} onClick={() => mutate.mutate("enable")}>Enable</SubmitButton></div>}
          {item.kind === "plugin" && item.state === "enabled" && <div className="space-y-3"><Check checked={runApproval} onChange={setRunApproval} disabled={mutate.isPending}>I allow this plugin's code to run.</Check><div className="flex flex-wrap gap-2"><SubmitButton pending={mutate.isPending} disabled={!runApproval} onClick={() => mutate.mutate("run")}>Run</SubmitButton><Button variant="outline" disabled={mutate.isPending} onClick={() => mutate.mutate("disable")}>Disable</Button></div></div>}
          {item.kind === "theme" && item.state === "installed" && <SubmitButton pending={mutate.isPending} onClick={() => mutate.mutate("theme")}>Use theme</SubmitButton>}
          {item.kind === "theme" && item.state === "active" && <p role="status" className="text-sm text-muted-foreground">In use. Change it in Settings.</p>}
          <Feedback error={mutate.error} message={message} />
        </> : <Empty>Select a plugin or theme.</Empty>}</ControlCard>
      </div>
      {inventory.data.host.tools.length > 0 && <ControlCard title="Plugin tools"><ul className="divide-y divide-border">{inventory.data.host.tools.map(tool => <li key={tool.name} className="py-3"><p className="font-medium text-sm">{tool.name}</p><p className="mt-1 text-xs text-muted-foreground">{tool.description}</p></li>)}</ul></ControlCard>}
    </>}
  </div>;
}
