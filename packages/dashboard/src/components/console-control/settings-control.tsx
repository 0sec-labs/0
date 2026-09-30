import type { ConsoleExecutionStatus } from "@0/shared";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { webFetchJson } from "@/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ControlCard, Empty, Feedback, Field, QueryState, SubmitButton, TextField, jsonBody, selectClass } from "./control-ui";
import type { SettingDefinition, SettingsResponse, ThemesResponse } from "./contracts";

export function useConsoleSettings() {
  return useQuery({ queryKey: ["console-settings"], queryFn: ({ signal }) => webFetchJson<SettingsResponse>("/api/console/settings", { signal }) });
}

function SettingRow({ definition, value, source, scope, pending, apply, reset }: { definition: SettingDefinition; value: unknown; source: string; scope: "global" | "project"; pending: boolean; apply: (key: string, value: unknown, scope: "global" | "project") => void; reset: (key: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const shortDescription = definition.description && definition.description.trim().split(/\s+/).length <= 6;
  return <div className="grid items-center gap-3 border-b border-border py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.7fr)]"><div className="space-y-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium" title={shortDescription ? undefined : definition.description}>{definition.label}</h3>{definition.operatorOnly && <Badge variant="secondary">This computer only</Badge>}</div>{shortDescription && <p className="text-xs text-muted-foreground">{definition.description}</p>}</div><form className="space-y-2" onSubmit={event => { event.preventDefault(); apply(definition.key, draft, definition.operatorOnly ? "global" : scope); }}><select aria-label={definition.label} className={selectClass} value={definition.kind === "boolean" ? String(draft === true) : typeof draft === "string" ? draft : ""} onChange={event => setDraft(definition.kind === "boolean" ? event.target.value === "true" : event.target.value)} disabled={pending}>{definition.kind === "boolean" ? <><option value="true">On</option><option value="false">Off</option></> : definition.choices?.map(choice => <option key={choice} value={choice}>{choice}</option>)}</select>{(draft !== value || source !== "default") && <div className="flex flex-wrap gap-2">{draft !== value && <><SubmitButton type="submit" size="sm" pending={pending}>Save</SubmitButton><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setDraft(value)}>Cancel</Button></>}{draft === value && source !== "default" && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => reset(definition.key)} aria-label={`Reset ${definition.label}`}><RotateCcw className="size-3" />Reset</Button>}</div>}</form></div>;
}

export function ThemeControl() {
  const queryClient = useQueryClient();
  const themes = useQuery({ queryKey: ["console-themes"], queryFn: ({ signal }) => webFetchJson<ThemesResponse>("/api/console/themes", { signal }) });
  const [preview, setPreview] = useState("");
  const theme = themes.data?.themes.find(item => item.name === (preview || themes.data.active));
  const mutation = useMutation({ mutationFn: async () => {
    const result = await webFetchJson<SettingsResponse>("/api/console/settings", { method: "PATCH", body: JSON.stringify({ key: "theme", value: theme?.name, scope: "global" }) });
    if (result.persisted === false) throw new Error("Couldn't save the theme.");
    return result;
  }, onSuccess: async data => { queryClient.setQueryData(["console-settings"], data); await themes.refetch(); } });
  return <ControlCard title="Theme">
    <QueryState pending={themes.isPending} error={themes.error} retry={themes.refetch} />
    {themes.data && <Field label="Palette"><select className={selectClass} value={preview || themes.data.active} onChange={event => setPreview(event.target.value)}>{themes.data.themes.map(item => <option key={item.name} value={item.name}>{item.label} · {item.mode}{item.name === themes.data.active ? " · active" : ""}</option>)}</select></Field>}
    {theme && <><div className="space-y-4 rounded-2xl p-5" style={{ background: theme.palette.CANVAS ?? theme.palette.background, color: theme.palette.TEXT, borderColor: theme.palette.BORDER }}><div className="flex items-center gap-2 text-xs" style={{ color: theme.palette.MUTED }}><span className="size-2 rounded-full" style={{ background: theme.palette.SUCCESS }} />Console · {theme.label}</div><p className="font-medium">Review the evidence, then approve the next action.</p><div className="rounded-xl p-3 text-sm" style={{ background: theme.palette.PANEL, borderColor: theme.palette.BORDER }}><p style={{ color: theme.palette.PRIMARY }}>Tool result</p><p className="mt-2" style={{ color: theme.palette.TEXT }}>Source review completed.</p><p className="mt-2 text-xs" style={{ color: theme.palette.WARNING }}>One action needs your approval.</p></div><div className="flex gap-2">{["PRIMARY", "ACCENT", "SUCCESS", "WARNING", "ERROR"].map(token => <span key={token} title={token} className="size-5 rounded-full border" style={{ background: theme.palette[token], borderColor: theme.palette.BORDER }} />)}</div></div>{(theme.name !== themes.data?.active || mutation.isPending) && <div className="flex flex-wrap gap-2"><SubmitButton pending={mutation.isPending} onClick={() => mutation.mutate()}>Save</SubmitButton><Button variant="outline" disabled={mutation.isPending} onClick={() => { setPreview(""); mutation.reset(); }}>Cancel</Button></div>}</>}
    <Feedback error={mutation.error} message={mutation.isSuccess ? "Theme saved." : null} />
  </ControlCard>;
}

function ExecutionControl() {
  const status = useQuery({ queryKey: ["console-execution"], queryFn: ({ signal }) => webFetchJson<ConsoleExecutionStatus>("/api/console/execution", { signal }), refetchInterval: 5000 });
  const execution = status.data;
  return <ControlCard title="Execution">
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
  </ControlCard>;
}

export function SettingsControl({ presentationOnly = false }: { presentationOnly?: boolean }) {
  const settings = useConsoleSettings();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [resetKeys, setResetKeys] = useState<string[] | null>(null);
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
  const presentationKeys: Record<string, true> = { theme: true, density: true, transcriptStyle: true, roleLabelStyle: true, toolCardStyle: true, richToolCards: true, transcriptDetail: true, showTimestamps: true, showTokenUsage: true, showCost: true, showContextMeter: true, modelDisplay: true, reduceMotion: true, showComposerHints: true };
  const definitions = settings.data?.definitions.filter(def => (!presentationOnly || presentationKeys[def.key]) && `${def.label} ${def.description} ${def.key} ${def.group}`.toLowerCase().includes(filter.toLowerCase()) && def.key !== "theme") ?? [];
  const groups = [...new Set(definitions.map(def => def.group))];
  return <div className="space-y-5">{!presentationOnly && <ExecutionControl />}<ThemeControl /><ControlCard title={presentationOnly ? "Appearance" : "Settings"}>
    <QueryState pending={settings.isPending} error={settings.error} retry={settings.refetch} />
    <div className="grid gap-4 sm:grid-cols-2"><TextField label="Find a setting" type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search…" /><Field label="Save to"><select className={selectClass} value={scope} onChange={event => setScope(event.target.value as "global" | "project")}><option value="global">All projects</option><option value="project">This project</option></select></Field></div>
    <Feedback error={save.error ?? reset.error} message={message} />
    {resetKeys && <div className="space-y-3 rounded-md border border-destructive/25 p-4"><p className="text-sm">Reset {resetKeys.length ? resetKeys.join(", ") : "all settings"} to defaults? This also removes project overrides.</p><div className="flex gap-2"><SubmitButton variant="destructive" pending={reset.isPending} onClick={() => reset.mutate()}>Reset</SubmitButton><Button variant="outline" onClick={() => setResetKeys(null)} disabled={reset.isPending}>Cancel</Button></div></div>}
    {settings.data && definitions.length === 0 && <Empty>No matching settings.</Empty>}
    {groups.map(group => <section key={group}><h2 className="border-b border-border pb-3 pt-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">{group}</h2>{definitions.filter(def => def.group === group).map(def => <SettingRow key={def.key} definition={def} value={settings.data!.settings[def.key]} source={settings.data!.sources[def.key] ?? "default"} scope={scope} pending={save.isPending || reset.isPending} apply={(key, value, layer) => save.mutate({ key, value, scope: layer })} reset={key => setResetKeys([key])} />)}</section>)}
    {!presentationOnly && <details><summary className="cursor-pointer text-sm text-muted-foreground">Advanced</summary><div className="mt-3"><Button variant="outline" disabled={save.isPending || reset.isPending} onClick={() => setResetKeys([])}><RotateCcw className="size-4" />Reset all</Button></div></details>}
  </ControlCard></div>;
}
