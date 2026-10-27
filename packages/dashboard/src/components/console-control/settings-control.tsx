import { Link, useLocation } from "react-router-dom";
import type { ConsoleExecutionStatus } from "@0/shared";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWebReduceMotion } from "@/lib/web-motion";
import { useWebTheme } from "@/lib/web-theme";
import { useTeamAccess } from "@/components/team-access";
import { useBackendApi } from "@/api";
import { Disclosure } from "@/components/ui/disclosure";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Feedback, QueryState, SubmitButton, jsonBody } from "./control-ui";
import type { SettingDefinition, SettingsResponse } from "./contracts";

export function useConsoleSettings() {
  const { client, webFetchJson } = useBackendApi();
  const team = useTeamAccess();
  const queryKey = ["console-settings", client.backendId, team.user?.workspaceId, team.user?.userId] as const;
  return { ...useQuery({ queryKey, queryFn: ({ signal }) => webFetchJson<SettingsResponse>("/api/console/settings", { signal }) }), queryKey };
}

export { settingsCategories, categoryFor, settingLabel, visibleWebSetting, type SettingsCategory } from "./web-settings";
import { settingsCategories, categoryFor, settingLabel, visibleWebSetting, webSettingDetails, settingChoiceLabel, sharedSettingKeys, type SettingsCategory } from "./web-settings";

function SettingRow({ definition, value, scope, pending, apply }: { definition: SettingDefinition; value: unknown; scope: "global" | "project"; pending: boolean; apply: (key: string, value: unknown, scope: "global" | "project") => void }) {
  const label = settingLabel(definition);
  const description = webSettingDetails(definition.key)?.description ?? "";
  const enabledChoice = definition.kind === "enum" && definition.choices?.length === 2 && definition.choices.includes("off") ? definition.choices.find(choice => choice !== "off") : undefined;
  const isToggle = definition.kind === "boolean" || enabledChoice !== undefined;
  const applyValue = (next: unknown) => apply(definition.key, next, definition.operatorOnly ? "global" : scope);
  return <div id={`setting-${definition.key}`} tabIndex={-1} className="flex scroll-mt-6 flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
    <div className="min-w-0 flex-1 basis-56 space-y-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><h3 className="text-sm font-medium">{label}</h3>{definition.operatorOnly && <span className="text-xs text-muted-foreground">This engine</span>}</div><p className="max-w-lg text-xs leading-5 text-muted-foreground">{description}</p></div>
    <div className="flex max-w-full shrink-0 items-center gap-2">
      {isToggle ? <Switch aria-label={label} checked={definition.kind === "boolean" ? value === true : value === enabledChoice} disabled={pending} onCheckedChange={next => applyValue(definition.kind === "boolean" ? next : next ? enabledChoice : "off")} /> : <Select aria-label={label} className="w-48 max-w-full" value={typeof value === "string" ? value : ""} onValueChange={applyValue} disabled={pending} options={definition.choices?.map(choice => ({ value: choice, label: settingChoiceLabel(definition.key, choice) })) ?? []} />}
    </div>
  </div>;
}

function ExecutionControl() {
  const { client, webFetchJson } = useBackendApi();
  const status = useQuery({ queryKey: ["console-execution", client.backendId], queryFn: ({ signal }) => webFetchJson<ConsoleExecutionStatus>("/api/console/execution", { signal }), refetchInterval: 5000 });
  const execution = status.data;
  const isolated = execution?.profile === "smolvm";
  const ready = Boolean(execution && (!isolated || execution.configured && execution.runtimeReady && execution.imageApproved && execution.platformSupported !== false));
  return <div className="space-y-3">
    <QueryState pending={status.isPending} error={status.error} retry={status.refetch} />
    {execution && <>
      <div className="space-y-1 py-2"><p className="flex flex-wrap items-center gap-2 text-sm"><span>{isolated ? "Isolated workspace" : "This host"}</span><span className="text-xs text-muted-foreground">{ready ? "Ready" : "Needs setup"}</span></p><p role="status" className="max-w-lg text-xs leading-5 text-muted-foreground">{!isolated ? "Tools run directly on this host." : ready ? "Tools run in a separate workspace." : execution.platformSupported === false ? "Isolated workspaces are unavailable on this host. Choose another host or run tools directly on this host." : "Finish configuring an isolated workspace, or choose a host that already has one."}</p></div>
      {isolated && !ready && <div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link to="/doctor">Check setup</Link></Button><Button asChild size="sm" variant="ghost"><Link to="/workers">Choose host</Link></Button></div>}
      <Disclosure summary="Runtime details" triggerClassName="rounded-[var(--radius-control)] px-1 py-2 text-xs text-muted-foreground hover:text-foreground" contentClassName="space-y-3 px-1 pb-2"><dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]">
        {isolated && <><dt className="text-muted-foreground">Workspace setup</dt><dd>{execution.configured ? "Configured" : "Not configured"}</dd><dt className="text-muted-foreground">Runtime</dt><dd>{execution.runtimeReady ? "Available" : "Unavailable"}</dd><dt className="text-muted-foreground">Image</dt><dd>{execution.imageApproved ? "Approved" : "Not approved"}</dd></>}
        {execution.workspace && <><dt className="text-muted-foreground">Workspace</dt><dd className="break-all">{execution.workspace}</dd></>}
        {execution.imageDigest && <><dt className="text-muted-foreground">Image digest</dt><dd className="break-all">{execution.imageDigest}</dd></>}
        {execution.resources && <><dt className="text-muted-foreground">Resources</dt><dd>{execution.resources.cpus} CPUs · {execution.resources.memoryMb} MiB memory · {execution.resources.storageGb} GiB storage</dd></>}
      </dl>{(execution.error || execution.message) && <p className="text-xs leading-5 text-muted-foreground">{execution.error || execution.message}</p>}</Disclosure>
    </>}
  </div>;
}

export function SettingsControl({ presentationOnly = false, category = "general" }: { presentationOnly?: boolean; category?: SettingsCategory }) {
  const { webFetchJson } = useBackendApi();
  const settings = useConsoleSettings();
  const [appearance, setAppearance] = useWebTheme();
  const [reduceMotion, setReduceMotion] = useWebReduceMotion();
  const queryClient = useQueryClient();
  const location = useLocation();
  const scope = "global" as const;
  const [resetKeys, setResetKeys] = useState<string[] | null>(null);
  const resetTriggerRef = useRef<HTMLElement | null>(null);
  const openReset = (keys: string[]) => { reset.reset(); resetTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setResetKeys(keys); };
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({ mutationFn: async (input: { key: string; value: unknown; scope: "global" | "project" }) => {
    if (!visibleWebSetting(input)) throw new Error("This preference is not managed by the web app.");
    const data = await webFetchJson<SettingsResponse>("/api/console/settings", { method: "PATCH", body: JSON.stringify(input) });
    if (data.persisted === false) throw new Error("Couldn't save this setting.");
    return data;
  }, onSuccess: data => { queryClient.setQueryData(settings.queryKey, data); setMessage("Saved."); } });
  const reset = useMutation({ mutationFn: async () => {
    const keys = sharedSettingKeys(resetKeys?.length ? resetKeys : allDefinitions.map(def => def.key));
    if (!keys.length) throw new Error("No shared agent preferences are available to reset.");
    const data = await webFetchJson<SettingsResponse>("/api/console/settings/reset", jsonBody({ keys }));
    if (data.persisted === false) throw new Error("Couldn't reset settings.");
    return data;
  }, onSuccess: data => { queryClient.setQueryData(settings.queryKey, data); setResetKeys(null); setMessage("Reset to defaults."); } });
  const allDefinitions = settings.data?.definitions.filter(def => visibleWebSetting(def) && !presentationOnly) ?? [];
  useEffect(() => {
    if (!settings.isSuccess || presentationOnly) return;
    let anchor = location.hash.slice(1);
    try { anchor = decodeURIComponent(anchor); } catch { return; }
    const id = anchor.startsWith("setting-") || anchor.startsWith("settings-") ? anchor : `settings-${category}`;
    const frame = requestAnimationFrame(() => { const target = document.getElementById(id); target?.scrollIntoView({ block: "start" }); if (anchor.startsWith("setting-")) target?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [category, location.hash, settings.isSuccess, presentationOnly]);
  return <div className="space-y-4">
    <QueryState pending={settings.isPending} error={settings.error} retry={settings.refetch} />
    {!presentationOnly && <p className="text-xs text-muted-foreground">Changes save automatically.</p>}
    <Feedback error={save.error ?? (resetKeys === null ? reset.error : null)} message={message} />
    <Dialog open={resetKeys !== null} onOpenChange={open => { if (!open && !reset.isPending) setResetKeys(null); }}><DialogContent showCloseButton={!reset.isPending} onCloseAutoFocus={event => { event.preventDefault(); resetTriggerRef.current?.focus(); }}><DialogHeader><DialogTitle>Reset {resetKeys?.length ? settings.data?.definitions.find(def => def.key === resetKeys[0])?.label ?? "this setting" : "shared preferences"}?</DialogTitle><DialogDescription>Restore the shared agent preferences shown on this page. Terminal appearance and browser appearance are unchanged.</DialogDescription></DialogHeader><Feedback error={reset.error} /><DialogFooter><Button variant="ghost" onClick={() => setResetKeys(null)} disabled={reset.isPending}>Cancel</Button><SubmitButton variant="destructive" pending={reset.isPending} onClick={() => reset.mutate()}>Reset</SubmitButton></DialogFooter></DialogContent></Dialog>
    {settingsCategories.map(section => {
      const definitions = allDefinitions.filter(def => categoryFor(def) === section.id);
      if (!definitions.length && section.id !== "appearance" && (section.id !== "agents" || presentationOnly)) return null;
      return <section key={section.id} id={`settings-${section.id}`} aria-labelledby={section.id === "general" ? undefined : `settings-${section.id}-heading`} aria-label={section.id === "general" ? "Updates" : undefined} className="scroll-mt-6 space-y-3 pt-2">
        {section.id !== "general" && <h2 id={`settings-${section.id}-heading`} className={presentationOnly ? "sr-only" : "text-base font-medium"}>{section.label}</h2>}
        {section.id === "appearance" && <div id="setting-web-theme" tabIndex={-1} className="flex scroll-mt-6 flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/30"><div className="min-w-0 flex-1 basis-56 space-y-1"><h3 className="text-sm font-medium">Theme</h3><p className="max-w-lg text-xs leading-5 text-muted-foreground">Light keeps navigation black and the workspace white. Saved only in this browser.</p></div><Select aria-label="Web appearance" className="w-48 max-w-full" value={appearance} onValueChange={value => { if (value === "light" || value === "dark") setAppearance(value); }} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} /></div>}
        {section.id === "appearance" && <div id="setting-web-motion" tabIndex={-1} className="flex scroll-mt-6 flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/30"><div className="min-w-0 flex-1 basis-56 space-y-1"><h3 className="text-sm font-medium">Reduce motion</h3><p className="max-w-lg text-xs leading-5 text-muted-foreground">Reduce decorative animations. Saved only in this browser.</p></div><Switch aria-label="Reduce motion" checked={reduceMotion} onCheckedChange={setReduceMotion} /></div>}
        {definitions.length > 0 && <div className="divide-y divide-border rounded-[var(--radius-panel,16px)] border border-border px-4">{definitions.map(def => <SettingRow key={def.key} definition={def} value={settings.data!.settings[def.key]} scope={scope} pending={save.isPending || reset.isPending} apply={(key, value, layer) => save.mutate({ key, value, scope: layer })} />)}</div>}
        {!presentationOnly && section.id === "agents" && <ExecutionControl />}
      </section>;
    })}
    {!presentationOnly && settings.data && <div className="flex items-center justify-between gap-4 py-4"><div><h2 className="text-sm font-medium">Reset settings</h2><p className="mt-1 text-xs text-muted-foreground">Restore shared agent preferences. Appearance stays unchanged.</p></div><Button variant="outline" disabled={save.isPending || reset.isPending || !allDefinitions.length} onClick={() => openReset([])}>Reset shared preferences</Button></div>}
  </div>;
}
