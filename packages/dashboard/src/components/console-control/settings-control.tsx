import type { ConsoleExecutionStatus } from "@0/shared";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { webFetchJson } from "@/api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, Feedback, QueryState, SubmitButton, TextField, jsonBody } from "./control-ui";
import type { SettingDefinition, SettingsResponse } from "./contracts";

export function useConsoleSettings() {
  return useQuery({ queryKey: ["console-settings"], queryFn: ({ signal }) => webFetchJson<SettingsResponse>("/api/console/settings", { signal }) });
}

export const settingsCategories = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "conversation", label: "Conversation" },
  { id: "agents", label: "Agents & execution" },
  { id: "privacy", label: "Data & privacy" },
  { id: "terminal", label: "Terminal" },
] as const;
export type SettingsCategory = typeof settingsCategories[number]["id"];
const terminalKeys: Record<string, true> = { mouseSupport: true, composerStyle: true, symbolPreset: true, leaderKey: true, showStatusBar: true, showObjective: true, logoAnimation: true };
function categoryFor(def: SettingDefinition): SettingsCategory {
  if (terminalKeys[def.key]) return "terminal";
  if (def.group === "Privacy") return "privacy";
  if (def.group === "Security") return "agents";
  if (def.group === "Updates") return "general";
  if (def.group === "Transcript" || def.group === "Context" || def.group === "Telemetry" || def.key === "busyInputMode" || def.key === "rosterSort") return "conversation";
  return "appearance";
}

function settingLabel(definition: SettingDefinition): string {
  return definition.key === "analyticsLevel" ? "Usage metrics" : definition.label;
}

function SettingRow({ definition, value, source, scope, pending, apply, reset }: { definition: SettingDefinition; value: unknown; source: string; scope: "global" | "project"; pending: boolean; apply: (key: string, value: unknown, scope: "global" | "project") => void; reset: (key: string) => void }) {
  const label = settingLabel(definition);
  const description = definition.key === "updatePolicy" ? "Check for updates when 0 starts." : definition.description.replace(/\s*Applies to this computer\.?/g, "");
  const enabledChoice = definition.kind === "enum" && definition.choices?.length === 2 && definition.choices.includes("off") ? definition.choices.find(choice => choice !== "off") : undefined;
  const isToggle = definition.kind === "boolean" || enabledChoice !== undefined;
  const applyValue = (next: unknown) => apply(definition.key, next, definition.operatorOnly ? "global" : scope);
  return <div className="flex items-center justify-between gap-6 py-4">
    <div className="min-w-0 space-y-1"><h3 className="text-sm font-medium">{label}</h3><p className="max-w-lg text-xs leading-5 text-muted-foreground">{description}</p></div>
    <div className="flex shrink-0 items-center gap-2">
      {source !== "default" && <Button type="button" size="icon" variant="ghost" disabled={pending} onClick={() => reset(definition.key)} aria-label={`Reset ${label}`} title={`Reset ${label}`}><RotateCcw className="size-3.5" /></Button>}
      {isToggle ? <Switch aria-label={label} checked={definition.kind === "boolean" ? value === true : value === enabledChoice} disabled={pending} onCheckedChange={next => applyValue(definition.kind === "boolean" ? next : next ? enabledChoice : "off")} /> : <Select aria-label={label} className="max-w-48" value={typeof value === "string" ? value : ""} onValueChange={applyValue} disabled={pending} options={definition.choices?.map(choice => ({ value: choice, label: choice.charAt(0).toUpperCase() + choice.slice(1) })) ?? []} />}
    </div>
  </div>;
}

function ExecutionControl() {
  const status = useQuery({ queryKey: ["console-execution"], queryFn: ({ signal }) => webFetchJson<ConsoleExecutionStatus>("/api/console/execution", { signal }), refetchInterval: 5000 });
  const execution = status.data;
  return <section className="rounded-2xl border border-foreground/10 p-4"><h2 className="mb-3 text-sm font-medium">Execution</h2>
    <QueryState pending={status.isPending} error={status.error} retry={status.refetch} />
    {execution && <div className="space-y-2 text-sm">
      <p>Selected backend: <span className="font-medium">{execution.profile === "smolvm" ? "SmolVM" : "Local"}</span></p>
      <p className="text-xs text-muted-foreground">Availability checks do not mean a VM is running. Each chat shows its actual execution state.</p>
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">VM setup</dt><dd>{execution.configured ? "Configured" : "Not configured"}</dd>
        <dt className="text-muted-foreground">VM runtime</dt><dd>{execution.runtimeReady ? "Available" : "Unavailable"}</dd>
        <dt className="text-muted-foreground">VM image</dt><dd>{execution.imageApproved ? "Approved" : "Not approved"}</dd>
        {execution.workspace && <><dt className="text-muted-foreground">Workspace setting</dt><dd className="break-all">{execution.workspace}</dd></>}
        {execution.imageDigest && <><dt className="text-muted-foreground">Image digest</dt><dd className="break-all">{execution.imageDigest}</dd></>}
        {execution.resources && <><dt className="text-muted-foreground">Resources</dt><dd>{execution.resources.cpus} CPUs · {execution.resources.memoryMb} MiB memory · {execution.resources.storageGb} GiB storage</dd></>}
      </dl>
      {(execution.error || execution.message) && <p className="text-xs text-muted-foreground">{execution.error || execution.message}</p>}
    </div>}
  </section>;
}

export function SettingsControl({ presentationOnly = false, category = "general" }: { presentationOnly?: boolean; category?: SettingsCategory }) {
  const settings = useConsoleSettings();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [resetKeys, setResetKeys] = useState<string[] | null>(null);
  const resetTriggerRef = useRef<HTMLElement | null>(null);
  const openReset = (keys: string[]) => { reset.reset(); resetTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setResetKeys(keys); };
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { if (settings.data) setScope(settings.data.defaultWriteLayer); }, [settings.data?.defaultWriteLayer]);
  const save = useMutation({ mutationFn: async (input: { key: string; value: unknown; scope: "global" | "project" }) => {
    const data = await webFetchJson<SettingsResponse>("/api/console/settings", { method: "PATCH", body: JSON.stringify(input) });
    if (data.persisted === false) throw new Error("Couldn't save this setting.");
    return data;
  }, onSuccess: data => { queryClient.setQueryData(["console-settings"], data); setMessage("Saved."); } });
  const reset = useMutation({ mutationFn: async () => {
    const data = await webFetchJson<SettingsResponse>("/api/console/settings/reset", jsonBody(resetKeys?.length ? { keys: resetKeys } : {}));
    if (data.persisted === false) throw new Error("Couldn't reset settings.");
    return data;
  }, onSuccess: data => { queryClient.setQueryData(["console-settings"], data); setResetKeys(null); setMessage("Reset to defaults."); } });
  const presentationKeys: Record<string, true> = { density: true, transcriptStyle: true, roleLabelStyle: true, toolCardStyle: true, richToolCards: true, transcriptDetail: true, showTimestamps: true, showTokenUsage: true, showCost: true, showContextMeter: true, modelDisplay: true, reduceMotion: true, showComposerHints: true };
  const allDefinitions = settings.data?.definitions.filter(def => (!presentationOnly || presentationKeys[def.key]) && def.key !== "theme") ?? [];
  const definitions = allDefinitions.filter(def => `${settingLabel(def)} ${def.label} ${def.description} ${def.key} ${def.group}`.toLowerCase().includes(filter.toLowerCase()) && (filter.trim() || presentationOnly || categoryFor(def) === category));
  return <div className="space-y-4">
    {!presentationOnly && category === "agents" && <ExecutionControl />}
    <QueryState pending={settings.isPending} error={settings.error} retry={settings.refetch} />
    <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><TextField label="Search settings" type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search settings" /></div><div className="grid gap-2 text-sm"><span className="text-xs text-muted-foreground">Save changes to</span><Select aria-label="Save changes to" value={scope} onValueChange={next => setScope(next as "global" | "project")} options={[{value: "global", label: "All projects"}, {value: "project", label: "This project"}]} /></div></div>
    <Feedback error={save.error ?? (resetKeys === null ? reset.error : null)} message={message} />
    <Dialog open={resetKeys !== null} onOpenChange={open => { if (!open && !reset.isPending) setResetKeys(null); }}><DialogContent showCloseButton={!reset.isPending} onCloseAutoFocus={event => { event.preventDefault(); resetTriggerRef.current?.focus(); }}><DialogHeader><DialogTitle>Reset {resetKeys?.length ? settings.data?.definitions.find(def => def.key === resetKeys[0])?.label ?? "this setting" : "all settings"}?</DialogTitle><DialogDescription>Restore defaults and remove saved overrides for this computer and project.</DialogDescription></DialogHeader><Feedback error={reset.error} /><DialogFooter><Button variant="ghost" onClick={() => setResetKeys(null)} disabled={reset.isPending}>Cancel</Button><SubmitButton variant="destructive" pending={reset.isPending} onClick={() => reset.mutate()}>Reset</SubmitButton></DialogFooter></DialogContent></Dialog>
    <section className="divide-y divide-foreground/5 rounded-2xl border border-foreground/10 px-4">{definitions.map(def => <SettingRow key={def.key} definition={def} value={settings.data!.settings[def.key]} source={settings.data!.sources[def.key] ?? "default"} scope={scope} pending={save.isPending || reset.isPending} apply={(key, value, layer) => save.mutate({ key, value, scope: layer })} reset={key => openReset([key])} />)}</section>
    {settings.data && definitions.length === 0 && (filter.trim() || category !== "general") && <Empty>No matching settings.</Empty>}
    {!presentationOnly && category === "general" && !filter.trim() && <div className="flex items-center justify-between gap-4 py-4"><div><h3 className="text-sm font-medium">Reset settings</h3><p className="mt-1 text-xs text-muted-foreground">Restore defaults for this computer and project.</p></div><Button variant="outline" disabled={save.isPending || reset.isPending} onClick={() => openReset([])}>Reset all</Button></div>}
  </div>;
}
