import { queryKeys } from "@/queries";
import { Link, useLocation } from "react-router-dom";
import type { ConsoleExecutionStatus } from "@0/engine/shared";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTeamAccess } from "@/components/team-access";
import { useBackendApi } from "@/api";
import { Disclosure } from "@/components/ui/disclosure";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { AppearancePage } from "@/components/appearance/appearance-page";
import { ShortcutsControl } from "./shortcuts-control";
import { GitSettings } from "./settings-data-pages";
import { NotificationsSettings } from "./notifications-control";
import { AuditLogSettings } from "./audit-log-control";
import { InstructionsSettings } from "./instructions-control";
import { UsageSettings } from "./extra-settings-pages";
import { categoriesOfPage, type SettingsPageId } from "./settings-index";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { Feedback, QueryState, jsonBody } from "./control-ui";
import { NumberSettingControl, TextSettingControl } from "./thread-setting-controls";
import { SettingsRow, SettingsSection } from "./settings-section";
import { StatusSettings } from "./status-row";
import { isProtectedSetting, planReset } from "./settings-reset-model";
import type { SettingDefinition, SettingsResponse } from "./contracts";
import { privacyDisclosure, settingsCategories, categoryFor, settingLabel, visibleWebSetting, webSettingDetails, settingGroup, hiddenInto, settingChoiceLabel, settingToggle, sharedSettingKeys, archiveIdleChoices } from "./web-settings";

export function useConsoleSettings() {
  const { client, webFetchJson } = useBackendApi();
  const team = useTeamAccess();
  const queryKey = queryKeys.consoleSettings(client.backendId, team.user?.workspaceId, team.user?.userId);
  return { ...useQuery({ queryKey, queryFn: ({ signal }) => webFetchJson<SettingsResponse>("/api/console/settings", { signal }) }), queryKey };
}

export { settingsCategories, categoryFor, settingLabel, visibleWebSetting, type SettingsCategory } from "./web-settings";

function SettingRow({ definition, value, scope, pending, isolatedReady, apply, group }: { definition: SettingDefinition; value: unknown; scope: "global" | "project"; pending: boolean; isolatedReady?: boolean; apply: (key: string, value: unknown, scope: "global" | "project") => void; group?: { keys: string[]; values: Record<string, unknown> } }) {
  if (group && group.keys.length > 1) {
    const label = settingLabel(definition);
    return <SettingsRow id={`setting-${definition.key}`} label={label} description={webSettingDetails(definition.key)?.description}>
      <Switch aria-label={label} checked={group.keys.some(key => group.values[key] === true)} disabled={pending} onCheckedChange={next => group.keys.forEach(key => apply(key, next, scope))} />
    </SettingsRow>;
  }
  const label = settingLabel(definition);
  const numberChoices = definition.key === "archiveIdleDays" ? archiveIdleChoices : undefined;
  const description = webSettingDetails(definition.key)?.description ?? "";
  const mapped = settingToggle(definition.key);
  const enabledChoice = mapped?.on ?? (definition.kind === "enum" && definition.choices?.length === 2 && definition.choices.includes("off") ? definition.choices.find(choice => choice !== "off") : undefined);
  const disabledChoice = mapped?.off ?? "off";
  const isToggle = definition.kind === "boolean" || enabledChoice !== undefined;
  const applyValue = (next: unknown) => apply(definition.key, next, definition.operatorOnly ? "global" : scope);
  // A mapped switch is on for any value other than its off value, so a terminal-chosen variant keeps showing as on.
  const switchOn = definition.kind === "boolean" ? value === true : mapped ? value !== disabledChoice : value === enabledChoice;
  return <SettingsRow id={`setting-${definition.key}`} label={label} description={description} badge={definition.operatorOnly ? "This computer only" : undefined}>
    {definition.kind === "number" ? <NumberSettingControl definition={definition} label={label} value={value} disabled={pending} apply={applyValue} choices={numberChoices} /> : definition.kind === "text" ? <TextSettingControl definition={definition} label={label} value={value} disabled={pending} apply={applyValue} /> : isToggle ? <Switch aria-label={label} checked={switchOn} disabled={pending} onCheckedChange={next => applyValue(definition.kind === "boolean" ? next : next ? enabledChoice : disabledChoice)} /> : <Select aria-label={label} size="sm" className="w-auto min-w-36 shrink-0" value={typeof value === "string" ? value : ""} onValueChange={applyValue} disabled={pending} options={definition.choices?.map(choice => ({ value: choice, label: `${settingChoiceLabel(definition.key, choice)}${definition.key === "executionProfile" && choice === "smolvm" && choice !== value && isolatedReady === false ? " (needs setup)" : ""}`, disabled: definition.key === "executionProfile" && choice === "smolvm" && choice !== value && isolatedReady === false })) ?? []} />}
  </SettingsRow>;
}

/** Whether the sandbox can be used right now; undefined while unknown. */
function useIsolatedReady(): boolean | undefined {
  const { client, webFetchJson } = useBackendApi();
  const status = useQuery({ queryKey: queryKeys.consoleExecution(client.backendId), queryFn: ({ signal }) => webFetchJson<ConsoleExecutionStatus>("/api/console/execution", { signal }), refetchInterval: 5000 });
  const execution = status.data;
  return execution ? Boolean(execution.configured && execution.runtimeReady && execution.imageApproved && execution.platformSupported !== false) : undefined;
}

function ExecutionControl() {
  const { client, webFetchJson } = useBackendApi();
  const status = useQuery({ queryKey: queryKeys.consoleExecution(client.backendId), queryFn: ({ signal }) => webFetchJson<ConsoleExecutionStatus>("/api/console/execution", { signal }), refetchInterval: 5000 });
  const execution = status.data;
  const isolated = execution?.profile === "smolvm";
  const ready = Boolean(execution && (!isolated || execution.configured && execution.runtimeReady && execution.imageApproved && execution.platformSupported !== false));
  return <div className="space-y-3 p-4">
    <QueryState pending={status.isPending} error={status.error} retry={status.refetch} />
    {execution && <>
      <div className="space-y-1"><p className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium">Tool environment</span><span className="text-xs text-muted-foreground">{ready ? "Ready" : "Needs setup"}</span></p>{!ready && <p role="status" className="max-w-lg text-xs leading-5 text-muted-foreground">{execution.platformSupported === false ? "Isolated environments are unavailable on this computer." : "Set up an isolated environment before using it."}</p>}</div>
      {isolated && !ready && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" render={<Link to="/doctor" />}>Check setup</Button><Button size="sm" variant="ghost" render={<Link to="/computers" />}>Choose computer</Button></div>}
      <Disclosure summary="Details" triggerClassName="rounded-[var(--radius-control)] px-1 py-2 text-xs text-muted-foreground hover:text-foreground" contentClassName="space-y-3 px-1 pb-2"><dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]">
        {isolated && <><dt className="text-muted-foreground">Environment setup</dt><dd>{execution.configured ? "Configured" : "Not configured"}</dd><dt className="text-muted-foreground">Runtime</dt><dd>{execution.runtimeReady ? "Available" : "Unavailable"}</dd><dt className="text-muted-foreground">Image</dt><dd>{execution.imageApproved ? "Approved" : "Not approved"}</dd></>}
        {execution.imageDigest && <><dt className="text-muted-foreground">Image digest</dt><dd className="break-all">{execution.imageDigest}</dd></>}
        {execution.resources && <><dt className="text-muted-foreground">Resources</dt><dd>{execution.resources.cpus} CPUs · {execution.resources.memoryMb} MiB memory · {execution.resources.storageGb} GiB storage</dd></>}
      </dl>{execution.error && <p className="text-xs leading-5 text-muted-foreground">{execution.error}</p>}</Disclosure>
    </>}
  </div>;
}

export function SettingsControl({ presentationOnly = false, category = "general" }: { presentationOnly?: boolean; category?: SettingsPageId }) {
  const { webFetchJson } = useBackendApi();
  const settings = useConsoleSettings();
  const isolatedReady = useIsolatedReady();
  const queryClient = useQueryClient();
  const location = useLocation();
  const scope = "global" as const;
  const [resetScope, setResetScope] = useState<"all" | null>(null);
  const resetTriggerRef = useRef<HTMLElement | null>(null);
  const openReset = (scope: "all") => { reset.reset(); resetTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setResetScope(scope); };
  const [message, setMessage] = useState<string | null>(null);
  const dismissNotice = useMutation({ scope: { id: "console-settings" }, mutationFn: () => webFetchJson<SettingsResponse>("/api/console/settings", { method: "PATCH", body: JSON.stringify({ key: "accessUpgradeNoticeDismissed", value: true }) }), onSuccess: data => { queryClient.setQueryData(settings.queryKey, data); } });
  const save = useMutation({ scope: { id: "console-settings" }, mutationFn: async (input: { key: string; value: unknown; scope: "global" | "project" }) => {
    if (!visibleWebSetting(input)) throw new Error("This preference is not managed by the web app.");
    const data = await webFetchJson<SettingsResponse>("/api/console/settings", { method: "PATCH", body: JSON.stringify(input) });
    if (data.persisted === false) throw new Error("Couldn't save this setting.");
    return data;
  }, onSuccess: data => { queryClient.setQueryData(settings.queryKey, data); setMessage("Saved."); } });
  const reset = useMutation({ mutationFn: async () => {
    const keys = sharedSettingKeys(resetPlan?.keys ?? []);
    if (!keys.length) throw new Error("Nothing to reset: these settings already have their default values.");
    const data = await webFetchJson<SettingsResponse>("/api/console/settings/reset", jsonBody({ keys }));
    if (data.persisted === false) throw new Error("Couldn't reset settings.");
    return data;
  }, onSuccess: data => { queryClient.setQueryData(settings.queryKey, data); setResetScope(null); setMessage("Reset to defaults."); } });
  const allDefinitions = settings.data?.definitions.filter(def => visibleWebSetting(def) && !presentationOnly) ?? [];
  const resetPlan = resetScope && settings.data ? planReset(resetScope, allDefinitions, settings.data.settings) : null;
  const allPlan = settings.data ? planReset("all", allDefinitions, settings.data.settings) : null;
  const resetsProtected = resetPlan?.keys.some(isProtectedSetting) ?? false;
  useEffect(() => {
    if (!settings.isSuccess || presentationOnly) return;
    let anchor = location.hash.slice(1);
    try { anchor = decodeURIComponent(anchor); } catch { return; }
    if (!anchor.startsWith("setting-") && !anchor.startsWith("settings-")) return;
    const id = anchor;
    const frame = requestAnimationFrame(() => { const target = document.getElementById(id); target?.scrollIntoView({ block: "start" }); if (anchor.startsWith("setting-")) target?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [category, location.hash, settings.isSuccess, presentationOnly]);
  if (category === "shortcuts" && !presentationOnly) return <ShortcutsControl />;
  if (!presentationOnly && category === "notifications") return <NotificationsSettings />;
  if (!presentationOnly && category === "audit-log") return <AuditLogSettings />;
  if (!presentationOnly && category === "usage") return <UsageSettings />;
  if (!presentationOnly && category === "git") return <GitSettings />;
  if (!presentationOnly && category === "instructions") return <InstructionsSettings />;
  if (category === "appearance") return <>
    <Feedback error={save.error} message={message} />
    <AppearancePage compact={presentationOnly || !settings.data ? undefined : settings.data.settings.density === "compact"} onCompact={next => save.mutate({ key: "density", value: next ? "compact" : "comfortable", scope })} />
  </>;
  return <div className="flex flex-col gap-10">
    <QueryState pending={settings.isPending} error={settings.error} retry={settings.refetch} />
    <Feedback error={save.error ?? (resetScope === null ? reset.error : null)} message={message} />
    <ConfirmDialog open={resetScope !== null} onOpenChange={open => { if (!open) setResetScope(null); }} pending={reset.isPending} spinner destructive
      title="Reset all settings?"
      description={resetsProtected ? "Safety and privacy settings return to their defaults, which can be less restrictive." : "Only the settings listed here change."}
      onCloseAutoFocus={event => { event.preventDefault(); resetTriggerRef.current?.focus(); }}
      error={<Feedback error={reset.error} />} confirmLabel="Reset" confirmDisabled={!resetPlan?.keys.length} onConfirm={() => reset.mutate()}>
      {resetPlan && (resetPlan.changes.length ? <ul aria-label="Settings that will change" className="flex flex-col gap-1 text-sm">{resetPlan.changes.map(change => <li key={change.key} className="flex min-w-0 justify-between gap-4"><span className="min-w-0 break-words [overflow-wrap:anywhere]">{change.label}</span><span className="max-w-[55%] shrink-0 break-words text-right text-muted-foreground-2 [overflow-wrap:anywhere]">{change.from} to {change.to}</span></li>)}</ul> : <p role="status" className="text-sm text-muted-foreground-2">Everything here already has its default value.</p>)}
      {resetPlan && resetPlan.untouched.length > 0 && <div><h4 className="text-sm font-medium">Unchanged</h4><ul aria-label="Settings left unchanged" className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground-2">{resetPlan.untouched.map(item => <li key={item.key} className="flex min-w-0 justify-between gap-4"><span className="min-w-0 break-words [overflow-wrap:anywhere]">{item.label}</span><span className="max-w-[55%] shrink-0 break-words text-right [overflow-wrap:anywhere]">{item.value}</span></li>)}</ul></div>}
    </ConfirmDialog>
    {settingsCategories.filter(section => categoriesOfPage(category).includes(section.id)).map(section => {
      const definitions = allDefinitions.filter(def => categoryFor(def) === section.id && !hiddenInto(def.key) && !(def.key === "compactionThreshold" && settings.data?.settings.autoCompaction === false));
      const hasContent = definitions.length > 0 || section.id === "appearance" || (section.id === "agents" && !presentationOnly);
      if (!hasContent) return settings.isSuccess ? <p key={section.id} id={`settings-${section.id}`} role="status" className="px-1 text-sm text-muted-foreground-2">Nothing to configure here yet.</p> : null;
      return <SettingsSection key={section.id} id={`settings-${section.id}`} title={section.label} description={section.id === "privacy" ? privacyDisclosure : undefined} quiet={categoriesOfPage(category).length === 1}>
        {!presentationOnly && section.id === "agents" && settings.data?.accessUpgradeNotice && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
          <p className="min-w-0 text-muted-foreground-2">Threads and Agents now always have shell access; limits are scope, budget and the sandbox.</p>
          <Button type="button" variant="ghost" size="sm" disabled={dismissNotice.isPending} onClick={() => dismissNotice.mutate()}>Dismiss</Button>
        </div>}
        {definitions.map(def => <SettingRow key={def.key} definition={def} value={settings.data!.settings[def.key]} scope={scope} pending={reset.isPending} isolatedReady={isolatedReady} group={{ keys: settingGroup(def.key).filter(key => settings.data!.definitions.some(item => item.key === key)), values: settings.data!.settings }} apply={(key, value, layer) => save.mutate({ key, value, scope: layer })} />)}
        {!presentationOnly && section.id === "agents" && <ExecutionControl />}
      </SettingsSection>;
    })}
    {!presentationOnly && category === "general" && <StatusSettings />}
    {!presentationOnly && settings.data && category === "general" && <SettingsSection id="settings-reset" title="Reset">
      <SettingsRow id="setting-reset" label="Reset all settings"><Button variant="outline" size="sm" disabled={save.isPending || reset.isPending || !allPlan?.keys.length} onClick={() => openReset("all")}>Reset</Button></SettingsRow>
    </SettingsSection>}
  </div>;
}
