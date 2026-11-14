import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { ModelPicker } from "@/components/model-picker";
import { ModelIcon, ProviderIcon } from "@/components/provider-icon";
import { useModelCatalog } from "@/console/use-model-catalog";
import { configureChatRuntime } from "@/console/model-source";
import { REASONING_LABELS } from "@/console/reasoning-picker";
import { SettingsCard, SettingsCardRow } from "@/ui/components/settings-card";
import { toast } from "@/ui/components/toast";
import { Skeleton } from "@/ui/components/skeleton";
import { SettingsRow } from "./settings-section";
import { Feedback, jsonBody } from "./control-ui";
import { useProviders } from "./connections-control";
import { differsFromDefault, failingProviders, modelRows, modelsPageState } from "./models-model";
import type { RuntimeSelection, SessionSnapshot, SessionSummary } from "./contracts";

type Reasoning = { effort?: string; options: string[] } | null | undefined;

function Heading({ id, title, description }: { id: string; title: string; description?: string }) {
  return <div className="flex min-w-0 flex-col gap-1.5"><h2 id={id} className="text-base leading-[1.2] font-medium text-foreground">{title}</h2>{description && <p className="text-sm font-normal text-muted-foreground-2">{description}</p>}</div>;
}

export function ModelsControl({ sessionId, onApplied }: { sessionId?: string; onApplied?: (session: SessionSummary) => void }) {
  const api = useBackendApi();
  const { client, webFetchJson } = api;
  const providers = useProviders();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [singleModel, setSingleModel] = useState(false);
  const [autoRoute, setAutoRoute] = useState(true);
  const snapshot = useQuery({ queryKey: queryKeys.consoleControlSession(sessionId), enabled: !!sessionId, queryFn: async ({ signal }) => (await webFetchJson<{ snapshot: SessionSnapshot }>(`/api/console/sessions/${encodeURIComponent(sessionId!)}`, { signal })).snapshot, refetchInterval: 2000 });
  const runtime = snapshot.data?.session.runtime ?? snapshot.data?.runtime;
  const reasoning = (snapshot.data?.runtime as { reasoning?: Reasoning } | null | undefined)?.reasoning;
  const initializedSession = useRef<string | null>(null);
  const models = useModelCatalog({ backendId: client.backendId, webFetchJson, connectionIdentity: runtime?.connectionIdentity, enabled: !sessionId || Boolean(snapshot.data) });
  useEffect(() => {
    const key = sessionId ?? "new";
    if (initializedSession.current === key || !providers.data || (sessionId && !snapshot.data)) return;
    setProviderId(runtime?.providerId ?? providers.data.preference?.providerId ?? providers.data.providers.find(provider => provider.configured)?.id ?? "");
    setModel(runtime?.model ?? providers.data.preference?.model ?? "");
    setAgentModels(runtime?.agentModels ?? {}); setSingleModel(runtime?.singleModel ?? false); setAutoRoute(runtime?.autoRoute ?? true);
    initializedSession.current = key;
  }, [providers.data, runtime, sessionId, snapshot.data]);
  const mutation = useMutation({
    scope: { id: `model-settings:${sessionId ?? "new"}` },
    mutationFn: async (selection: RuntimeSelection) => {
      if (!providers.data?.providers.some(provider => provider.id === selection.providerId && provider.configured)) throw new Error("Connect this provider first.");
      if (!selection.model?.trim()) throw new Error("Choose a model.");
      // Preferences are only saved by a successful runtime selection, so the first choice on a fresh page binds a chat.
      const owner = sessionId ?? (await webFetchJson<{ session: SessionSummary }>("/api/console/sessions", jsonBody({}))).session.id;
      const data = await webFetchJson<{ session: SessionSummary }>(`/api/console/sessions/${encodeURIComponent(owner)}/configuration`, { method: "PATCH", body: JSON.stringify({ runtime: selection }) });
      return data.session;
    },
    onSuccess: async session => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.consoleControlSession() }), queryClient.invalidateQueries({ queryKey: queryKeys.consoleSessions() }), providers.refetch()]);
      if (onApplied) onApplied(session);
      else if (!sessionId) navigate(`/models?session=${encodeURIComponent(session.id)}&return=${encodeURIComponent(`/chats/${session.id}`)}`, { replace: true });
    },
  });
  const effort = useMutation({
    mutationFn: (next: string) => configureChatRuntime(api, sessionId!, { reasoningEffort: next } as never, snapshot.data?.runtime as never),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.consoleControlSession() }),
  });
  const current = (): RuntimeSelection => ({ providerId, model: model.trim(), agentModels, singleModel, autoRoute });
  const apply = (change: RuntimeSelection, announce?: { previous: RuntimeSelection }) => {
    const next = { ...current(), ...change };
    if (change.providerId !== undefined) setProviderId(change.providerId);
    if (change.model !== undefined) setModel(change.model);
    if (change.agentModels !== undefined) setAgentModels(change.agentModels);
    if (change.singleModel !== undefined) setSingleModel(change.singleModel);
    if (change.autoRoute !== undefined) setAutoRoute(change.autoRoute);
    mutation.reset();
    if (!next.model?.trim() || !providers.data?.providers.some(provider => provider.id === next.providerId && provider.configured)) return;
    const previous = announce?.previous;
    mutation.mutate(next, {
      onSuccess: () => { if (announce) toast({ id: "default-model", title: `Default model: ${next.model}`, kind: "success", action: previous?.model ? { label: "Undo", onClick: () => apply(previous) } : undefined }); },
      onError: () => { if (previous) { setProviderId(previous.providerId ?? ""); setModel(previous.model ?? ""); setAgentModels(previous.agentModels ?? {}); } },
    });
  };
  const list = providers.data?.providers ?? [];
  const state = modelsPageState({ providers: providers.data?.providers, loading: providers.isPending });
  const connectedIds = new Set(list.filter(provider => provider.configured).map(provider => provider.id));
  const availableModels = (models.data?.models ?? []).filter(item => connectedIds.has(item.provider));
  const failing = failingProviders(models.data?.diagnostics ?? [], list);
  const rows = modelRows(models.data?.models ?? [], list);
  const effortOptions = reasoning && reasoning.options.length >= 2 ? reasoning.options : null;
  const preference = providers.data?.preference;
  const advancedPicker = state === "ready" && !!model;

  if (state === "loading") return <div className="flex flex-col gap-10" role="status" aria-label="Loading models"><Skeleton className="h-28 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (providers.error) return <Feedback error={providers.error} />;
  if (state === "empty") return <section aria-labelledby="models-heading" className="flex flex-col gap-4"><Heading id="models-heading" title="Default model" />
    <SettingsCard><SettingsCardRow><p className="min-w-0 flex-1 text-sm text-muted-foreground-2">No models yet. Connect a provider to choose one.</p><Button type="button" onClick={() => navigate("/connections")}>Connect a provider</Button></SettingsCardRow></SettingsCard></section>;

  return <div className="flex flex-col gap-10">
    <section aria-labelledby="models-default-heading" className="flex flex-col gap-4">
      <h2 id="models-default-heading" className="sr-only">Default model</h2>
      <SettingsCard>
        <SettingsRow id="default-model" label="Default model" description={v("Used for new {missions}.")}>
          <ModelPicker label="Choose model" triggerClassName="h-7 w-44 max-w-full sm:w-56" onOpen={models.refreshIfStale} models={availableModels} providers={list} backendId={client.backendId} selected={{ providerId, model }} disabled={mutation.isPending && !model}
            onSelect={item => apply({ providerId: item.provider, model: item.id, agentModels: item.provider === providerId ? agentModels : {} }, { previous: current() })} pending={models.isPending} />
          {differsFromDefault({ providerId, model }, preference) && preference && <button type="button" className="text-xs text-muted-foreground-2 underline underline-offset-2 hover:text-foreground" onClick={() => apply({ providerId: preference.providerId, model: preference.model, agentModels: {} })}>Use default</button>}
        </SettingsRow>
        {failing.map(item => <SettingsCardRow key={item.providerId} className="py-3"><p title={item.title || undefined} className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground-2"><ProviderIcon providerId={item.providerId} className="size-3.5 shrink-0" /><span className="truncate">{item.label} needs attention</span></p><Link to="/connections" className="shrink-0 text-sm text-muted-foreground-1 underline underline-offset-2 hover:text-foreground">Open Connections</Link></SettingsCardRow>)}
        {effortOptions && sessionId && <SettingsRow id="reasoning-effort" label="Reasoning effort" description="How long the model thinks before it answers.">
          <Select aria-label="Reasoning effort" size="sm" className="w-auto min-w-32 shrink-0" disabled={effort.isPending} value={reasoning?.effort ?? "medium"} onValueChange={next => effort.mutate(next)} options={effortOptions.map(option => ({ value: option, label: REASONING_LABELS[option] ?? option }))} />
        </SettingsRow>}
      </SettingsCard>
      <Feedback error={mutation.error ?? effort.error} />
    </section>
    {advancedPicker && <section aria-labelledby="models-advanced-heading" className="flex flex-col gap-4">
      <Heading id="models-advanced-heading" title="Advanced" />
      <SettingsCard>
        {providerId === "openai" && <SettingsRow label="Custom model ID" description={"Saved when you leave the field."}>
          <Input aria-label="Custom model ID" className="h-7 w-44 max-w-full sm:w-56" value={model} maxLength={256} onChange={event => setModel(event.target.value)} onBlur={() => { if (model.trim() && model.trim() !== runtime?.model) apply({ model: model.trim() }); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (model.trim()) apply({ model: model.trim() }); } }} />
        </SettingsRow>}
        <SettingsRow label="Use one model for everything"><Switch aria-label="Use one model for everything" checked={singleModel} disabled={mutation.isPending} onCheckedChange={value => apply({ singleModel: value })} /></SettingsRow>
        <SettingsRow label="Pick models per task automatically"><Switch aria-label="Pick models per task automatically" checked={autoRoute} disabled={singleModel || mutation.isPending} onCheckedChange={value => apply({ autoRoute: value })} /></SettingsRow>
        {!singleModel && models.data?.roles.map(role => <SettingsRow key={role} label={`${role[0]?.toUpperCase()}${role.slice(1)} model`}>
          <Select aria-label={`${role} model`} value={agentModels[role] ?? "auto"} disabled={mutation.isPending} onValueChange={value => apply({ agentModels: { ...agentModels, [role]: value } })} options={[{ value: "auto", label: "Auto" }, ...availableModels.filter(item => item.provider === providerId).map(item => ({ value: item.id, label: <span className="flex min-w-0 items-center gap-2"><ModelIcon modelId={item.id} providerId={item.provider} /><span className="truncate">{item.id}</span></span> }))]} />
        </SettingsRow>)}
      </SettingsCard>
    </section>}
    <section aria-labelledby="models-list-heading" className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4"><Heading id="models-list-heading" title="Models" description="Available through your connections." /><Link to="/connections" className="shrink-0 text-sm text-muted-foreground-1 underline underline-offset-2 hover:text-foreground">Manage connections</Link></div>
      <SettingsCard>
        {rows.length === 0 && <SettingsCardRow><p className="text-sm text-muted-foreground-2">{models.isPending ? "Loading models…" : "No models available right now."}</p></SettingsCardRow>}
        {rows.map(row => <SettingsCardRow key={row.key} className={`py-3 ${row.disabled ? "opacity-60" : ""}`} data-model-row>
          <ModelIcon modelId={row.id} providerId={row.providerId} className="size-4 shrink-0" />
          <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium text-foreground" title={row.id}>{row.id}</h3><p className="truncate text-sm text-muted-foreground-2">{[row.providerLabel, row.hint ?? row.detail].filter(Boolean).join(" · ")}</p></div>
        </SettingsCardRow>)}
      </SettingsCard>
    </section>
  </div>;
}
