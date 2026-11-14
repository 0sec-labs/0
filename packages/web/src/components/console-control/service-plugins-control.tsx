import { queryKeys } from "@/queries";
import { useEffect, useState } from "react";
import type { ServicePluginItem, ServicePluginsResponse } from "@0/engine/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CodeXml, GitBranch, Hash, Layers, ShieldCheck, Users, Waypoints } from "lucide-react";
import { CapyArrowUpRightIcon as ArrowUpRight, CapyCloudIcon as Cloud, CapyDatabaseIcon as Database, CapyPlugIcon as Plug } from "@/ui/icons/capy";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { SheetPanel } from "@/ui/components/sheet-panel";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/ui/components/settings-card";
import { SettingsRow } from "./settings-section";
import { Feedback, SubmitButton, TextField } from "./control-ui";
import { StatusBadge } from "@/ui/components/status-badge";
import { EntryLogo, ToolSkillLists } from "./mcp-ui";

/** Service logo inside the shared 28px tile. */
export function ServiceIcon({ id, className = "size-4" }: { id: string; className?: string }) {
  const Icon = ({ github: GitBranch, slack: Hash, teams: Users, elastic: Database, semgrep: CodeXml, snyk: ShieldCheck, linear: Waypoints, jira: Layers, cloudflare: Cloud } as Record<string, typeof Plug>)[id] ?? Plug;
  return <Icon aria-hidden="true" className={className} />;
}

export function useServicePlugins() {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const inventory = useQuery({ queryKey: queryKeys.consoleServicePlugins(), queryFn: ({ signal }) => webFetchJson<ServicePluginsResponse>("/api/console/service-plugins", { signal }), refetchInterval: 15_000 });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.consoleServicePlugins() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.consoleTools() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workflowToolCatalog() }),
    ]);
  };
  const connect = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: Record<string, string> }) => webFetchJson(`/api/console/service-plugins/${encodeURIComponent(id)}/connect`, { method: "POST", body: JSON.stringify({ fields, approved: true }) }),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => webFetchJson(`/api/console/service-plugins/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: refresh,
    onError: () => { void inventory.refetch(); },
  });
  const forget = useMutation({
    mutationFn: ({ id }: { id: string }) => webFetchJson(`/api/console/service-plugins/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  return { inventory, connect, toggle, forget };
}
export type ServicePluginActions = ReturnType<typeof useServicePlugins>;

/** Detail drawer for one built-in MCP-server plugin: status, enable switch, credentials form, and its tools. */
export function ServicePluginSheet({ item, actions, onClose }: { item: ServicePluginItem | null; actions: ServicePluginActions; onClose: () => void }) {
  const { connect, toggle, forget } = actions;
  const [fields, setFields] = useState<Record<string, string>>({});
  const [confirmForget, setConfirmForget] = useState(false);
  const itemId = item?.id;
  useEffect(() => { setFields({ ...item?.values }); setConfirmForget(false); connect.reset(); toggle.reset(); forget.reset(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);
  const busy = connect.isPending || forget.isPending;
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (item) connect.mutate({ id: item.id, fields }, { onSuccess: () => onClose() }); };
  const healthy = Boolean(item?.configured && item.enabled && !item.error);
  if (!item) return null;
  return <SheetPanel open onOpenChange={open => { if (!open) onClose(); }} locked={busy} titleClassName="text-xl" title={<>{item.name}</>} description={<>{item.description}</>}
    leading={<EntryLogo logo={(item as { logo?: string }).logo} className="size-10" fallback={<ServiceIcon id={item.id} className="size-5" />} />} bodyClassName="gap-8"
    footerClassName="items-center justify-between"
    footer={<>
          <div className="flex items-center gap-2">
            <Button variant="link" className="px-0" render={<a href={item.docsUrl} target="_blank" rel="noopener noreferrer" />}>Setup instructions<ArrowUpRight /></Button>
            {item.configured && (confirmForget
              ? <SubmitButton variant="destructive" size="sm" pending={forget.isPending} onClick={() => forget.mutate({ id: item.id }, { onSuccess: () => onClose() })}>Confirm disconnect</SubmitButton>
              : <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmForget(true)}>Disconnect</Button>)}
          </div>
          <div className="flex gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><SubmitButton type="submit" form="service-plugin-connect" pending={connect.isPending}>{item.configured ? "Save and reconnect" : "Connect"}</SubmitButton></div>
  </>}>
          <SettingsCard className="mx-0">
            <SettingsRow label="Status" description={<>MCP server · {item.category}{item.testedAt ? ` · tested ${new Date(item.testedAt).toLocaleDateString()}` : ""}</>}><StatusBadge appearance="outline" tone={healthy ? "success" : item.configured ? "neutral" : "warning"}>{!item.configured ? "Needs connection" : item.enabled ? "Connected" : "Off"}</StatusBadge></SettingsRow>
            {item.configured && <SettingsRow label="Enabled" description={<>A disabled plugin is hidden from the model</>}><Switch aria-label={`Enable ${item.name}`} checked={item.enabled} disabled={toggle.isPending} onCheckedChange={enabled => toggle.mutate({ id: item.id, enabled })} /></SettingsRow>}
          </SettingsCard>
          {item.error && <Feedback error={item.error} />}
          <Feedback error={toggle.error} />
          <section className="flex flex-col gap-3">
            <h3 className="text-base font-medium">{item.configured ? "Connection" : "Connect"}</h3>
            <form id="service-plugin-connect" onSubmit={submit} className="flex flex-col gap-4 rounded-(--radius-card) border-[0.5px] border-(--card-hairline) bg-card p-4">
              {item.fields.map(field => <TextField key={field.key} label={field.label} type={field.type === "secret" ? "password" : field.type === "url" ? "url" : "text"} value={fields[field.key] ?? ""} onChange={event => setFields(current => ({ ...current, [field.key]: event.target.value }))} required={field.required && !(item.configured && field.type === "secret")} placeholder={field.type === "secret" && item.configured ? "Saved. Leave blank to keep" : undefined} disabled={busy} autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} />)}
              {item.credentialNote && <p className="text-sm text-muted-foreground-2">{item.credentialNote}</p>}
              <Feedback error={connect.error ?? forget.error} />
            </form>
          </section>
          {item.configured && <ToolSkillLists tools={item.tools} skills={(item as { skills?: { name: string; description: string }[] }).skills ?? []} />}
  </SheetPanel>;
}
