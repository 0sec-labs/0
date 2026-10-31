import { ControlDisclosure } from "./control-disclosure";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, ShieldCheck, CheckCircle2, Plus } from "lucide-react";
import { AgentOnboarding } from "@/console/agent-onboarding";
import { useBackendSelection } from "@/backend-context";
import { useBackendApi } from "@/api";
import { ChoiceCard } from "@/components/ui/choice-card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ModelIcon, ProviderIcon } from "@/components/provider-icon";
import { ModelPicker } from "@/components/model-picker";
import { ControlCard, Empty, Feedback, Field, QueryState, SubmitButton, TextField, jsonBody } from "./control-ui";
import type { AuthStatus, ModelsResponse, ProvidersResponse, RuntimeSelection, SessionSnapshot, SessionSummary } from "./contracts";
import { GitHubPublicationControl } from "./github-publication-control";

const officialAuthHosts: Record<string, readonly string[]> = {
  "chatgpt-plan": ["auth.openai.com"], "chatgpt-codex": ["auth.openai.com"], codex: ["auth.openai.com"], copilot: ["github.com"],
  xai: ["auth.x.ai"], kimi: ["auth.kimi.com"], openrouter: ["openrouter.ai"], google: ["accounts.google.com"],
};
const supportsEndpoint: Record<string, true> = { deepseek: true, anthropic: true, azure: true, openai: true, "z-ai": true, kimi: true, qwen: true, xai: true, opencode: true, cline: true, copilot: true };

function officialAuthUrl(providerId: string, raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && officialAuthHosts[providerId]?.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

export function useProviders() {
  const { webFetchJson } = useBackendApi();
  return useQuery({ queryKey: ["console-providers"], queryFn: ({ signal }) => webFetchJson<ProvidersResponse>("/api/console/providers", { signal }), refetchInterval: query => query.state.data?.providers.some(provider => provider.auth.phase === "running") ? 1000 : false });
}

export function ConnectionsControl({ onConnected, focused = false, onProviderChange }: { onConnected?: () => void; focused?: boolean; onProviderChange?: (providerId: string, connected: boolean) => void }) {
  const { client, webFetchJson } = useBackendApi();
  const hosts = useBackendSelection();
  const hostName = hosts?.backends.find(host => host.id === client.backendId)?.name ?? "this host";
  const queryClient = useQueryClient();
  const providers = useProviders();
  const [selected, setSelected] = useState("");
  const [addingProvider, setAddingProvider] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [projectId, setProjectId] = useState("");
  const [disconnect, setDisconnect] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const provider = providers.data?.providers.find(item => item.id === selected);
  const authUrl = provider ? officialAuthUrl(provider.id, provider.auth.verificationUrl) : null;
  const connectedProviders = providers.data?.providers.filter(item => item.configured && item.diagnostics.valid) ?? [];
  const chooseProvider = (id: string) => { setSelected(id); setAddingProvider(false); };
  useEffect(() => { if (provider) onProviderChange?.(provider.id, provider.configured && provider.diagnostics.valid); }, [provider?.id, provider?.configured, provider?.diagnostics.valid, onProviderChange]);
  useEffect(() => { if (provider?.configured && provider.diagnostics.valid) setAddingProvider(false); }, [provider?.id, provider?.configured, provider?.diagnostics.valid]);

  useEffect(() => { if (!selected && providers.data) setSelected(providers.data.preference?.providerId ?? providers.data.providers.find(item => item.configured)?.id ?? providers.data.providers[0]?.id ?? ""); }, [providers.data, selected]);
  useEffect(() => { setApiKey(""); setBaseUrl(provider?.configuration?.baseUrl ?? ""); setModel(provider?.configuration?.model ?? ""); setProjectId(provider?.configuration?.projectId ?? ""); setDisconnect(null); setMessage(null); }, [selected]);

  const mutation = useMutation({
    mutationFn: async (input: { action: "connect" | "activate" | "disconnect" | "configure"; accountId?: string }) => {
      if (!provider) throw new Error("Choose a provider first.");
      if (input.action === "connect" && !apiKey.trim()) throw new Error("Enter an API key.");
      if (baseUrl.trim()) {
        const url = new URL(baseUrl.trim());
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && (provider.id === "openai" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))) throw new Error("Enter a plain https:// URL (custom OpenAI-compatible providers also support http://).");
      }
      return webFetchJson<ProvidersResponse & { message?: string }>("/api/console/connections", jsonBody({ providerId: provider.id, ...input, ...(input.action === "connect" ? { apiKey: apiKey.trim() } : {}), ...(["connect", "configure"].includes(input.action) ? { ...(supportsEndpoint[provider.id] && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...((provider.id === "azure" || provider.id === "openai") && model.trim() ? { model: model.trim() } : {}), ...(input.action === "configure" && provider.id === "google" && projectId.trim() ? { projectId: projectId.trim() } : {}) } : {}) }));
    },
    onSuccess: async (data, input) => {
      queryClient.setQueryData(["console-providers"], data);
      setApiKey(""); setDisconnect(null);
      setMessage(data.message ?? (input.action === "connect" ? "Connected. Now choose a model." : input.action === "configure" ? "Saved." : input.action === "activate" ? "Account activated." : "Account removed."));
      await queryClient.invalidateQueries({ queryKey: ["console-models"] });
      if (input.action === "connect") onConnected?.();
    },
    onSettled: () => { setApiKey(""); },
  });
  const auth = useMutation({
    mutationFn: (input: boolean | { profileId: string }) => webFetchJson<{ status: AuthStatus }>(`/api/console/providers/${encodeURIComponent(selected)}/device-auth`, { method: input === true ? "DELETE" : "POST", body: JSON.stringify(typeof input === "object" ? input : {}) }),
    onSuccess: async () => { await providers.refetch(); },
  });

  return <div className="space-y-5">
    <QueryState pending={providers.isPending} error={providers.error} retry={providers.refetch} />
    {!focused && <p className="text-sm text-muted-foreground">These model connections belong to <span className="font-medium text-foreground">{hostName}</span>. A connected Codex account here can also power chats whose tools run on a registered remote host.</p>}
    {!focused && providers.data && <div className="grid gap-3 sm:grid-cols-2">{[{ id: "chatgpt-plan", title: "ChatGPT plan", description: "Sign in directly to 0 and choose whether to allow your ChatGPT plan." }, { id: "chatgpt-codex", title: "ChatGPT / Codex account", description: "Sign in with ChatGPT, or use the Codex sign-in already available on this host." }, { id: "anthropic", title: "Claude via Anthropic API", description: "Connect an Anthropic API key to use Claude models in web chats." }].filter(item => providers.data!.providers.some(provider => provider.id === item.id)).map(item => <ChoiceCard key={item.id} selected={selected === item.id} className="h-auto items-start justify-start gap-3 whitespace-normal p-4 text-left" onClick={() => setSelected(item.id)}><ProviderIcon providerId={item.id} /><span><span className="block font-medium">{item.title}</span><span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">{item.description}</span></span></ChoiceCard>)}</div>}
    {providers.data && <div className={focused ? "space-y-5" : "grid gap-5 xl:grid-cols-[minmax(12rem,0.7fr)_minmax(0,1.3fr)]"}>
      {focused ? <div className="space-y-3">
        {connectedProviders.length > 0 && <div className="flex flex-wrap items-center gap-2" aria-label="Connected AI providers">{connectedProviders.map(item => <Button key={item.id} variant="ghost" size="sm" aria-pressed={selected === item.id && !addingProvider} className={selected === item.id && !addingProvider ? "bg-muted" : ""} onClick={() => chooseProvider(item.id)}><span className="inline-flex min-w-0 items-center gap-2 leading-5"><ProviderIcon providerId={item.id} className="block size-4" /><span>{item.id === "chatgpt-codex" ? "ChatGPT / Codex" : item.label}</span></span><CheckCircle2 className="size-3.5 text-emerald-500" /></Button>)}<Button variant="ghost" size="sm" onClick={() => { setAddingProvider(true); setSelected(providers.data!.providers.find(item => !item.configured)?.id ?? selected); }}><Plus className="size-4" />Connect another</Button></div>}
        {(addingProvider || connectedProviders.length === 0) && <div className="space-y-3"><Select aria-label="Choose AI provider" value={selected} onValueChange={setSelected} options={[...providers.data.providers].sort((a,b) => (a.id === "chatgpt-codex" ? -1 : b.id === "chatgpt-codex" ? 1 : Number(b.configured)-Number(a.configured))).map(item => ({ value: item.id, label: <span className="flex items-center gap-2"><ProviderIcon providerId={item.id} className="size-4" /><span>{item.id === "chatgpt-codex" ? "ChatGPT / Codex" : item.id === "anthropic" ? "Claude · API key" : item.label}</span></span> }))} />{connectedProviders.length > 0 && <Button variant="ghost" size="sm" onClick={() => chooseProvider(connectedProviders[0].id)}>Cancel</Button>}</div>}
      </div> : <ControlCard title="Providers"><div className="space-y-2">{[...providers.data.providers].sort((a, b) => Number(b.configured) - Number(a.configured)).map(item => <Button variant="ghost" size="sm" key={item.id} type="button" onClick={() => setSelected(item.id)} aria-pressed={selected === item.id} className={`h-auto whitespace-normal justify-start font-normal flex w-full items-center justify-between gap-3  px-3 py-2.5 text-left text-sm     ${selected === item.id ? "bg-muted" : ""}`}><span className="flex min-w-0 items-center gap-3"><ProviderIcon providerId={item.id} /><span className="truncate">{item.label}</span></span>{item.configured && <Badge variant="secondary">Configured</Badge>}</Button>)}</div></ControlCard>}
      {provider && <ControlCard title={focused ? undefined : provider.label}>
        {provider.id === "chatgpt-codex" && (!focused || !provider.configured || !provider.diagnostics.valid) && <div className="space-y-2 text-sm text-muted-foreground"><p>Sign in with ChatGPT to use Codex models.</p><p>Already signed in to Codex on {hostName}? <Button variant="link" size="sm" className="h-auto px-0" disabled={providers.isFetching} onClick={() => void providers.refetch()}>Check existing sign-in</Button></p>{!provider.auth.available && <p>Codex must be installed and runnable on {hostName} to start sign-in here. You can also run <code>codex login --device-auth</code> in that host’s terminal, then check again.</p>}</div>}
        {provider.id === "chatgpt-plan" && <div className="space-y-2 text-sm text-muted-foreground"><p>Sign in directly with ChatGPT for this local 0 application. You choose whether to allow use of your ChatGPT plan.</p><p>Account sign-in, plan permission, and available models are checked separately. This connection uses its own registration and does not import your Codex credentials.</p><p>The sign-in page must open on this computer so its local callback can reach 0.</p></div>}
        {provider.id === "anthropic" && <div className="space-y-2 text-sm text-muted-foreground"><p>Use an Anthropic API key for Claude models.</p><a className="inline-flex items-center gap-1 underline underline-offset-4" href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">Create or manage an Anthropic API key<ExternalLink className="size-3.5" /></a></div>}
        {provider.id === "openai" && <p className="text-sm text-muted-foreground">Connect OpenAI or any OpenAI-compatible provider, including 9Router. Enter the API base URL (including its API version path), any model ID, and the provider’s API key.</p>}
        {provider.id === "cline" && <p className="text-sm text-muted-foreground">Create a key in <a className="underline" href="https://app.cline.bot" target="_blank" rel="noopener noreferrer">Cline Settings → API Keys</a>. Choose a <code>cline-pass/*</code> model for your active ClinePass plan; other model IDs use usage billing. The public catalog does not verify subscription access.</p>}

        {provider.methods.length === 0 && <p role="status" className="text-sm text-muted-foreground">{provider.auth.message}</p>}
        {provider.configured && !provider.diagnostics.valid && <Feedback error={provider.diagnostics.message ?? "This connection needs attention."} />}
        {!focused && provider.accounts.length > 0 && <div className="space-y-3">{provider.accounts.map(account => <div key={account.accountId} className="rounded-[var(--radius-menu,12px)] bg-muted/40 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-medium">{account.label}</p><p className="mt-1 text-xs text-muted-foreground">{account.status === "signed-out" ? "Signed out" : account.status === "reauth-required" ? "Sign-in required" : account.kind === "oauth" ? account.sharing === false ? "Signed in · Plan permission required" : "Signed in" : "API key"} · {account.active ? "Active" : "Inactive"}</p></div><div className="flex gap-2">{provider.id === "chatgpt-plan" && <Button size="sm" variant="outline" disabled={auth.isPending || provider.auth.phase === "running" || !provider.auth.available} onClick={() => auth.mutate({ profileId: account.accountId })}>Sign in again</Button>}{!account.active && account.status !== "signed-out" && account.status !== "reauth-required" && <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "activate", accountId: account.accountId })}>Activate</Button>}<Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => setDisconnect(account.accountId)}>Disconnect</Button></div></div>{disconnect === account.accountId && <div className="mt-3 space-y-2"><p className="text-sm">{provider.id === "chatgpt-plan" ? `Sign out of this ChatGPT connection on ${hostName}? 0 will clear its saved tokens and attempt to revoke this registration’s refresh token.` : <>Remove this account from {hostName}? It stays active with the provider.</>}</p><div className="flex gap-2"><SubmitButton size="sm" variant="destructive" pending={mutation.isPending} onClick={() => mutation.mutate({ action: "disconnect", accountId: account.accountId })}>Remove</SubmitButton><Button size="sm" variant="outline" onClick={() => setDisconnect(null)}>Cancel</Button></div></div>}</div>)}</div>}
        {provider.methods.includes("oauth") && (!focused || !provider.configured || !provider.diagnostics.valid || provider.auth.phase === "running") && <section className="space-y-3 rounded-[var(--radius-panel,16px)] bg-muted/40 p-4"><h3 className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" />{provider.id === "chatgpt-plan" ? "Connect ChatGPT to 0" : provider.id === "chatgpt-codex" ? "Connect your Codex account" : "Sign in"}</h3><p role="status" className="text-sm text-muted-foreground">{provider.auth.message}</p>{provider.auth.userCode && <div><p className="text-xs text-muted-foreground">Your code</p><code className="mt-1 inline-block rounded-[var(--radius-control,8px)] border border-border px-3 py-2 text-lg tracking-widest">{provider.auth.userCode}</code></div>}{authUrl && <Button asChild variant="outline"><a href={authUrl} target="_blank" rel="noopener noreferrer">Open sign-in page<ExternalLink className="size-4" /></a></Button>}{provider.auth.verificationUrl && !authUrl && <Feedback error="This sign-in link looks unsafe, so it wasn't opened." />}<div className="flex flex-wrap gap-2">{provider.auth.phase === "running" ? <SubmitButton pending={auth.isPending} variant="outline" onClick={() => auth.mutate(true)}>Cancel sign-in</SubmitButton> : <SubmitButton pending={auth.isPending} disabled={!provider.auth.available} onClick={() => auth.mutate(false)}>{provider.configured ? "Connect another account" : (provider.id === "chatgpt-plan" || provider.id === "chatgpt-codex") ? "Continue with ChatGPT" : "Sign in"}</SubmitButton>}{provider.auth.phase === "connected" && provider.diagnostics.valid && onConnected && <Button variant="outline" onClick={onConnected}>Continue</Button>}</div></section>}
        {(!focused || provider.id === "azure" || provider.id === "google" || provider.id === "openai") && (supportsEndpoint[provider.id] || provider.id === "google") && <ControlDisclosure key={provider.id} defaultOpen={provider.id === "azure" || provider.id === "google" || provider.id === "openai"} className="pt-2" title={<>{provider.id === "azure" || provider.id === "google" ? "Settings" : "Advanced"}</>}><form className="mt-3 space-y-4" onSubmit={event => { event.preventDefault(); mutation.mutate({ action: "configure" }); }}>
          {supportsEndpoint[provider.id] && <TextField label={provider.id === "azure" ? "Azure endpoint" : "Custom endpoint"} type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} required={provider.id === "azure"} placeholder="https://…" />}
          {(provider.id === "azure" || provider.id === "openai") && <TextField label={provider.id === "azure" ? "Azure model" : "Custom model ID"} value={model} onChange={event => setModel(event.target.value)} required maxLength={256} />}
          {provider.id === "google" && <TextField label="Google Cloud project ID" value={projectId} onChange={event => setProjectId(event.target.value)} required maxLength={64} />}
          <div className="flex flex-wrap gap-2"><SubmitButton type="submit" pending={mutation.isPending}>Save</SubmitButton><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => { setBaseUrl(provider.configuration?.baseUrl ?? ""); setModel(provider.configuration?.model ?? ""); setProjectId(provider.configuration?.projectId ?? ""); mutation.reset(); }}>Cancel</Button></div>
        </form></ControlDisclosure>}
        {provider.methods.includes("api-key") && (!focused || !provider.configured || !provider.diagnostics.valid) && <form className="space-y-4 pt-4" onSubmit={event => { event.preventDefault(); mutation.mutate({ action: "connect" }); }}><TextField label="API key" type="password" value={apiKey} autoComplete="off" spellCheck={false} required disabled={mutation.isPending} onChange={event => setApiKey(event.target.value)} hint={focused ? undefined : `Stored privately on ${hostName}, where this connection runs.`} /><div className="flex gap-2"><SubmitButton type="submit" pending={mutation.isPending} disabled={!apiKey.trim() || (provider.id === "azure" && (!baseUrl.trim() || !model.trim()))}>Connect</SubmitButton><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => { setApiKey(""); mutation.reset(); }}>Clear</Button></div></form>}
        <Feedback error={mutation.error ?? auth.error} message={message} />
      </ControlCard>}
    </div>}
    {!focused && <><ControlCard title="Use Claude Code or another coding agent"><p className="mb-3 text-sm text-muted-foreground">Connect Claude Code, Codex, Cursor, or OpenCode to Zero’s MCP tools from that agent’s own app. This exposes Zero’s tools to the external agent; it does not sign a Claude Code account into web chats or replace the model connection above.</p><AgentOnboarding /></ControlCard>
    <GitHubPublicationControl /></>}
  </div>;
}

export function ModelsControl({ sessionId, onApplied }: { sessionId?: string; onApplied?: (session: SessionSummary) => void }) {
  const { webFetchJson } = useBackendApi();
  const providers = useProviders();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [singleModel, setSingleModel] = useState(false);
  const [autoRoute, setAutoRoute] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const snapshot = useQuery({ queryKey: ["console-control-session", sessionId], enabled: !!sessionId, queryFn: async ({ signal }) => (await webFetchJson<{ snapshot: SessionSnapshot }>(`/api/console/sessions/${encodeURIComponent(sessionId!)}`, { signal })).snapshot, refetchInterval: 2000 });
  const runtime = snapshot.data?.session.runtime ?? snapshot.data?.runtime;
  const initializedSession = useRef<string | null>(null);
  const models = useQuery({ queryKey: ["console-models", "all"], queryFn: ({ signal }) => webFetchJson<ModelsResponse>("/api/console/models", { signal }) });
  useEffect(() => {
    const key = sessionId ?? "new";
    if (initializedSession.current === key || !providers.data || (sessionId && !snapshot.data)) return;
    setProviderId(runtime?.providerId ?? providers.data.preference?.providerId ?? providers.data.providers.find(provider => provider.configured)?.id ?? "");
    setModel(runtime?.model ?? providers.data.preference?.model ?? "");
    setAgentModels(runtime?.agentModels ?? {}); setSingleModel(runtime?.singleModel ?? false); setAutoRoute(runtime?.autoRoute ?? true);
    setMessage(null); initializedSession.current = key;
  }, [providers.data, runtime, sessionId, snapshot.data]);
  const selectedProvider = providers.data?.providers.find(provider => provider.id === providerId);
  const mutation = useMutation({
    scope: { id: `model-settings:${sessionId ?? "new"}` },
    mutationFn: async (selection: RuntimeSelection) => {
      if (!providers.data?.providers.some(provider => provider.id === selection.providerId && provider.configured)) throw new Error("Connect this provider first.");
      if (!selection.model?.trim()) throw new Error("Choose a model.");
      const owner = sessionId ?? (await webFetchJson<{ session: SessionSummary }>("/api/console/sessions", jsonBody({}))).session.id;
      const data = await webFetchJson<{ session: SessionSummary }>(`/api/console/sessions/${encodeURIComponent(owner)}/configuration`, { method: "PATCH", body: JSON.stringify({ runtime: selection }) });
      return data.session;
    },
    onSuccess: async session => {
      setMessage(session.pendingConfiguration ? "Saved. Takes effect after the current step." : "Saved.");
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["console-control-session"] }), queryClient.invalidateQueries({ queryKey: ["console-sessions"] }), providers.refetch()]);
      if (onApplied) onApplied(session);
      else if (!sessionId) navigate(`/models?session=${encodeURIComponent(session.id)}&return=${encodeURIComponent(`/console/${session.id}`)}`, { replace: true });
    },
  });
  const currentSelection = (): RuntimeSelection => ({ providerId, model: model.trim(), agentModels, singleModel, autoRoute });
  const changeSelection = (change: RuntimeSelection) => {
    const next = { ...currentSelection(), ...change };
    if (change.providerId !== undefined) setProviderId(change.providerId);
    if (change.model !== undefined) setModel(change.model);
    if (change.agentModels !== undefined) setAgentModels(change.agentModels);
    if (change.singleModel !== undefined) setSingleModel(change.singleModel);
    if (change.autoRoute !== undefined) setAutoRoute(change.autoRoute);
    mutation.reset(); setMessage(null);
    if (sessionId && next.model?.trim() && providers.data?.providers.some(provider => provider.id === next.providerId && provider.configured)) mutation.mutate(next);
  };
  const availableModels = (models.data?.models ?? []).filter(item => providers.data?.providers.some(provider => provider.id === item.provider && provider.configured));
  return <ControlCard title="Model">
    <QueryState pending={providers.isPending} error={providers.error ?? snapshot.error} retry={() => { void providers.refetch(); void snapshot.refetch(); }} />
    {runtime && <div className="flex items-center gap-2 text-sm"><ProviderIcon providerId={runtime.providerId} /><span>{runtime.providerLabel}</span><span className="text-muted-foreground">· {runtime.model}</span>{!!(snapshot.data?.session.pendingConfiguration || snapshot.data?.pendingConfiguration) && <span className="text-muted-foreground">· change pending</span>}</div>}
    {providers.data && !providers.data.providers.some(provider => provider.configured) && <Empty>No provider connected. <Link to="/connections" className="underline">Connect one</Link> first.</Empty>}
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (!sessionId) mutation.mutate(currentSelection()); }}>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="Provider"><Select aria-label="Provider" disabled={mutation.isPending} value={providerId} onValueChange={value => { const configuredModel = providers.data?.providers.find(provider => provider.id === value)?.configuration?.model ?? ""; changeSelection({ providerId: value, model: configuredModel, agentModels: {} }); }} options={[{ value: "", label: "Choose a provider" }, ...(providers.data?.providers.map(provider => ({ value: provider.id, label: <span className="flex items-center gap-2"><ProviderIcon providerId={provider.id} /><span>{provider.label}{!provider.configured ? " — not connected" : ""}</span></span>, disabled: !provider.configured })) ?? [])]} /></Field><Field label="Model"><ModelPicker label="Choose model" models={availableModels} providers={providers.data?.providers} selected={{ providerId, model }} disabled={mutation.isPending} onSelect={item => changeSelection({ providerId: item.provider, model: item.id, agentModels: item.provider === providerId ? agentModels : {} })} pending={models.isPending} diagnostics={models.data?.diagnostics} /></Field></div>
      {providerId === "openai" && <TextField label="Custom model ID" value={model} disabled={mutation.isPending} onChange={event => { setModel(event.target.value); setMessage(null); }} onBlur={() => { if (sessionId && model.trim() && model.trim() !== runtime?.model) changeSelection({ model: model.trim() }); }} onKeyDown={event => { if (sessionId && event.key === "Enter") { event.preventDefault(); if (model.trim()) changeSelection({ model: model.trim() }); } }} maxLength={256} hint="Enter a model ID supported by your OpenAI-compatible endpoint. For an existing chat, saves when you leave the field or press Enter." />}
      <QueryState pending={!!providerId && models.isPending} error={models.error} retry={models.refetch} label="Loading models…" />
      {models.data?.diagnostics.map(item => <p key={item.providerId} className="text-xs text-muted-foreground">{providers.data?.providers.find(provider => provider.id === item.providerId)?.label ?? item.providerId}: {item.message}</p>)}
      <ControlDisclosure title={<>Advanced</>}><div className="mt-3 space-y-4">
      <label className="flex items-center justify-between gap-4 text-sm"><span>Use one model for everything</span><Switch aria-label="Use one model for everything" checked={singleModel} disabled={mutation.isPending || !model} onCheckedChange={value => changeSelection({ singleModel: value })} /></label>
      <label className="flex items-center justify-between gap-4 text-sm"><span>Pick models per task automatically</span><Switch aria-label="Pick models per task automatically" checked={autoRoute} onCheckedChange={value => changeSelection({ autoRoute: value })} disabled={singleModel || mutation.isPending || !model} /></label>
      {!singleModel && <div className="grid gap-4 sm:grid-cols-2">{models.data?.roles.map(role => <Field key={role} label={`${role[0]?.toUpperCase()}${role.slice(1)} model`}><Select aria-label={`${role} model`} value={agentModels[role] ?? "auto"} disabled={mutation.isPending || !model} onValueChange={value => changeSelection({ agentModels: { ...agentModels, [role]: value } })} options={[{ value: "auto", label: "Auto" }, ...availableModels.filter(item => item.provider === providerId).map(item => ({ value: item.id, label: <span className="flex min-w-0 items-center gap-2"><ModelIcon modelId={item.id} providerId={item.provider} /><span className="truncate">{item.id}</span></span> }))]} /></Field>)}</div>}
      </div></ControlDisclosure>
      <Feedback error={mutation.error} />
      {sessionId ? (mutation.isPending || message ? <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{mutation.isPending ? "Saving…" : message}</p> : null) : <div className="flex flex-wrap gap-2"><SubmitButton type="submit" pending={mutation.isPending} disabled={!selectedProvider?.configured || !model.trim()}>Start</SubmitButton><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => { setProviderId(runtime?.providerId ?? providers.data?.preference?.providerId ?? ""); setModel(runtime?.model ?? providers.data?.preference?.model ?? ""); setAgentModels(runtime?.agentModels ?? {}); setSingleModel(runtime?.singleModel ?? false); setAutoRoute(runtime?.autoRoute ?? true); mutation.reset(); setMessage(null); }}>Reset</Button></div>}
    </form>
  </ControlCard>;
}
