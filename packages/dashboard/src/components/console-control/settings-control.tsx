import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { webFetchJson } from "@/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Empty, Feedback, QueryState, SubmitButton, TextField, jsonBody, selectClass } from "./control-ui";
import type { SettingDefinition, SettingsResponse, ThemesResponse } from "./contracts";

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

function SettingRow({ definition, value, source, scope, pending, apply, reset }: { definition: SettingDefinition; value: unknown; source: string; scope: "global" | "project"; pending: boolean; apply: (key: string, value: unknown, scope: "global" | "project") => void; reset: (key: string) => void }) {
  return <div className="flex items-center justify-between gap-6 py-4"><div className="min-w-0 space-y-1"><h3 className="text-sm font-medium">{definition.label}</h3><p className="max-w-lg text-xs leading-5 text-muted-foreground">{definition.description}</p>{definition.operatorOnly && <p className="text-xs text-muted-foreground">Applies to this computer.</p>}</div><div className="flex shrink-0 items-center gap-2">{source !== "default" && <Button type="button" size="icon" variant="ghost" disabled={pending} onClick={() => reset(definition.key)} aria-label={`Reset ${definition.label}`} title={`Reset ${definition.label}`}><RotateCcw className="size-3.5" /></Button>}{definition.kind === "boolean" ? <button type="button" role="switch" aria-label={definition.label} aria-checked={value === true} disabled={pending} onClick={() => apply(definition.key, value !== true, definition.operatorOnly ? "global" : scope)} className={cn("relative h-6 w-10 rounded-full transition-colors focus-visible:outline focus-visible:outline-offset-4 disabled:opacity-50", value === true ? "bg-primary" : "bg-muted-foreground/30")}><span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform", value === true ? "left-0.5 translate-x-4" : "left-0.5")} /></button> : <select aria-label={definition.label} className={cn(selectClass, "!w-auto max-w-48")} value={typeof value === "string" ? value : ""} onChange={event => apply(definition.key, event.target.value, definition.operatorOnly ? "global" : scope)} disabled={pending}>{definition.choices?.map(choice => <option key={choice} value={choice}>{choice.charAt(0).toUpperCase() + choice.slice(1)}</option>)}</select>}</div></div>;
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
  return <section aria-label="Theme" className="space-y-2">
    <QueryState pending={themes.isPending} error={themes.error} retry={themes.refetch} />
    {themes.data && <div className="flex items-center justify-between gap-6 py-4"><div><h3 className="text-sm font-medium">Theme</h3><p className="mt-1 text-xs text-muted-foreground">Choose the palette for 0.</p></div><select aria-label="Theme" className={selectClass + " !w-auto max-w-48"} value={preview || themes.data.active} onChange={event => setPreview(event.target.value)}>{themes.data.themes.map(item => <option key={item.name} value={item.name}>{item.label}</option>)}</select></div>}
    {theme && theme.name !== themes.data?.active && <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-3"><div className="flex gap-1.5">{["CANVAS", "PANEL", "PRIMARY", "ACCENT"].map(token => <span key={token} className="size-5 rounded-full" style={{ background: theme.palette[token] }} />)}</div><span className="flex-1 text-xs text-muted-foreground">{theme.label}</span><SubmitButton size="sm" pending={mutation.isPending} onClick={() => mutation.mutate()}>Apply</SubmitButton><Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => { setPreview(""); mutation.reset(); }}>Cancel</Button></div>}
    <Feedback error={mutation.error} message={mutation.isSuccess ? "Theme saved." : null} />
  </section>;
}

export function SettingsControl({ presentationOnly = false, category = "general" }: { presentationOnly?: boolean; category?: SettingsCategory }) {
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
  const allDefinitions = settings.data?.definitions.filter(def => (!presentationOnly || presentationKeys[def.key]) && def.key !== "theme") ?? [];
  const definitions = allDefinitions.filter(def => `${def.label} ${def.description} ${def.key} ${def.group}`.toLowerCase().includes(filter.toLowerCase()) && (filter.trim() || presentationOnly || categoryFor(def) === category));
  return <div className="space-y-4">
    <QueryState pending={settings.isPending} error={settings.error} retry={settings.refetch} />
    <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><TextField label="Search settings" type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search settings" /></div><label className="grid gap-2 text-sm"><span className="text-xs text-muted-foreground">Save changes to</span><select aria-label="Save changes to" className={selectClass} value={scope} onChange={event => setScope(event.target.value as "global" | "project")}><option value="global">All projects</option><option value="project">This project</option></select></label></div>
    <Feedback error={save.error ?? reset.error} message={message} />
    {resetKeys && <div className="space-y-3 rounded-xl bg-destructive/5 p-4"><p className="text-sm">Reset {resetKeys.length ? settings.data?.definitions.find(def => def.key === resetKeys[0])?.label ?? "this setting" : "all settings"} to defaults? This also removes project overrides.</p><div className="flex gap-2"><SubmitButton variant="destructive" pending={reset.isPending} onClick={() => reset.mutate()}>Reset</SubmitButton><Button variant="ghost" onClick={() => setResetKeys(null)} disabled={reset.isPending}>Cancel</Button></div></div>}
    {(!filter.trim() && (category === "general" || presentationOnly)) && <ThemeControl />}
    <section className="divide-y divide-foreground/5 rounded-2xl border border-foreground/10 px-4">{definitions.map(def => <SettingRow key={def.key} definition={def} value={settings.data!.settings[def.key]} source={settings.data!.sources[def.key] ?? "default"} scope={scope} pending={save.isPending || reset.isPending} apply={(key, value, layer) => save.mutate({ key, value, scope: layer })} reset={key => setResetKeys([key])} />)}</section>
    {settings.data && definitions.length === 0 && (filter.trim() || category !== "general") && <Empty>No matching settings.</Empty>}
    {!presentationOnly && category === "general" && !filter.trim() && <div className="flex items-center justify-between gap-4 py-4"><div><h3 className="text-sm font-medium">Reset settings</h3><p className="mt-1 text-xs text-muted-foreground">Restore defaults for this computer and project.</p></div><Button variant="outline" disabled={save.isPending || reset.isPending} onClick={() => setResetKeys([])}>Reset all</Button></div>}
  </div>;
}
