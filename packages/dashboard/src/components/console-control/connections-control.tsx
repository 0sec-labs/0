import { ControlDisclosure } from "./control-disclosure";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ProviderIcon } from "@/components/provider-icon";
import { ControlCard, Empty, Feedback, Field, QueryState, SubmitButton, TextField, jsonBody } from "./control-ui";
import type { AuthStatus, ModelsResponse, ProvidersResponse, RuntimeSelection, SessionSnapshot, SessionSummary } from "./contracts";
import { GitHubPublicationControl } from "./github-publication-control";

const officialAuthHosts: Record<string, readonly string[]> = {
  "chatgpt-codex": ["auth.openai.com"], codex: ["auth.openai.com"], copilot: ["github.com"],
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

export function ConnectionsControl({ onConnected }: { onConnected?: () => void }) {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const providers = useProviders();
  const [selected, setSelected] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [projectId, setProjectId] = useState("");
  const [disconnect, setDisconnect] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const provider = providers.data?.providers.find(item => item.id === selected);
  const authUrl = provider ? officialAuthUrl(provider.id, provider.auth.verificationUrl) : null;

  useEffect(() => { if (!selected && providers.data) setSelected(providers.data.preference?.providerId ?? providers.data.providers.find(item => item.configured)?.id ?? providers.data.providers[0]?.id ?? ""); }, [providers.data, selected]);
  useEffect(() => { setApiKey(""); setBaseUrl(provider?.configuration?.baseUrl ?? ""); setModel(provider?.configuration?.model ?? ""); setProjectId(provider?.configuration?.projectId ?? ""); setDisconnect(null); setMessage(null); }, [selected]);

  const mutation = useMutation({
    mutationFn: async (input: { action: "connect" | "activate" | "disconnect" | "configure"; accountId?: string }) => {
      if (!provider) throw new Error("Choose a provider first.");
      if (input.action === "connect" && !apiKey.trim()) throw new Error("Enter an API key.");
      if (baseUrl.trim()) {
        const url = new URL(baseUrl.trim());
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Enter a plain https:// URL (or http://localhost).");
      }
      return webFetchJson<ProvidersResponse>("/api/console/connections", jsonBody({ providerId: provider.id, ...input, ...(input.action === "connect" ? { apiKey: apiKey.trim() } : {}), ...(["connect", "configure"].includes(input.action) ? { ...(supportsEndpoint[provider.id] && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(provider.id === "azure" && model.trim() ? { model: model.trim() } : {}), ...(input.action === "configure" && provider.id === "google" && projectId.trim() ? { projectId: projectId.trim() } : {}) } : {}) }));
    },
    onSuccess: async (data, input) => {
      queryClient.setQueryData(["console-providers"], data);
      setApiKey(""); setDisconnect(null);
      setMessage(input.action === "connect" ? "Connected. Now choose a model." : input.action === "configure" ? "Saved." : input.action === "activate" ? "Account activated." : "Account removed.");
      await queryClient.invalidateQueries({ queryKey: ["console-models"] });
      if (input.action === "connect") onConnected?.();
    },
    onSettled: () => { setApiKey(""); },
  });
  const auth = useMutation({
    mutationFn: (cancel: boolean) => webFetchJson<{ status: AuthStatus }>(`/api/console/providers/${encodeURIComponent(selected)}/device-auth`, { method: cancel ? "DELETE" : "POST", body: "{}" }),
    onSuccess: async () => { await providers.refetch(); },
  });

  return <div className="space-y-5">
    <QueryState pending={providers.isPending} error={providers.error} retry={providers.refetch} />
    {providers.data && <div className="grid gap-5 xl:grid-cols-[minmax(12rem,0.7fr)_minmax(0,1.3fr)]">
      <ControlCard title="Providers"><div className="space-y-2">{[...providers.data.providers].sort((a, b) => Number(b.configured) - Number(a.configured)).map(item => <button key={item.id} type="button" onClick={() => setSelected(item.id)} aria-pressed={selected === item.id} className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${selected === item.id ? "bg-muted" : "hover:bg-muted/60"}`}><span className="flex min-w-0 items-center gap-3"><ProviderIcon providerId={item.id} /><span className="truncate">{item.label}</span></span>{item.configured && <Badge variant="secondary">Connected</Badge>}</button>)}</div></ControlCard>
      {provider && <ControlCard title={provider.label}>
        {provider.id === "cline" && <p className="text-sm text-muted-foreground">Create a key in <a className="underline" href="https://app.cline.bot" target="_blank" rel="noopener noreferrer">Cline Settings → API Keys</a>. Choose a <code>cline-pass/*</code> model for your active ClinePass plan; other model IDs use usage billing. The public catalog does not verify subscription access.</p>}
        {provider.configured && !provider.diagnostics.valid && <Feedback error={provider.diagnostics.message ?? "This connection needs attention."} />}
        {provider.accounts.length > 0 && <div className="space-y-3">{provider.accounts.map(account => <div key={account.accountId} className="rounded-xl bg-muted/40 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-medium">{account.label}</p><p className="mt-1 text-xs text-muted-foreground">{account.kind === "oauth" ? "Signed in" : "API key"} · {account.active ? "Active" : "Inactive"}</p></div><div className="flex gap-2">{!account.active && <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "activate", accountId: account.accountId })}>Activate</Button>}<Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => setDisconnect(account.accountId)}>Disconnect</Button></div></div>{disconnect === account.accountId && <div className="mt-3 space-y-2"><p className="text-sm">Remove this account from this computer? It stays active with the provider.</p><div className="flex gap-2"><SubmitButton size="sm" variant="destructive" pending={mutation.isPending} onClick={() => mutation.mutate({ action: "disconnect", accountId: account.accountId })}>Remove</SubmitButton><Button size="sm" variant="outline" onClick={() => setDisconnect(null)}>Cancel</Button></div></div>}</div>)}</div>}
        {provider.methods.includes("oauth") && <section className="space-y-3 rounded-2xl bg-muted/40 p-4"><h3 className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" />Sign in</h3><p role="status" className="text-sm text-muted-foreground">{provider.auth.message}</p>{provider.auth.userCode && <div><p className="text-xs text-muted-foreground">Your code</p><code className="mt-1 inline-block rounded border border-border px-3 py-2 text-lg tracking-widest">{provider.auth.userCode}</code></div>}{authUrl && <Button asChild variant="outline"><a href={authUrl} target="_blank" rel="noopener noreferrer">Open sign-in page<ExternalLink className="size-4" /></a></Button>}{provider.auth.verificationUrl && !authUrl && <Feedback error="This sign-in link looks unsafe, so it wasn't opened." />}<div className="flex flex-wrap gap-2">{provider.auth.phase === "running" ? <SubmitButton pending={auth.isPending} variant="outline" onClick={() => auth.mutate(true)}>Cancel sign-in</SubmitButton> : <SubmitButton pending={auth.isPending} disabled={!provider.auth.available} onClick={() => auth.mutate(false)}>{provider.configured ? "Connect another account" : "Sign in"}</SubmitButton>}{provider.auth.phase === "connected" && onConnected && <Button variant="outline" onClick={onConnected}>Continue</Button>}</div></section>}
        {(supportsEndpoint[provider.id] || provider.id === "google") && <ControlDisclosure key={provider.id} open={provider.id === "azure" || provider.id === "google" || undefined} className="pt-2" title={<>{provider.id === "azure" || provider.id === "google" ? "Settings" : "Advanced"}</>}><form className="mt-3 space-y-4" onSubmit={event => { event.preventDefault(); mutation.mutate({ action: "configure" }); }}>
          {supportsEndpoint[provider.id] && <TextField label={provider.id === "azure" ? "Azure endpoint" : "Custom endpoint"} type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} required={provider.id === "azure"} placeholder="https://…" />}
          {provider.id === "azure" && <TextField label="Azure model" value={model} onChange={event => setModel(event.target.value)} required maxLength={256} />}
          {provider.id === "google" && <TextField label="Google Cloud project ID" value={projectId} onChange={event => setProjectId(event.target.value)} required maxLength={64} />}
          <div className="flex flex-wrap gap-2"><SubmitButton type="submit" pending={mutation.isPending}>Save</SubmitButton><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => { setBaseUrl(provider.configuration?.baseUrl ?? ""); setModel(provider.configuration?.model ?? ""); setProjectId(provider.configuration?.projectId ?? ""); mutation.reset(); }}>Cancel</Button></div>
        </form></ControlDisclosure>}
        {provider.methods.includes("api-key") && <form className="space-y-4 pt-4" onSubmit={event => { event.preventDefault(); mutation.mutate({ action: "connect" }); }}><TextField label="API key" type="password" value={apiKey} autoComplete="off" spellCheck={false} required disabled={mutation.isPending} onChange={event => setApiKey(event.target.value)} hint="Stored locally on this computer." /><div className="flex gap-2"><SubmitButton type="submit" pending={mutation.isPending} disabled={!apiKey.trim() || (provider.id === "azure" && (!baseUrl.trim() || !model.trim()))}>Connect</SubmitButton><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => { setApiKey(""); mutation.reset(); }}>Clear</Button></div></form>}
        <Feedback error={mutation.error ?? auth.error} message={message} />
      </ControlCard>}
    </div>}
    <GitHubPublicationControl />
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
  const models = useQuery({ queryKey: ["console-models", providerId], enabled: !!providerId, queryFn: ({ signal }) => webFetchJson<ModelsResponse>(`/api/console/models?providerId=${encodeURIComponent(providerId)}`, { signal }) });
  useEffect(() => { if (!providerId && providers.data && (!sessionId || snapshot.data)) { setProviderId(runtime?.providerId ?? providers.data.preference?.providerId ?? providers.data.providers.find(provider => provider.configured)?.id ?? ""); setModel(runtime?.model ?? providers.data.preference?.model ?? ""); setAgentModels(runtime?.agentModels ?? {}); setSingleModel(runtime?.singleModel ?? false); setAutoRoute(runtime?.autoRoute ?? true); } }, [providers.data, runtime, providerId, sessionId, snapshot.data]);
  const selectedProvider = providers.data?.providers.find(provider => provider.id === providerId);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!selectedProvider?.configured) throw new Error("Connect this provider first.");
      if (!model.trim()) throw new Error("Choose a model.");
      const selection: RuntimeSelection = { providerId, model, agentModels, singleModel, autoRoute };
      const owner = sessionId ?? (await webFetchJson<{ session: SessionSummary }>("/api/console/sessions", jsonBody({}))).session.id;
      const data = await webFetchJson<{ session: SessionSummary }>(`/api/console/sessions/${encodeURIComponent(owner)}/configuration`, { method: "PATCH", body: JSON.stringify({ runtime: selection }) });
      return data.session;
    },
    onSuccess: async session => {
      setMessage(session.pendingConfiguration ? "Saved. Takes effect after the current step." : "Model updated.");
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["console-control-session"] }), queryClient.invalidateQueries({ queryKey: ["console-sessions"] }), providers.refetch()]);
      if (onApplied) onApplied(session);
      else if (!sessionId) navigate(`/models?session=${encodeURIComponent(session.id)}&return=${encodeURIComponent(`/console/${session.id}`)}`, { replace: true });
    },
  });
  return <ControlCard title="Model">
    <QueryState pending={providers.isPending} error={providers.error ?? snapshot.error} retry={() => { void providers.refetch(); void snapshot.refetch(); }} />
    {runtime && <div className="flex items-center gap-2 text-sm"><ProviderIcon providerId={runtime.providerId} /><span>{runtime.providerLabel}</span><span className="text-muted-foreground">· {runtime.model}</span>{!!(snapshot.data?.session.pendingConfiguration || snapshot.data?.pendingConfiguration) && <span className="text-muted-foreground">· change pending</span>}</div>}
    {providers.data && !providers.data.providers.some(provider => provider.configured) && <Empty>No provider connected. <Link to="/connections" className="underline">Connect one</Link> first.</Empty>}
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); mutation.mutate(); }}>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="Provider"><Select aria-label="Provider" value={providerId} onValueChange={value => { setProviderId(value); setModel(""); setAgentModels({}); mutation.reset(); }} options={[{ value: "", label: "Choose a provider" }, ...(providers.data?.providers.map(provider => ({ value: provider.id, label: `${provider.label}${!provider.configured ? " — not connected" : ""}`, disabled: !provider.configured })) ?? [])]} /></Field><Field label="Model"><Select aria-label="Model" value={model} onValueChange={setModel} disabled={models.isPending || !providerId} required options={[{ value: "", label: "Choose a model" }, ...(models.data?.models.map(item => ({ value: item.id, label: `${item.id} · ${item.price}` })) ?? [])]} /></Field></div>
      <QueryState pending={!!providerId && models.isPending} error={models.error} retry={models.refetch} />
      {models.data?.diagnostics.map(item => <p key={item.providerId} className="text-xs text-muted-foreground">{item.message}</p>)}
      <ControlDisclosure title={<>Advanced</>}><div className="mt-3 space-y-4">
      <label className="flex items-center justify-between gap-4 text-sm"><span>Use one model for everything</span><Switch aria-label="Use one model for everything" checked={singleModel} onCheckedChange={setSingleModel} /></label>
      <label className="flex items-center justify-between gap-4 text-sm"><span>Pick models per task automatically</span><Switch aria-label="Pick models per task automatically" checked={autoRoute} onCheckedChange={setAutoRoute} disabled={singleModel} /></label>
      {!singleModel && <div className="grid gap-4 sm:grid-cols-2">{models.data?.roles.map(role => <Field key={role} label={`${role[0]?.toUpperCase()}${role.slice(1)} model`}><Select aria-label={`${role} model`} value={agentModels[role] ?? "auto"} onValueChange={value => setAgentModels(current => ({ ...current, [role]: value }))} options={[{ value: "auto", label: "Auto" }, ...models.data.models.map(item => ({ value: item.id, label: item.id }))]} /></Field>)}</div>}
      </div></ControlDisclosure>
      <Feedback error={mutation.error} message={message} />
      <div className="flex flex-wrap gap-2"><SubmitButton type="submit" pending={mutation.isPending} disabled={!selectedProvider?.configured || !model}>{sessionId ? "Save" : "Start"}</SubmitButton><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => { setProviderId(runtime?.providerId ?? providers.data?.preference?.providerId ?? ""); setModel(runtime?.model ?? providers.data?.preference?.model ?? ""); setAgentModels(runtime?.agentModels ?? {}); setSingleModel(runtime?.singleModel ?? false); setAutoRoute(runtime?.autoRoute ?? true); mutation.reset(); setMessage(null); }}>Reset</Button></div>
    </form>
  </ControlCard>;
}
