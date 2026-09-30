import { ControlDisclosure } from "./control-disclosure";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, GitBranch, RefreshCcw } from "lucide-react";
import { webFetchJson } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ControlCard, Feedback, QueryState, SubmitButton, TextField, jsonBody } from "./control-ui";

export interface GitHubPublicationAccount {
  available: boolean;
  connected: boolean;
  account: string | null;
  scopes: string[];
  deviceAuth: {
    phase: "idle" | "running" | "connected" | "failed" | "cancelled" | "unavailable";
    message: string;
    verificationUrl?: string;
    userCode?: string;
  };
}
interface GitHubAccountResponse { github: GitHubPublicationAccount }

export function useGitHubPublicationAccount() {
  return useQuery({
    queryKey: ["console-github-publication"],
    queryFn: async ({ signal }) => (await webFetchJson<GitHubAccountResponse>("/api/console/github", { signal })).github,
    refetchInterval: query => query.state.data?.deviceAuth.phase === "running" ? 1000 : false,
  });
}

export function GitHubPublicationControl() {
  const queryClient = useQueryClient();
  const account = useGitHubPublicationAccount();
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const running = account.data?.deviceAuth.phase === "running";
  let verificationUrl: string | null = null;
  if (account.data?.deviceAuth.verificationUrl) {
    try {
      const url = new URL(account.data.deviceAuth.verificationUrl);
      if (url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.port && /^\/login\/device\/?$/.test(url.pathname)) verificationUrl = url.href;
    } catch { /* Invalid authorization URLs are never opened. */ }
  }
  const mutation = useMutation({
    mutationFn: async (action: "connect" | "device" | "cancel") => {
      if (action === "connect") {
        const submittedToken = token.trim();
        setToken("");
        if (!submittedToken || submittedToken.length > 16384 || /\s/.test(submittedToken)) throw new Error("Enter a GitHub token without whitespace.");
        return webFetchJson<GitHubAccountResponse>("/api/console/github/connect", jsonBody({ token: submittedToken }));
      }
      return webFetchJson<GitHubAccountResponse>("/api/console/github/device-auth", { method: action === "cancel" ? "DELETE" : "POST", body: "{}" });
    },
    onSuccess: (data, action) => {
      queryClient.setQueryData(["console-github-publication"], data.github);
      setMessage(action === "connect"
        ? data.github.connected ? "GitHub connected." : "GitHub isn't connected yet. Check the status below."
        : data.github.deviceAuth.message);
    },
    onSettled: () => { setToken(""); },
  });

  return <ControlCard title="GitHub" description="Optional. Needed only to open pull requests.">
    <QueryState pending={account.isPending} error={account.error} retry={account.refetch} />
    {account.data && <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-medium"><GitBranch className="size-4" />{account.data.account ?? "GitHub.com"}</div><Badge variant={account.data.connected ? "secondary" : "outline"}>{account.data.connected ? "Connected" : "Not connected"}</Badge></div>
      {account.data.connected && account.data.scopes.length > 0 && <p className="text-xs text-muted-foreground">Permissions: {account.data.scopes.join(", ")}</p>}
      {account.data.deviceAuth.phase !== "idle" && account.data.deviceAuth.phase !== "connected" && <p role="status" className="text-sm leading-relaxed text-muted-foreground">{account.data.deviceAuth.message}</p>}
      {!account.data.available && <p className="rounded-md border border-border bg-muted/20 p-3 text-sm">GitHub isn't available on this computer. <Link to="/doctor" className="underline">Check requirements</Link>.</p>}
      <section className="space-y-3">
        {account.data.deviceAuth.userCode && <div><p className="text-xs text-muted-foreground">Your code</p><code className="mt-1 inline-block rounded-md border border-border px-3 py-2 text-lg tracking-widest">{account.data.deviceAuth.userCode}</code></div>}
        {verificationUrl && <Button asChild variant="outline"><a href={verificationUrl} target="_blank" rel="noopener noreferrer">Open GitHub<ExternalLink className="size-4" /></a></Button>}
        {account.data.deviceAuth.verificationUrl && !verificationUrl && <Feedback error="This sign-in link looks unsafe, so it wasn't opened." />}
        <div className="flex flex-wrap gap-2">{running
          ? <SubmitButton variant="outline" pending={mutation.isPending && mutation.variables === "cancel"} disabled={mutation.isPending} onClick={() => mutation.mutate("cancel")}>Cancel sign-in</SubmitButton>
          : <SubmitButton pending={mutation.isPending && mutation.variables === "device"} disabled={mutation.isPending || !account.data.available} onClick={() => { setMessage(null); mutation.mutate("device"); }}>{account.data.connected ? "Use another account" : "Sign in with GitHub"}</SubmitButton>}
          <Button variant="ghost" disabled={account.isFetching || mutation.isPending} onClick={() => void account.refetch()}><RefreshCcw className="size-4" />Refresh</Button>
        </div>
      </section>
      <ControlDisclosure title={<>Use a token instead</>}><form className="mt-3 space-y-4" onSubmit={event => { event.preventDefault(); setMessage(null); mutation.mutate("connect"); }}>
        <TextField label="GitHub token" type="password" autoComplete="off" spellCheck={false} value={token} required maxLength={16384} disabled={mutation.isPending || running || !account.data.available} onChange={event => setToken(event.target.value)} hint="Stored locally on this computer." />
        <div className="flex flex-wrap gap-2"><SubmitButton type="submit" pending={mutation.isPending && mutation.variables === "connect"} disabled={!token.trim() || mutation.isPending || running || !account.data.available}>Connect</SubmitButton><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => { setToken(""); setMessage(null); mutation.reset(); }}>Clear</Button></div>
      </form></ControlDisclosure>
    </>}
    <Feedback error={mutation.error} message={message} />
  </ControlCard>;
}
