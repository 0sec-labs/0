import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check as CheckIcon } from "lucide-react";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { WorkspaceChoice, type WorkspaceChoiceAction, type WorkspaceChoiceHandle } from "@/components/workspace-choice";
import { useTeamAccess } from "@/components/team-access";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";
import { ConnectionsControl, useProviders } from "./connections-control";
import { chooseOnboardingModel } from "./onboarding-model";
import { useConsoleSettings } from "./settings-control";
import { Feedback, QueryState, SubmitButton, jsonBody } from "./control-ui";
import type { ModelsResponse, SessionSnapshot, SessionSummary, SettingsResponse } from "./contracts";

const steps = [
  { id: "connect", label: "AI", title: "Choose your AI" },
  { id: "workspace", label: "Workspace", title: "Make it your workspace" },
  { id: "privacy", label: "Ready", title: "Ready to get started" },
] as const;
type StepId = typeof steps[number]["id"];
const stepDescriptions: Record<StepId, string> = {
  connect: "Sign in or connect an API key. You can change models in your chat.",
  workspace: "Work on your own, or create a shared workspace for your team.",
  privacy: "Review your sharing preferences, then open your workspace.",
};

export function OnboardingControl({ sessionId, returnTo }: { sessionId?: string; returnTo: string }) {
  const { webFetch, webFetchJson } = useBackendApi();
  const navigate = useNavigate();
  const team = useTeamAccess();
  const [search, setSearch] = useSearchParams();
  const queryClient = useQueryClient();
  const settings = useConsoleSettings();
  const requestedStep = search.get("step");
  const retiredStep = requestedStep === "scope" || requestedStep === "look" || requestedStep === "model";
  const requested = steps.findIndex(item => item.id === (requestedStep === "model" ? "connect" : retiredStep ? "privacy" : requestedStep));
  const step = requested < 0 ? 0 : requested;
  const current = steps[step];
  const setStep = (index: number) => { const next = new URLSearchParams(search); next.set("step", steps[Math.max(0, Math.min(index, steps.length - 1))].id); setSearch(next, { replace: true }); };
  useEffect(() => {
    if (!retiredStep) return;
    const next = new URLSearchParams(search);
    next.set("step", requestedStep === "model" ? "connect" : "privacy");
    setSearch(next, { replace: true });
  }, [retiredStep, requestedStep, search, setSearch]);

  // The session in the URL may have been removed since the link was made. A missing session must not
  // block setup: steps that need one create a fresh session instead of patching a 404.
  const sessionCheck = useQuery({ queryKey: ["setup-session", sessionId], enabled: !!sessionId, retry: false, staleTime: Infinity, queryFn: async ({ signal }) => {
    const response = await webFetch(`/api/console/sessions/${encodeURIComponent(sessionId!)}`, { signal });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`The current session could not be loaded (${response.status} ${response.statusText}).`);
    return true;
  } });
  const [createdSession, setCreatedSession] = useState<string>();
  const owner = createdSession ?? (sessionCheck.data === true ? sessionId : undefined);
  const exitTo = owner ? (owner === sessionId ? returnTo : `/console/${encodeURIComponent(owner)}`) : sessionCheck.data === false ? "/console" : returnTo;
  const sessionGate = sessionId && !sessionCheck.isSuccess && <QueryState pending={sessionCheck.isPending} error={sessionCheck.error} retry={sessionCheck.refetch} />;

  const [analytics, setAnalytics] = useState("usage");
  const [reporting, setReporting] = useState("ask");
  const [analyticsChanged, setAnalyticsChanged] = useState(false);
  const [reportingChanged, setReportingChanged] = useState(false);
  const [consentReady, setConsentReady] = useState(false);
  const focusRef = useRef<HTMLHeadingElement>(null);
  const stepperRef = useRef<HTMLOListElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    stepperRef.current?.querySelector("[aria-current=step]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (mounted.current) focusRef.current?.focus();
    mounted.current = true;
  }, [step]);
  useEffect(() => { if (settings.data) { if (!analyticsChanged) setAnalytics(String(settings.data.settings.analyticsLevel ?? "usage")); if (!reportingChanged) setReporting(String(settings.data.settings.diagnosticReporting ?? "ask")); setConsentReady(true); } }, [settings.data, analyticsChanged, reportingChanged]);
  const complete = useMutation({ mutationFn: async () => {
    if (!settings.data || !consentReady) throw new Error("Load the server's current sharing preferences before completing onboarding.");
    const latest = await webFetchJson<SettingsResponse>("/api/console/settings");
    const entries: [string, unknown][] = [];
    if (analyticsChanged && analytics !== latest.settings.analyticsLevel) entries.push(["analyticsLevel", analytics]);
    if (reportingChanged && reporting !== latest.settings.diagnosticReporting) entries.push(["diagnosticReporting", reporting]);
    entries.push(["diagnosticReportingPrompted", true], ["onboardingCompleted", true]);
    let data: SettingsResponse = latest;
    for (const [key, value] of entries) {
      data = await webFetchJson<SettingsResponse>("/api/console/settings", { method: "PATCH", body: JSON.stringify({ key, value, scope: "global" }) });
      if (data.persisted === false) throw new Error(`Could not save ${key}. Onboarding has not been marked complete.`);
    }
    return data;
  }, onSuccess: data => { queryClient.setQueryData(settings.queryKey, data); navigate(exitTo); } });
  const [selectedAI, setSelectedAI] = useState({ id: "", connected: false });
  const providerChanged = useCallback((id: string, connected: boolean) => setSelectedAI(previous => previous.id === id && previous.connected === connected ? previous : { id, connected }), []);
  const modelStep = useRef<ModelStepHandle>(null);
  const workspaceStep = useRef<WorkspaceChoiceHandle>(null);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceChoiceAction>({ ready: true, busy: false, label: "Continue", showAction: false });
  const [modelState, setModelState] = useState({ ready: false, pending: false });
  const applied = (session: SessionSummary) => { setCreatedSession(session.id); setModelState({ ready: true, pending: false }); setStep(1); };

  const done: Record<StepId, boolean> = {
    workspace: step > 1 || team.enabled,
    connect: selectedAI.connected && modelState.ready,
    privacy: settings.data?.settings.diagnosticReportingPrompted === true,
  };

  return <div className="mx-auto flex w-full max-w-2xl flex-col px-5 py-10 sm:px-8 sm:py-14">
    <header className="mb-8 flex items-center gap-4"><BrandMark /></header>
    <ol ref={stepperRef} aria-label="Onboarding progress" className="mb-9 flex gap-3">{steps.map((item, index) => {
      const active = index === step;
      const finished = index < step && done[item.id] && !active;
      return <li key={item.id} className="min-w-0 flex-1"><Button variant="ghost" size="sm" type="button" onClick={() => setStep(index)} aria-current={active ? "step" : undefined} className={cn("h-auto w-full flex-col items-start gap-2 px-0 text-left text-xs font-normal", active ? "text-brand-orange" : "text-muted-foreground")}>
        <span className={cn("h-1 w-full rounded-full transition-colors motion-reduce:transition-none", active ? "bg-brand-orange" : finished ? "bg-brand-orange/40" : "bg-muted")} />
        <span className="flex items-center gap-1.5">{finished ? <CheckIcon className="size-3.5 shrink-0" aria-label="Done" /> : <span className="tabular-nums">{index + 1}</span>}<span className="truncate">{item.label}</span></span>
      </Button></li>;
    })}</ol>
    <section key={current.id} className="console-enter min-h-[min(320px,45dvh)] space-y-6 motion-reduce:animate-none sm:min-h-[360px]" aria-labelledby="setup-step-title">
      <div className="space-y-2"><h1 id="setup-step-title" ref={focusRef} tabIndex={-1} className="text-2xl font-medium tracking-tight outline-none sm:text-3xl">{current.title}</h1><p className="text-sm leading-6 text-muted-foreground">{stepDescriptions[current.id]}</p></div>
    {current.id === "connect" && <>
      <ConnectionsControl focused onProviderChange={providerChanged} />
      {selectedAI.connected && (sessionGate || <ModelStep key={selectedAI.id} ref={modelStep} owner={owner} providerId={selectedAI.id} onApplied={applied} onStateChange={setModelState} />)}
    </>}
    {current.id === "workspace" && <WorkspaceChoice ref={workspaceStep} externalActions onActionChange={setWorkspaceState} stacked initialMode={search.get("mode") === "team" ? "team" : "personal"} teamName={team.enabled ? team.workspace?.name : undefined} onContinue={() => setStep(step + 1)} />}
    {current.id === "privacy" && <div className="space-y-5">
      <QueryState pending={settings.isPending} error={settings.error} retry={settings.refetch} />
      <div className="divide-y divide-border/50">
        <div className="flex items-center justify-between gap-6 py-4"><div className="space-y-1"><label htmlFor="setup-usage-metrics" className="text-sm font-medium">Usage metrics</label><p id="setup-usage-metrics-hint" className="text-xs leading-5 text-muted-foreground">Usage counts and timing. No code or prompts.</p></div><Switch id="setup-usage-metrics" aria-label="Usage metrics" aria-describedby="setup-usage-metrics-hint" checked={analytics === "usage"} onCheckedChange={value => { setAnalytics(value ? "usage" : "off"); setAnalyticsChanged(true); }} disabled={!consentReady || complete.isPending} /></div>
        <div className="flex items-center justify-between gap-6 py-4"><div className="space-y-1"><label htmlFor="setup-diagnostic-reports" className="text-sm font-medium">Diagnostic reports</label><p id="setup-diagnostic-reports-hint" className="text-xs leading-5 text-muted-foreground">{reporting === "automatic" ? "Reports send automatically. Change this in Settings." : "Ask before sending. You review each report first."}</p></div><Switch id="setup-diagnostic-reports" aria-label="Diagnostic reports" aria-describedby="setup-diagnostic-reports-hint" checked={reporting !== "off"} onCheckedChange={value => { setReporting(value ? "ask" : "off"); setReportingChanged(true); }} disabled={!consentReady || complete.isPending} /></div>
      </div>
      <Feedback error={complete.error} />
    </div>}

    </section>
    <footer className="mt-8 flex items-center justify-center gap-3 border-t border-border/40 pt-5">
      {step > 0 ? <Button variant="ghost" disabled={complete.isPending || modelState.pending || workspaceState.busy} onClick={() => setStep(step - 1)}><ArrowLeft className="size-4" />Back</Button> : null}
      <div className="flex gap-2">
        {current.id === "workspace" && workspaceState.showAction && <SubmitButton pending={workspaceState.busy} disabled={!workspaceState.ready} onClick={() => workspaceStep.current?.submit()}>{workspaceState.label}<ArrowRight className="size-4" /></SubmitButton>}
        {current.id === "privacy" && <SubmitButton pending={complete.isPending} disabled={!consentReady || settings.isError} onClick={() => complete.mutate()}>Start chatting<ArrowRight className="size-4" /></SubmitButton>}
        {current.id === "connect" && <SubmitButton pending={modelState.pending} disabled={!selectedAI.connected || !modelState.ready || Boolean(sessionGate)} onClick={() => modelStep.current?.submit()}>Continue<ArrowRight className="size-4" /></SubmitButton>}
      </div>
    </footer>
  </div>;
}

// Setup only needs "which model". Role routing and overrides stay on the Models page; an existing
// session's routing is carried over unchanged so applying here never resets it.
interface ModelStepHandle { submit: () => void }
const ModelStep = forwardRef<ModelStepHandle, { owner?: string; providerId: string; onApplied: (session: SessionSummary) => void; onStateChange: (state: { ready: boolean; pending: boolean }) => void }>(function ModelStep({ owner, providerId, onApplied, onStateChange }, ref) {
  const { webFetchJson } = useBackendApi();
  const providers = useProviders();
  const queryClient = useQueryClient();
  const snapshot = useQuery({ queryKey: ["console-control-session", owner], enabled: !!owner, queryFn: async ({ signal }) => (await webFetchJson<{ snapshot: SessionSnapshot }>(`/api/console/sessions/${encodeURIComponent(owner!)}`, { signal })).snapshot });
  const runtime = snapshot.data?.session.runtime ?? snapshot.data?.runtime ?? undefined;
  const createdForApply = useRef<string | undefined>(undefined);
  const models = useQuery({ queryKey: ["console-models", providerId], enabled: !!providerId, queryFn: ({ signal }) => webFetchJson<ModelsResponse>(`/api/console/models?providerId=${encodeURIComponent(providerId)}`, { signal }) });
  const model = chooseOnboardingModel(providerId, runtime, providers.data?.preference, models.data?.models);
  const apply = useMutation({ mutationFn: async () => {
    if (!model || !providerId) throw new Error("No model is available for this account yet.");
    const session = owner ?? createdForApply.current ?? (await webFetchJson<{ session: SessionSummary }>("/api/console/sessions", jsonBody({}))).session.id;
    createdForApply.current = session;
    const routing = runtime?.providerId === providerId ? { agentModels: runtime.agentModels, singleModel: runtime.singleModel, autoRoute: runtime.autoRoute } : {};
    return (await webFetchJson<{ session: SessionSummary }>(`/api/console/sessions/${encodeURIComponent(session)}/configuration`, { method: "PATCH", body: JSON.stringify({ runtime: { providerId, model, ...routing } }) })).session;
  }, onSuccess: async session => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["console-control-session"] }), queryClient.invalidateQueries({ queryKey: ["console-sessions"] }), providers.refetch()]); onApplied(session); } });
  const ready = Boolean(model && providers.isSuccess && models.isSuccess && (!owner || snapshot.isSuccess));
  useEffect(() => onStateChange({ ready, pending: apply.isPending }), [ready, apply.isPending, onStateChange]);
  useImperativeHandle(ref, () => ({ submit: () => { if (ready && !apply.isPending) apply.mutate(); } }));
  if (providers.isPending || providers.error || (owner && (snapshot.isPending || snapshot.error))) return <QueryState pending={providers.isPending || snapshot.isPending} error={providers.error ?? snapshot.error} retry={() => { void providers.refetch(); void snapshot.refetch(); }} />;
  if (models.error) return <QueryState pending={false} error={models.error} retry={models.refetch} />;
  if (models.isSuccess && !model) return <p role="status" className="text-sm text-muted-foreground">No models are available for this account yet.</p>;
  return <Feedback error={apply.error} />;
});
