import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check as CheckIcon } from "lucide-react";
import { webFetch, webFetchJson } from "@/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ConnectionsControl, useProviders } from "./connections-control";
import { ThemeControl, useConsoleSettings } from "./settings-control";
import { ProjectControl } from "./system-control";
import { Check, Facts, Feedback, Field, QueryState, SubmitButton, jsonBody, selectClass } from "./control-ui";
import type { ModelsResponse, SessionSnapshot, SessionSummary, SettingsResponse } from "./contracts";

const steps = [
  { id: "welcome", label: "Welcome", title: "Welcome to 0" },
  { id: "connect", label: "Connect", title: "Connect a provider" },
  { id: "model", label: "Model", title: "Choose a model" },
  { id: "scope", label: "Scope", title: "Set boundaries" },
  { id: "look", label: "Theme", title: "Pick a theme" },
  { id: "privacy", label: "Privacy", title: "Privacy" },
] as const;
type StepId = typeof steps[number]["id"];

export function OnboardingControl({ sessionId, returnTo }: { sessionId?: string; returnTo: string }) {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const queryClient = useQueryClient();
  const providers = useProviders();
  const settings = useConsoleSettings();
  const requested = steps.findIndex(item => item.id === search.get("step"));
  const step = requested < 0 ? 0 : requested;
  const current = steps[step];
  const setStep = (index: number) => { const next = new URLSearchParams(search); next.set("step", steps[Math.max(0, Math.min(index, steps.length - 1))].id); setSearch(next, { replace: true }); };

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

  const [analytics, setAnalytics] = useState("off");
  const [reporting, setReporting] = useState("ask");
  const [analyticsChanged, setAnalyticsChanged] = useState(false);
  const [reportingChanged, setReportingChanged] = useState(false);
  const [automaticApproved, setAutomaticApproved] = useState(false);
  const [consentReady, setConsentReady] = useState(false);
  const focusRef = useRef<HTMLHeadingElement>(null);
  const stepperRef = useRef<HTMLOListElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    stepperRef.current?.querySelector("[aria-current=step]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (mounted.current) focusRef.current?.focus();
    mounted.current = true;
  }, [step]);
  useEffect(() => { if (settings.data) { if (!analyticsChanged) setAnalytics(String(settings.data.settings.analyticsLevel ?? "off")); if (!reportingChanged) setReporting(String(settings.data.settings.diagnosticReporting ?? "ask")); setConsentReady(true); } }, [settings.data, analyticsChanged, reportingChanged]);
  const complete = useMutation({ mutationFn: async () => {
    if (!settings.data || !consentReady) throw new Error("Load the server's current sharing preferences before completing setup.");
    const latest = await webFetchJson<SettingsResponse>("/api/console/settings");
    if (reportingChanged && reporting === "automatic" && latest.settings.diagnosticReporting !== "automatic" && !automaticApproved) throw new Error("Automatic diagnostic reporting needs explicit separate consent.");
    const entries: [string, unknown][] = [];
    if (analyticsChanged && analytics !== latest.settings.analyticsLevel) entries.push(["analyticsLevel", analytics]);
    if (reportingChanged && reporting !== latest.settings.diagnosticReporting) entries.push(["diagnosticReporting", reporting]);
    entries.push(["diagnosticReportingPrompted", true], ["onboardingCompleted", true]);
    let data: SettingsResponse = latest;
    for (const [key, value] of entries) {
      data = await webFetchJson<SettingsResponse>("/api/console/settings", { method: "PATCH", body: JSON.stringify({ key, value, scope: "global" }) });
      if (data.persisted === false) throw new Error(`Could not save ${key}. Setup has not been marked complete.`);
    }
    return data;
  }, onSuccess: data => { queryClient.setQueryData(["console-settings"], data); navigate(exitTo); } });
  const applied = (session: SessionSummary) => { setCreatedSession(session.id); setStep(step + 1); };

  const connected = providers.data?.providers.filter(provider => provider.configured) ?? [];
  const preference = providers.data?.preference ?? null;
  const done: Record<StepId, boolean> = {
    welcome: step > 0 || settings.data?.settings.onboardingCompleted === true,
    connect: connected.length > 0,
    model: !!preference?.model,
    scope: false,
    look: false,
    privacy: settings.data?.settings.diagnosticReportingPrompted === true,
  };
  const reportingNeedsConsent = reportingChanged && reporting === "automatic" && settings.data?.settings.diagnosticReporting !== "automatic";

  return <div className="space-y-6">
    <ol ref={stepperRef} aria-label="Setup progress" className="flex gap-1.5 overflow-x-auto pb-1">{steps.map((item, index) => {
      const active = index === step;
      const finished = done[item.id] && !active;
      return <li key={item.id} className="min-w-[5rem] flex-1"><button type="button" onClick={() => setStep(index)} aria-current={active ? "step" : undefined} className={cn("flex w-full flex-col gap-2 rounded-lg px-1 pb-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
        <span className={cn("h-1 w-full rounded-full transition-colors", active ? "bg-primary" : finished ? "bg-primary opacity-50" : "bg-muted")} />
        <span className="flex items-center gap-1.5">{finished && <CheckIcon className="size-3.5 shrink-0 text-primary-text" aria-label="Done" />}<span className={cn("truncate", active && "font-medium")}>{item.label}</span></span>
      </button></li>;
    })}</ol>

    <h2 ref={focusRef} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">{current.title}</h2>

    {current.id === "welcome" && (providers.isPending || settings.isPending || providers.error || settings.error
      ? <QueryState pending={providers.isPending || settings.isPending} error={providers.error ?? settings.error} retry={() => { void providers.refetch(); void settings.refetch(); }} />
      : done.welcome || connected.length > 0
        ? <div className="space-y-5">
            <Facts entries={[["Provider", preference ? providers.data?.providers.find(provider => provider.id === preference.providerId)?.label ?? preference.providerId : connected.map(provider => provider.label).join(", ") || "None"], ["Model", preference?.model ?? "Not chosen"]]} />
            <div className="flex flex-wrap gap-2"><Button onClick={() => navigate(exitTo)}>Go to console<ArrowRight className="size-4" /></Button><Button variant="outline" onClick={() => setStep(1)}>Review setup</Button></div>
          </div>
        : <div className="space-y-5">
            <p className="text-sm text-muted-foreground">Connect a provider and pick a model. Takes about a minute.</p>
            <div className="flex flex-wrap gap-2"><Button onClick={() => setStep(1)}>Get started<ArrowRight className="size-4" /></Button><Button variant="ghost" onClick={() => navigate(exitTo)}>Later</Button></div>
          </div>)}
    {current.id === "connect" && <ConnectionsControl onConnected={() => setStep(step + 1)} />}
    {current.id === "model" && (sessionGate || <ModelStep owner={owner} onApplied={applied} />)}
    {current.id === "scope" && (sessionGate || <ProjectControl sessionId={owner} onApplied={applied} />)}
    {current.id === "look" && <ThemeControl />}
    {current.id === "privacy" && <div className="space-y-5">
      <QueryState pending={settings.isPending} error={settings.error} retry={settings.refetch} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Usage metrics" hint="Anonymous counts and timing. Never code or prompts."><select value={analytics} onChange={event => { setAnalytics(event.target.value); setAnalyticsChanged(true); }} className={selectClass} disabled={!consentReady || complete.isPending}><option value="off">Off</option><option value="usage">Share</option></select></Field>
        <Field label="Diagnostic reports"><select value={reporting} onChange={event => { setReporting(event.target.value); setReportingChanged(true); setAutomaticApproved(false); }} className={selectClass} disabled={!consentReady || complete.isPending}><option value="off">Off</option><option value="ask">Ask before sending</option><option value="automatic">Send automatically</option></select></Field>
      </div>
      {reportingNeedsConsent && <Check checked={automaticApproved} onChange={setAutomaticApproved}>I authorize sending diagnostic reports automatically to the configured destination.</Check>}
      <Feedback error={complete.error} />
      <SubmitButton pending={complete.isPending} disabled={!consentReady || settings.isError || (reportingNeedsConsent && !automaticApproved)} onClick={() => complete.mutate()}>Finish setup<ArrowRight className="size-4" /></SubmitButton>
    </div>}

    {step > 0 && <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-3 border-t border-border bg-card/95 px-1 py-3 backdrop-blur">
      <Button variant="ghost" disabled={complete.isPending} onClick={() => setStep(step - 1)}><ArrowLeft className="size-4" />Back</Button>
      <div className="flex gap-2">
        <Button variant="ghost" disabled={complete.isPending} onClick={() => navigate(exitTo)}>Exit</Button>
        {step < steps.length - 1 && <Button variant={done[current.id] ? "default" : "outline"} onClick={() => setStep(step + 1)}>{done[current.id] ? "Continue" : "Skip"}<ArrowRight className="size-4" /></Button>}
      </div>
    </div>}
  </div>;
}

// Setup only needs "which model". Role routing and overrides stay on the Models page; an existing
// session's routing is carried over unchanged so applying here never resets it.
function ModelStep({ owner, onApplied }: { owner?: string; onApplied: (session: SessionSummary) => void }) {
  const providers = useProviders();
  const queryClient = useQueryClient();
  const snapshot = useQuery({ queryKey: ["console-control-session", owner], enabled: !!owner, queryFn: async ({ signal }) => (await webFetchJson<{ snapshot: SessionSnapshot }>(`/api/console/sessions/${encodeURIComponent(owner!)}`, { signal })).snapshot });
  const runtime = snapshot.data?.session.runtime ?? snapshot.data?.runtime ?? undefined;
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  useEffect(() => { if (!providerId && providers.data && (!owner || snapshot.data)) { setProviderId(runtime?.providerId ?? providers.data.preference?.providerId ?? providers.data.providers.find(provider => provider.configured)?.id ?? ""); setModel(runtime?.model ?? providers.data.preference?.model ?? ""); } }, [providers.data, snapshot.data, owner, providerId, runtime]);
  const models = useQuery({ queryKey: ["console-models", providerId], enabled: !!providerId, queryFn: ({ signal }) => webFetchJson<ModelsResponse>(`/api/console/models?providerId=${encodeURIComponent(providerId)}`, { signal }) });
  const connected = providers.data?.providers.filter(provider => provider.configured) ?? [];
  const apply = useMutation({ mutationFn: async () => {
    const session = owner ?? (await webFetchJson<{ session: SessionSummary }>("/api/console/sessions", jsonBody({}))).session.id;
    const routing = runtime ? { agentModels: runtime.agentModels, singleModel: runtime.singleModel, autoRoute: runtime.autoRoute } : {};
    return (await webFetchJson<{ session: SessionSummary }>(`/api/console/sessions/${encodeURIComponent(session)}/configuration`, { method: "PATCH", body: JSON.stringify({ runtime: { providerId, model, ...routing } }) })).session;
  }, onSuccess: async session => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["console-control-session"] }), queryClient.invalidateQueries({ queryKey: ["console-sessions"] }), providers.refetch()]); onApplied(session); } });

  if (providers.isPending || providers.error || (owner && (snapshot.isPending || snapshot.error))) return <QueryState pending={providers.isPending || snapshot.isPending} error={providers.error ?? snapshot.error} retry={() => { void providers.refetch(); void snapshot.refetch(); }} />;
  if (connected.length === 0) return <p className="text-sm text-muted-foreground">Connect a provider first.</p>;
  return <form className="space-y-5" onSubmit={event => { event.preventDefault(); apply.mutate(); }}>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Provider"><select value={providerId} onChange={event => { setProviderId(event.target.value); setModel(""); apply.reset(); }} className={selectClass}>{connected.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></Field>
      <Field label="Model"><select value={model} onChange={event => setModel(event.target.value)} disabled={models.isPending} className={selectClass} required><option value="">{models.isPending ? "Loading…" : "Choose a model"}</option>{models.data?.models.map(item => <option key={`${item.provider}:${item.id}`} value={item.id}>{item.id}{item.price ? ` · ${item.price}` : ""}</option>)}</select></Field>
    </div>
    <Feedback error={apply.error ?? models.error} />
    <div className="flex flex-wrap items-center gap-4"><SubmitButton type="submit" pending={apply.isPending} disabled={!model}>Use this model</SubmitButton><Link to="/models" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Advanced routing</Link></div>
  </form>;
}
