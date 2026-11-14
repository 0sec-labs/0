import { queryKeys } from "@/queries";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { CapyArrowLeftIcon as ArrowLeft, CapyArrowUpRightIcon as ExternalLink, CapySearchIcon as Search } from "@/ui/icons/capy";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ProviderIcon } from "@/components/provider-icon";
import { Feedback, SubmitButton, TextField, jsonBody } from "./control-ui";
import { LogoTile } from "@/ui/components/logo-tile";
import { newAccountId } from "./connection-model";
import { Switch } from "@/components/ui/switch";
import type { AuthStatus, Provider, ProvidersResponse } from "./contracts";

const officialAuthHosts: Record<string, readonly string[]> = {
  "chatgpt-plan": ["auth.openai.com"], "chatgpt-codex": ["auth.openai.com"], codex: ["auth.openai.com"],
  xai: ["auth.x.ai"], kimi: ["auth.kimi.com"], openrouter: ["openrouter.ai"],
};
const supportsEndpoint: Record<string, true> = { deepseek: true, anthropic: true, azure: true, openai: true, "z-ai": true, kimi: true, qwen: true, xai: true, opencode: true, together: true };
const providerHost: Record<string, string> = {
  "chatgpt-codex": "chatgpt.com", "chatgpt-plan": "chatgpt.com", anthropic: "api.anthropic.com", openai: "api.openai.com",
  openrouter: "openrouter.ai", xai: "api.x.ai", deepseek: "api.deepseek.com", kimi: "api.kimi.ai", "z-ai": "api.z.ai",
  together: "api.together.xyz", opencode: "opencode.ai"
};
const keyLinks: Record<string, { href: string; label: string }> = {
  anthropic: { href: "https://platform.claude.com/settings/keys", label: "Create or manage an Anthropic API key" },
  together: { href: "https://api.together.ai/settings/api-keys", label: "Create or manage a Together AI API key" },
};

export function providerTitle(provider: Pick<Provider, "id" | "label">): string {
  return provider.id === "chatgpt-codex" ? "Codex" : provider.id === "chatgpt-plan" ? "ChatGPT plan" : provider.label;
}
export function providerSubtitle(provider: Provider): string {
  const host = provider.configuration?.baseUrl ? safeHost(provider.configuration.baseUrl) : providerHost[provider.id];
  return host ?? (provider.methods.includes("oauth") ? "Subscription sign-in" : "API key");
}
function safeHost(raw: string): string | undefined { try { return new URL(raw).host; } catch { return undefined; } }
export function officialAuthUrl(providerId: string, raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && officialAuthHosts[providerId]?.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}
const isConnected = (provider: Provider) => provider.configured && provider.diagnostics.valid;

/** Capy-style "Add a connection" sheet: searchable provider grid, then that provider's sign-in or API key form. */
export function ConnectionSheet({ open, onOpenChange, providers, initialProviderId, hostName, onConnected }: { open: boolean; onOpenChange: (open: boolean) => void; providers: Provider[]; initialProviderId?: string | null; hostName: string; onConnected?: (providerId: string) => void }) {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [another, setAnother] = useState(false);
  const [accountLabel, setAccountLabel] = useState("");
  const picked = providers.find(item => item.id === pickedId);
  const startedConnected = useRef(false);

  useEffect(() => { if (open) { setPickedId(initialProviderId ?? null); setQuery(""); } }, [open, initialProviderId]);
  useEffect(() => {
    setApiKey(""); setAnother(false); setAccountLabel(""); setBaseUrl(picked?.configuration?.baseUrl ?? ""); setModel(picked?.configuration?.model ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedId, picked?.connectionIdentity]);
  // Remember whether the provider was already connected when it was chosen, so only a new sign-in auto-closes.
  useEffect(() => {
    startedConnected.current = picked ? isConnected(picked) : false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedId, open]);
  // Browser sign-in finishes on the server: close once this provider turns connected.
  useEffect(() => {
    if (!open || !picked || startedConnected.current || !isConnected(picked)) return;
    onConnected?.(picked.id); onOpenChange(false);
  }, [open, picked, onConnected, onOpenChange]);

  const save = useMutation({
    mutationFn: async (provider: Provider) => {
      const key = apiKey.trim();
      if (baseUrl.trim()) {
        const url = new URL(baseUrl.trim());
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && (provider.id === "openai" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))) throw new Error("Enter a plain https:// URL (custom OpenAI-compatible providers also support http://).");
      }
      const post = (body: Record<string, unknown>) => webFetchJson<ProvidersResponse & { message?: string }>("/api/console/connections", jsonBody({ providerId: provider.id, ...body }));
      const config = { ...(supportsEndpoint[provider.id] && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...((provider.id === "azure" || provider.id === "openai") && model.trim() ? { model: model.trim() } : {}) };
      let data: (ProvidersResponse & { message?: string }) | undefined;
      if (key && another && provider.configured) {
        const label = accountLabel.trim();
        if (!label) throw new Error("Give this account a name so you can tell it apart.");
        const accountId = newAccountId(label, provider.accounts.map(account => account.accountId));
        data = await post({ action: "connect", apiKey: key, accountId, ...config });
        // The label is display-only; the account id above is already readable if this fails.
        try { await webFetchJson(`/api/console/connections/${encodeURIComponent(`${provider.id}:${accountId}`)}`, { method: "PATCH", body: JSON.stringify({ label }) }); } catch { /* keep the connected account */ }
        void queryClient.invalidateQueries({ queryKey: queryKeys.consoleConnections() });
      } else if (key) data = await post({ action: "connect", apiKey: key, ...config });
      else if (provider.configured && Object.keys(config).length) data = await post({ action: "configure", ...config });
      if (!data) throw new Error("Enter an API key.");
      return data;
    },
    onSuccess: async (data, provider) => {
      queryClient.setQueryData(queryKeys.consoleProviders(), data);
      await queryClient.invalidateQueries({ queryKey: queryKeys.consoleModels() });
      onConnected?.(provider.id); onOpenChange(false);
    },
    onSettled: () => setApiKey(""),
  });
  const auth = useMutation({
    mutationFn: ({ providerId, input }: { providerId: string; input: "start" | "cancel" | { profileId: string } }) => webFetchJson<{ status: AuthStatus }>(`/api/console/providers/${encodeURIComponent(providerId)}/device-auth`, { method: input === "cancel" ? "DELETE" : "POST", body: JSON.stringify(typeof input === "object" ? input : {}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.consoleProviders() }),
  });
  const back = () => { save.reset(); auth.reset(); setPickedId(null); };
  const close = (next: boolean) => { if (!next) { save.reset(); auth.reset(); } onOpenChange(next); };

  const needle = query.trim().toLowerCase();
  const matches = providers.filter(item => !needle || `${providerTitle(item)} ${item.id} ${providerSubtitle(item)}`.toLowerCase().includes(needle));
  const subscriptions = matches.filter(item => item.methods.includes("oauth")).sort((a, b) => (a.id === "chatgpt-codex" ? -1 : b.id === "chatgpt-codex" ? 1 : 0));
  const apiKeys = matches.filter(item => !item.methods.includes("oauth"));
  const authUrl = picked ? officialAuthUrl(picked.id, picked.auth.verificationUrl) : null;
  const link = picked ? keyLinks[picked.id] : undefined;

  const tile = (item: Provider) => <button key={item.id} type="button" onClick={() => setPickedId(item.id)} className="flex min-w-0 items-center gap-3 rounded-(--radius-card) border-[0.5px] border-(--card-hairline) bg-card p-3 text-left outline-none transition-colors duration-100 hover:bg-secondary focus-visible:outline-ring-inset focus-visible:outline-2">
    <LogoTile className="size-9"><ProviderIcon providerId={item.id} className="size-5" /></LogoTile>
    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-foreground">{providerTitle(item)}</span><span className="block truncate text-xs text-muted-foreground-2">{providerSubtitle(item)}</span></span>
    {isConnected(item) ? <span className="shrink-0 text-xs text-muted-foreground-1">{item.methods.includes("oauth") ? "Add another" : "Connected"}</span> : <ChevronRight aria-hidden="true" className="size-(--icon-sm) shrink-0 text-muted-foreground-2" />}
  </button>;
  const group = (title: string, items: Provider[]) => items.length > 0 && <section className="flex flex-col gap-3"><h3 className="text-sm font-medium text-foreground">{title}</h3><div className="grid gap-2 sm:grid-cols-2">{items.map(tile)}</div></section>;

  return <Sheet open={open} onOpenChange={close}>
    <SheetContent className="w-full data-[side=right]:sm:max-w-[640px]">
      {!picked ? <>
        <SheetHeader><SheetTitle>Add a connection</SheetTitle><SheetDescription className="sr-only">Choose a subscription or API key provider to connect on {hostName}.</SheetDescription></SheetHeader>
        <div className="flex flex-col gap-6 px-6 pb-6">
          <div className="relative"><Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground-2" /><Input type="search" aria-label="Search providers" placeholder="Search providers" autoComplete="off" data-1p-ignore value={query} onChange={event => setQuery(event.target.value)} className="pl-9" /></div>
          {group("Subscriptions", subscriptions)}
          {group("API keys", apiKeys)}
          {matches.length === 0 && <p className="text-sm text-muted-foreground-2">No providers match your search.</p>}
        </div>
      </> : <>
        <SheetHeader className="flex-row items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label="Back to providers" onClick={back}><ArrowLeft /></Button>
          <ProviderIcon providerId={picked.id} className="size-5" />
          <SheetTitle>{isConnected(picked) ? "Reconnect" : "Connect"} {providerTitle(picked)}</SheetTitle>
          <SheetDescription className="sr-only">Connection on {hostName}.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-6 pb-6">
          {picked.configured && !picked.diagnostics.valid && <Feedback error={picked.diagnostics.message ?? "This connection needs attention."} />}
          {picked.methods.includes("oauth") && <section className="flex flex-col gap-4 rounded-(--radius-card) border-[0.5px] border-(--card-hairline) bg-card p-4">
            <h3 className="flex items-center gap-2 text-sm font-medium"><ShieldCheck aria-hidden="true" className="size-4" />{picked.id === "chatgpt-codex" ? "Sign in with ChatGPT" : "Sign in"}</h3>
            <p role="status" className="text-sm text-muted-foreground-1">{picked.auth.message}</p>
            {picked.id === "chatgpt-plan" && <p className="text-sm text-muted-foreground-2">You choose whether to allow your ChatGPT plan. This connection uses its own registration and never imports Codex credentials. The sign-in page must open on this computer.</p>}
            {picked.id === "chatgpt-codex" && !picked.auth.available && <p className="text-sm text-muted-foreground-2">Codex must be installed on {hostName} to sign in from here. You can also run <code>codex login --device-auth</code> in that host's terminal, then check again.</p>}
            {picked.auth.userCode && <div><p className="text-xs text-muted-foreground-2">Your code</p><code className="mt-1 inline-block rounded-md border-[0.5px] border-border-2 px-3 py-2 text-lg tracking-widest">{picked.auth.userCode}</code></div>}
            {authUrl && <Button variant="outline" className="self-start" render={<a href={authUrl} target="_blank" rel="noopener noreferrer" />}>Open sign-in page<ExternalLink /></Button>}
            {picked.auth.verificationUrl && !authUrl && <Feedback error="This sign-in link looks unsafe, so it wasn't opened." />}
            <div className="flex flex-wrap gap-2">
              {picked.auth.phase === "running"
                ? <SubmitButton variant="outline" pending={auth.isPending} onClick={() => auth.mutate({ providerId: picked.id, input: "cancel" })}>Cancel sign-in</SubmitButton>
                : <SubmitButton pending={auth.isPending} disabled={!picked.auth.available} onClick={() => auth.mutate({ providerId: picked.id, input: "start" })}>{picked.id === "chatgpt-plan" || picked.id === "chatgpt-codex" ? "Continue with ChatGPT" : "Sign in"}</SubmitButton>}
              {picked.id === "chatgpt-codex" && <Button variant="ghost" onClick={() => void queryClient.invalidateQueries({ queryKey: queryKeys.consoleProviders() })}>Check existing sign-in</Button>}
            </div>
            {picked.id === "chatgpt-plan" && picked.accounts.some(account => account.status === "reauth-required") && <Feedback error="Sign-in required again for an existing ChatGPT connection." />}
          </section>}
          {picked.methods.includes("api-key") && <form id="connection-sheet-form" className="flex flex-col gap-4 rounded-(--radius-card) border-[0.5px] border-(--card-hairline) bg-card p-4" onSubmit={event => { event.preventDefault(); save.mutate(picked); }}>
            <h3 className="text-sm font-medium">Endpoint</h3>
            {supportsEndpoint[picked.id] && <TextField label={picked.id === "azure" ? "Azure endpoint" : "Base URL"} type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} required={picked.id === "azure"} placeholder={providerHost[picked.id] ? `https://${providerHost[picked.id]}` : "https://…"}  />}
            {(picked.id === "azure" || picked.id === "openai") && <TextField label={picked.id === "azure" ? "Azure model" : "Model (optional)"} value={model} onChange={event => setModel(event.target.value)} required={picked.id === "azure"} maxLength={256}  />}
            {picked.configured && picked.id !== "azure" && <div className="flex items-center justify-between gap-4 text-sm"><label htmlFor="connection-another-account" className="min-w-0"><span className="block font-medium">Add another account</span><span className="block text-xs text-muted-foreground-2">Keep the saved key and add a second {providerTitle(picked)} key. Without this, a new key replaces the current one.</span></label><Switch id="connection-another-account" aria-label="Add another account" checked={another} disabled={save.isPending} onCheckedChange={setAnother} /></div>}
            {another && picked.configured && <TextField label="Account name" value={accountLabel} maxLength={80} disabled={save.isPending} onChange={event => setAccountLabel(event.target.value)} placeholder="Work key" required />}
            <TextField label="API key" type="password" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" value={apiKey} disabled={save.isPending} onChange={event => setApiKey(event.target.value)} placeholder={picked.configured ? "Saved. Leave blank to keep" : undefined} required={!picked.configured || another} hint={`Stored privately on ${hostName}, where this connection runs.`} />
          </form>}
          {picked.methods.length === 0 && <p role="status" className="text-sm text-muted-foreground-1">{picked.auth.message}</p>}
          <Feedback error={save.error ?? auth.error} />
        </div>
        <SheetFooter className="mt-auto flex-row items-center justify-between border-t-[0.5px] border-border-1 py-4">
          {link ? <Button variant="link" className="px-0" render={<a href={link.href} target="_blank" rel="noopener noreferrer" />}>{link.label}<ExternalLink /></Button> : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" disabled={save.isPending} onClick={() => close(false)}>Cancel</Button>
            {picked.methods.includes("api-key") && <SubmitButton type="submit" form="connection-sheet-form" pending={save.isPending} disabled={(!picked.configured && !apiKey.trim()) || (another && (!apiKey.trim() || !accountLabel.trim())) || (picked.id === "azure" && (!baseUrl.trim() || !model.trim()))}>{another ? "Add account" : isConnected(picked) ? "Save" : "Connect"}</SubmitButton>}
          </div>
        </SheetFooter>
      </>}
    </SheetContent>
  </Sheet>;
}
