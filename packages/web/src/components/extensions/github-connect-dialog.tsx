import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Feedback, SubmitButton, TextField } from "@/components/console-control/control-ui";
import { GITHUB_INSTALL_COMMAND, guidedTokenUrl, safeDeviceUrl, validToken } from "@/components/console-control/github-connection-model";
import { useGitHubConnect } from "@/components/console-control/github-publication-control";

type Method = "sign-in" | "token";

/**
 * Connect GitHub: pick how, then follow it. Everything that went wrong shows inside this dialog and is gone when it is
 * reopened. Signing in and the token are both kept on the computer this console is attached to.
 */
export function GitHubConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, token, setToken, mutation, busy, act, running } = useGitHubConnect();
  const [method, setMethod] = useState<Method>("sign-in");
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (open) { setMethod("sign-in"); setTouched(false); setToken(""); mutation.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Done: whichever way it was started, close once GitHub says it is connected.
  useEffect(() => { if (open && touched && data?.connected && !running && data.deviceAuth.phase !== "running") onClose(); }, [open, touched, data?.connected, running, data?.deviceAuth.phase, onClose]);
  const start = (action: "sign-in" | "connect" | "cancel") => { setTouched(true); act(action); };
  const phase = data?.deviceAuth.phase;
  const note = !touched ? null : running ? (data?.deviceAuth.userCode ? null : "Waiting for a code from GitHub…") : phase === "timeout" ? "The code expired. Try again." : phase === "failed" ? data?.deviceAuth.message || "Sign-in failed." : null;
  const deviceUrl = safeDeviceUrl(data?.deviceAuth.verificationUrl);
  const computer = data?.computer ?? "this computer";
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}>
    <DialogContent showCloseButton={false} className="sm:max-w-md rounded-md">
      <DialogHeader><DialogTitle>Connect GitHub</DialogTitle><DialogDescription>So 0 can read your repositories and pull requests.</DialogDescription></DialogHeader>
      {data && <>
        {!running && <Tabs value={method} onValueChange={value => setMethod(value as Method)}><TabsList variant="line" aria-label="How to connect"><TabsTrigger value="sign-in">Sign in with GitHub</TabsTrigger><TabsTrigger value="token">Use a token</TabsTrigger></TabsList></Tabs>}
        {(method === "sign-in" || running) && <section className="space-y-3">
          {!data.available
            ? <p className="text-sm text-muted-foreground-1">Signing in needs the GitHub CLI, which is not installed on {computer}. Install it with <code className="rounded-md border-[0.5px] border-border-2 px-1.5 py-0.5 text-xs">{GITHUB_INSTALL_COMMAND}</code>, or use a token.</p>
            : <>
              {data.deviceAuth.userCode ? <div className="space-y-2"><p className="text-sm text-muted-foreground-1">Enter this code on GitHub.</p><code aria-label="One-time code" className="inline-block rounded-md border-[0.5px] border-border-2 px-3 py-2 text-lg tracking-widest">{data.deviceAuth.userCode}</code></div>
                : <p className="text-sm text-muted-foreground-1">GitHub gives you a code to enter. Signs in on {computer}.</p>}
              {note && <p role="status" className="text-sm text-muted-foreground-1">{note}</p>}
            </>}
        </section>}
        {method === "token" && !running && <form id="github-token-form" className="space-y-3" onSubmit={event => { event.preventDefault(); if (validToken(token)) start("connect"); }}>
          <TextField label="Fine-grained token" type="password" autoComplete="off" spellCheck={false} value={token} required maxLength={16384} disabled={busy} onChange={event => setToken(event.target.value)} hint={`Checked, then stored on ${computer}.`} />
          <a className="inline-block text-sm text-muted-foreground-1 underline underline-offset-2 hover:text-foreground" href={guidedTokenUrl(data.computer)} target="_blank" rel="noopener noreferrer">Create a token on GitHub</a>
        </form>}
        {touched && <Feedback error={mutation.error} />}
      </>}
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={() => { if (running) start("cancel"); else onClose(); }}>{running ? "Stop signing in" : "Cancel"}</Button>
        {!running && method === "sign-in" && <><SubmitButton variant="default" pending={busy && mutation.variables === "sign-in"} disabled={busy || !data?.available} onClick={() => start("sign-in")}>Continue with GitHub</SubmitButton></>}
        {running && deviceUrl && <Button render={<a href={deviceUrl} target="_blank" rel="noopener noreferrer" />}>Open GitHub</Button>}
        {!running && method === "token" && <SubmitButton type="submit" form="github-token-form" variant="default" pending={busy && mutation.variables === "connect"} disabled={!validToken(token) || busy}>Connect</SubmitButton>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
