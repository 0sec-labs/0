import type { ConsoleExecutionStatus } from "@0/shared";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, Feedback, QueryState, SubmitButton, TextField, jsonBody } from "./control-ui";
import type { SettingDefinition, SettingsResponse } from "./contracts";

export function useConsoleSettings() {
  const { webFetchJson } = useBackendApi();
  return useQuery({ queryKey: ["console-settings"], queryFn: ({ signal }) => webFetchJson<SettingsResponse>("/api/console/settings", { signal }) });
}

export const settingsCategories = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "conversation", label: "Conversation" },
  { id: "agents", label: "Agents & execution" },
  { id: "privacy", label: "Data & privacy" },
] as const;
export type SettingsCategory = typeof settingsCategories[number]["id"];
// These preferences are consumed by the terminal renderer, not the web console.
// Keep their persisted values available to the CLI without exposing ineffective controls here.
const cliPresentationKeys = new Set([
  "showStatusBar", "showComposerHints", "composerSuggestions", "mouseSupport", "showLogo",
  "showRuntimeNotices", "showTurnSummary", "showSubagents", "showTimestamps", "showObjective",
  "showScope", "density", "composerStyle", "transcriptStyle", "roleLabelStyle", "toolCardStyle",
  "richToolCards", "transcriptDetail", "showTokenUsage", "showCost", "showContextMeter",
  "modelDisplay", "elapsedTimer", "logoAnimation", "symbolPreset", "rosterSort", "leaderKey",
]);
function categoryFor(def: SettingDefinition): SettingsCategory {
  if (def.group === "Privacy") return "privacy";
  if (def.group === "Security") return "agents";
  if (def.group === "Updates") return "general";
  if (def.group === "Transcript" || def.group === "Context" || def.group === "Telemetry" || def.key === "busyInputMode" || def.key === "rosterSort") return "conversation";
  return "appearance";
}

function settingLabel(definition: SettingDefinition): string {
  const labels: Record<string, string> = { analyticsLevel: "Usage metrics", busyInputMode: "Messages while working", executionProfile: "Run tools in" };
  return labels[definition.key] ?? definition.label;
}

function SettingRow({ definition, value, scope, pending, apply }: { definition: SettingDefinition; value: unknown; scope: "global" | "project"; pending: boolean; apply: (key: string, value: unknown, scope: "global" | "project") => void }) {
  const label = settingLabel(definition);
  const descriptions: Record<string, string> = {
    executionProfile: "This computer runs tools directly. Isolated VM runs tools in a separate Linux workspace. Changes apply to new chats.",
    updatePolicy: "Check for updates when 0 starts.",
    reduceMotion: "Reduce animations.",
    busyInputMode: "Interrupt with your next message, or queue it until the current turn ends.",
    autoCompaction: "Summarize older messages when context fills up.",
    compactionThreshold: "When to summarize older messages.",
  };
  const description = descriptions[definition.key] ?? definition.description.replace(/\s*Applies to this computer\.?/g, "");
  const enabledChoice = definition.kind === "enum" && definition.choices?.length === 2 && definition.choices.includes("off") ? definition.choices.find(choice => choice !== "off") : undefined;
  const isToggle = definition.kind === "boolean" || enabledChoice !== undefined;
  const applyValue = (next: unknown) => apply(definition.key, next, definition.operatorOnly ? "global" : scope);
  return <div className="flex items-center justify-between gap-6 py-4">
    <div className="min-w-0 space-y-1"><h3 className="text-sm font-medium">{label}</h3><p className="max-w-lg text-xs leading-5 text-muted-foreground">{description}</p></div>
    <div className="flex shrink-0 items-center gap-2">
      {isToggle ? <Switch aria-label={label} checked={definition.kind === "boolean" ? value === true : value === enabledChoice} disabled={pending} onCheckedChange={next => applyValue(definition.kind === "boolean" ? next : next ? enabledChoice : "off")} /> : <Select aria-label={label} className="max-w-48" value={typeof value === "string" ? value : ""} onValueChange={applyValue} disabled={pending} options={definition.choices?.map(choice => ({ value: choice, label: definition.key === "executionProfile" ? choice === "smolvm" ? "Isolated VM" : "This computer" : choice.charAt(0).toUpperCase() + choice.slice(1) })) ?? []} />}
    </div>
  </div>;
}

function ExecutionControl() {
  const { webFetchJson } = useBackendApi();
  const status = useQuery({ queryKey: ["console-execution"], queryFn: ({ signal }) => webFetchJson<ConsoleExecutionStatus>("/api/console/execution", { signal }), refetchInterval: 5000 });
  const execution = status.data;
  return <section className="rounded-2xl border border-foreground/10 p-4"><h2 className="mb-3 text-sm font-medium">Execution</h2>
    <QueryState pending={status.isPending} error={status.error} retry={status.refetch} />
    {execution && <div className="space-y-2 text-sm">
      <p>Run tools in: <span className="font-medium">{execution.profile === "smolvm" ? "Isolated VM" : "This computer"}</span></p>
      <p className="text-xs text-muted-foreground">The runtime and an approved image must both be configured before a chat can use SmolVM.</p>
      {execution.profile === "smolvm" && (!execution.configured || !execution.imageApproved || !execution.runtimeReady) && <div role="status" className="space-y-2 rounded-xl bg-amber-500/10 p-3 text-sm"><p className="font-medium">SmolVM needs setup</p><p className="text-xs leading-5 text-muted-foreground">{!execution.configured ? "SmolVM is selected, but no workbench image or provider grant has been configured. Installing the runtime alone does not finish setup." : !execution.runtimeReady ? "The configured VM runtime is unavailable. Run workbench setup to repair it." : "The configured VM image is not approved or is unavailable. Run workbench setup with your image archive."}</p><code className="block break-all text-xs">0 workbench setup --image /path/to/workbench.tar --provider chatgpt-codex</code></div>}
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
  const { webFetchJson } = useBackendApi();
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
    const data = await webFetchJson<SettingsResponse>("/api/console/settings/reset", jsonBody({ keys: resetKeys?.length ? resetKeys : allDefinitions.map(def => def.key) }));
    if (data.persisted === false) throw new Error("Couldn't reset settings.");
    return data;
  }, onSuccess: data => { queryClient.setQueryData(["console-settings"], data); setResetKeys(null); setMessage("Reset to defaults."); } });
  const allDefinitions = settings.data?.definitions.filter(def => !cliPresentationKeys.has(def.key) && def.key !== "theme" && (!presentationOnly || def.key === "reduceMotion")) ?? [];
  const definitions = allDefinitions.filter(def => `${settingLabel(def)} ${def.label} ${def.description} ${def.key} ${def.group}`.toLowerCase().includes(filter.toLowerCase()) && (filter.trim() || presentationOnly || categoryFor(def) === category));
  return <div className="space-y-4">
    {!presentationOnly && category === "agents" && <ExecutionControl />}
    <QueryState pending={settings.isPending} error={settings.error} retry={settings.refetch} />
    <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><TextField label="Search settings" type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search settings" /></div><div className="grid gap-2 text-sm"><span className="text-xs text-muted-foreground">Save changes to</span><Select aria-label="Save changes to" value={scope} onValueChange={next => setScope(next as "global" | "project")} options={[{value: "global", label: "All projects"}, {value: "project", label: "This project"}]} /></div></div>
    <Feedback error={save.error ?? (resetKeys === null ? reset.error : null)} message={message} />
    <Dialog open={resetKeys !== null} onOpenChange={open => { if (!open && !reset.isPending) setResetKeys(null); }}><DialogContent showCloseButton={!reset.isPending} onCloseAutoFocus={event => { event.preventDefault(); resetTriggerRef.current?.focus(); }}><DialogHeader><DialogTitle>Reset {resetKeys?.length ? settings.data?.definitions.find(def => def.key === resetKeys[0])?.label ?? "this setting" : "all settings"}?</DialogTitle><DialogDescription>Restore defaults and remove saved overrides for this computer and project.</DialogDescription></DialogHeader><Feedback error={reset.error} /><DialogFooter><Button variant="ghost" onClick={() => setResetKeys(null)} disabled={reset.isPending}>Cancel</Button><SubmitButton variant="destructive" pending={reset.isPending} onClick={() => reset.mutate()}>Reset</SubmitButton></DialogFooter></DialogContent></Dialog>
    <section className="divide-y divide-foreground/5 rounded-2xl border border-foreground/10 px-4">{definitions.map(def => <SettingRow key={def.key} definition={def} value={settings.data!.settings[def.key]} scope={scope} pending={save.isPending || reset.isPending} apply={(key, value, layer) => save.mutate({ key, value, scope: layer })} />)}</section>
    {settings.data && definitions.length === 0 && (filter.trim() || category !== "general") && <Empty>No matching settings.</Empty>}
    {!presentationOnly && category === "general" && !filter.trim() && <div className="flex items-center justify-between gap-4 py-4"><div><h3 className="text-sm font-medium">Reset settings</h3><p className="mt-1 text-xs text-muted-foreground">Restore web settings to defaults.</p></div><Button variant="outline" disabled={save.isPending || reset.isPending} onClick={() => openReset([])}>Reset all</Button></div>}
  </div>;
}
