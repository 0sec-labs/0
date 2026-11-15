import { queryKeys } from "@/queries";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CapyArrowUpRightIcon as ExternalLink, CapyBranchIcon as GitBranch } from "@/ui/icons/capy";
import { useBackendApi } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ControlCard, Feedback, QueryState, SubmitButton, TextField, jsonBody } from "./control-ui";
import {
  GITHUB_INSTALL_COMMAND, GITHUB_INSTALL_URL, defaultGitHubMethod, deviceStatusText, formatExpiry, githubCardKind, githubHeadline, githubMethods, guidedTokenUrl, safeDeviceUrl, validToken,
  type GitHubMethod, type GitHubPublicationAccount,
} from "./github-connection-model";

export type { GitHubPublicationAccount } from "./github-connection-model";
interface GitHubAccountResponse { github: GitHubPublicationAccount }
type Action = "connect" | "sign-in" | "refresh" | "cancel" | "disconnect";

export function useGitHubPublicationAccount() {
  const { webFetchJson } = useBackendApi();
  return useQuery({
    queryKey: queryKeys.consoleGithubPublication(),
    queryFn: async ({ signal }) => (await webFetchJson<GitHubAccountResponse>("/api/console/github", { signal })).github,
    refetchInterval: query => query.state.data?.deviceAuth.phase === "running" ? 1000 : false,
  });
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <Button type="button" variant="outline" aria-label={label} onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined); }}>{copied ? "Copied" : "Copy"}</Button>;
}

/** The single GitHub connection card. Sign-in and token storage always happen on the computer this console is attached to. */
export function GitHubPublicationControl({ secondary: _secondary = false }: { secondary?: boolean } = {}) {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const account = useGitHubPublicationAccount();
  const [token, setToken] = useState("");
  const [picked, setPicked] = useState<GitHubMethod | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const data = account.data;
  const method: GitHubMethod = data ? (githubMethods(data).some(item => item.value === picked) ? picked! : defaultGitHubMethod(data)) : "sign-in";
  const running = data?.deviceAuth.phase === "running";
  useEffect(() => { if (data?.connected) setConfirmDisconnect(false); }, [data?.connected]);

  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (action === "connect") {
        const submitted = token.trim();
        setToken("");
        if (!validToken(submitted)) throw new Error("Enter a GitHub token without spaces.");
        return webFetchJson<GitHubAccountResponse>("/api/console/github/connect", jsonBody({ token: submitted }));
      }
      if (action === "disconnect") return webFetchJson<GitHubAccountResponse>("/api/console/github", { method: "DELETE" });
      if (action === "cancel") return webFetchJson<GitHubAccountResponse>("/api/console/github/device-auth", { method: "DELETE", body: "{}" });
      return webFetchJson<GitHubAccountResponse>("/api/console/github/device-auth", jsonBody(action === "refresh" ? { mode: "refresh" } : {}));
    },
    onSuccess: (result, action) => {
      queryClient.setQueryData(queryKeys.consoleGithubPublication(), result.github);
      if (action === "connect" || action === "disconnect") { setPicked(null); setConfirmDisconnect(false); }
    },
    onSettled: () => { setToken(""); },
  });
  const busy = mutation.isPending;
  const act = (action: Action) => { mutation.reset(); mutation.mutate(action); };

  if (!data) return <ControlCard title="GitHub"><QueryState pending={account.isPending} error={account.error} retry={account.refetch} /></ControlCard>;

  const kind = githubCardKind(data);
  const expiry = formatExpiry(data.expiresAt);
  const status = deviceStatusText(data.deviceAuth);
  const deviceUrl = safeDeviceUrl(data.deviceAuth.verificationUrl);
  const methods = githubMethods(data);

  return <ControlCard title="GitHub">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium"><GitBranch className="size-4 shrink-0" /><span id="github-headline" className="min-w-0 break-words">{githubHeadline(data)}</span></div>
      <Badge variant="outline">Computer: {data.computer}</Badge>
    </div>
    {expiry && data.connected && <p className="text-xs text-muted-foreground">Expires {expiry}</p>}
    {kind === "needs-permissions" && <div className="flex flex-wrap items-center gap-2">
      <code className="rounded-md border-[0.5px] border-border-2 px-2 py-1 text-xs">{data.refreshCommand}</code>
      <SubmitButton variant="outline" pending={busy && mutation.variables === "refresh"} disabled={busy} onClick={() => act("refresh")}>Update permissions</SubmitButton>
    </div>}

    {!running && <Select aria-label="Connect with" size="sm" className="w-full sm:w-auto sm:min-w-56" value={method} disabled={busy} onValueChange={value => setPicked(value as GitHubMethod)} options={methods} />}

    {method === "cli" && !running && <p className="text-sm text-muted-foreground">Using the GitHub CLI login on {data.computer}.</p>}

    {(method === "sign-in" || running) && <section className="space-y-3">
      {!data.available
        ? <div className="space-y-2"><p className="text-sm">GitHub CLI isn't installed on {data.computer}.</p>
          <div className="flex flex-wrap items-center gap-2"><code className="rounded-md border-[0.5px] border-border-2 px-2 py-1 text-xs">{GITHUB_INSTALL_COMMAND}</code><CopyButton text={GITHUB_INSTALL_COMMAND} label="Copy install command" /><Button variant="outline" render={<a href={GITHUB_INSTALL_URL} target="_blank" rel="noopener noreferrer" />}>Get GitHub CLI<ExternalLink className="size-4" /></Button></div></div>
        : <>
          {data.deviceAuth.userCode && <div className="flex flex-wrap items-center gap-2"><code aria-label="One-time code" className="rounded-md border-[0.5px] border-border-2 px-3 py-2 text-lg tracking-widest">{data.deviceAuth.userCode}</code><CopyButton text={data.deviceAuth.userCode} label="Copy code" /></div>}
          {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
          <div className="flex flex-wrap gap-2">
            {deviceUrl && <Button variant="outline" render={<a href={deviceUrl} target="_blank" rel="noopener noreferrer" />}>Open GitHub<ExternalLink className="size-4" /></Button>}
            {data.deviceAuth.verificationUrl && !deviceUrl && <Feedback error="This sign-in link looks unsafe, so it wasn't opened." />}
            {running
              ? <SubmitButton variant="outline" pending={busy && mutation.variables === "cancel"} disabled={busy} onClick={() => act("cancel")}>Cancel</SubmitButton>
              : <SubmitButton variant="outline" pending={busy && mutation.variables === "sign-in"} disabled={busy} onClick={() => act("sign-in")}>{data.connected ? "Sign in with another account" : "Sign in with GitHub"}</SubmitButton>}
          </div>
          {!running && !status && <p className="text-xs text-muted-foreground">Signs in on {data.computer}</p>}
        </>}
    </section>}

    {method === "token" && !running && <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (validToken(token)) act("connect"); }}>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" render={<a href={guidedTokenUrl(data.computer)} target="_blank" rel="noopener noreferrer" />}>Create token on GitHub<ExternalLink className="size-4" /></Button></div>
      <TextField label="GitHub token" type="password" autoComplete="off" spellCheck={false} value={token} required maxLength={16384} disabled={busy || !data.available} onChange={event => setToken(event.target.value)} hint={`Checked, then stored on ${data.computer}.`} />
      <div className="flex flex-wrap gap-2"><SubmitButton type="submit" variant="outline" pending={busy && mutation.variables === "connect"} disabled={!validToken(token) || busy || !data.available}>Connect</SubmitButton></div>
    </form>}

    {data.connected && !running && <div className="flex flex-wrap items-center gap-2">
      {confirmDisconnect
        ? <><span className="text-sm">Sign out of GitHub on {data.computer}?</span>
          <SubmitButton variant="outline" pending={busy && mutation.variables === "disconnect"} disabled={busy} onClick={() => act("disconnect")}>Disconnect</SubmitButton>
          <Button variant="outline" disabled={busy} onClick={() => setConfirmDisconnect(false)}>Keep</Button></>
        : <Button variant="outline" disabled={busy} onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>}
    </div>}
    <Feedback error={mutation.error} />
  </ControlCard>;
}
