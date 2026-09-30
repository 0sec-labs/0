import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, ArrowRight, ArrowUpRight, ChevronDown, Plug } from "lucide-react";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const setupPrompt = `Help me connect this coding agent to 0.security's local MCP server.
First check whether the 0 CLI is installed and whether this agent supports local stdio MCP servers. Inspect the client's current configuration and preserve existing integrations.
Ask me for the authorized target URL and an absolute path to its scope JSON file before configuring target tools. Do not infer authorization from conversation history.
The server command is: 0 mcp-server --target <authorized-url> --scan-id <unique-session-id> --scope <absolute-scope-json> --tools http_request,crawl,query_findings
Use an absolute executable path if the client cannot resolve 0. Apply the client's actual MCP configuration format, show me the proposed change, and wait for approval before writing it.
Verify that the server exposes the selected tools. This is a scoped tool integration, not a replacement for the 0 browser chat, and does not automatically start an assessment.`;

export function AgentOnboarding({ sessionId }: { sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const suffix = sessionId ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(`/console/${sessionId}`)}` : "";
  const copyPrompt = () => {
    void navigator.clipboard.writeText(setupPrompt).then(() => { setCopied(true); setError(""); }).catch(() => { setCopied(false); setError("Couldn't copy. Open the setup prompt below and copy it manually."); });
  };
  const agents = [{ id: "claude", label: "Claude", color: "text-[#D97757]" }, { id: "codex", label: "Codex", color: "" }, { id: "cursor", label: "Cursor", color: "" }, { id: "opencode", label: "OpenCode", color: "" }];
  return <Dialog open={open} onOpenChange={value => { setOpen(value); setCopied(false); setError(""); }}>
    <DialogTrigger asChild><Button variant="secondary" size="sm" className="inline-flex gap-4 px-4"><span>Onboard your agent</span><span className="flex gap-1.5" aria-hidden="true">{agents.map(agent => <ProviderIcon key={agent.id} providerId={agent.id} className={`size-4 ${agent.color}`} />)}</span></Button></DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto sm:max-w-lg">
      <DialogHeader className="pr-7"><DialogTitle className="text-xl leading-7">Connect your agent</DialogTitle><DialogDescription className="leading-6">Use 0 in this chat, or bring its security tools to your coding agent.</DialogDescription></DialogHeader>
      <section className="space-y-4" aria-labelledby="coding-agent-heading">
        <div><h2 id="coding-agent-heading" className="text-sm font-medium">Bring 0 to your coding agent</h2><p className="mt-1.5 text-sm leading-6 text-muted-foreground">Paste the setup prompt into your agent. It checks MCP support and guides you through a scoped connection.</p></div>
        <div className="flex flex-wrap gap-x-5 gap-y-3">{agents.map(agent => <span key={agent.id} className="inline-flex items-center gap-2 text-xs text-muted-foreground"><ProviderIcon providerId={agent.id} className={`size-4 ${agent.color}`} />{agent.label}</span>)}</div>
        <div className="flex flex-wrap items-center gap-3"><Button onClick={copyPrompt}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Prompt copied" : "Copy setup prompt"}</Button><span role="status" aria-live="polite" className="text-xs text-muted-foreground">{copied ? "Paste it into your coding agent to continue." : "You'll review the configuration before it's applied."}</span></div>
        {error && <p role="alert" className="text-sm leading-6 text-destructive">{error}</p>}
        <details className="group rounded-xl bg-muted/35 p-3"><summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden"><ChevronDown className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />View setup prompt</summary><pre tabIndex={0} aria-label="Setup prompt" className="mt-3 max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background/40 p-3 font-sans text-xs leading-6 focus-visible:outline-1 focus-visible:outline-foreground/40">{setupPrompt}</pre></details>
      </section>
      <section className="space-y-3" aria-labelledby="model-provider-heading"><div className="flex items-start gap-3"><Plug className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><h2 id="model-provider-heading" className="text-sm font-medium">Use 0 here</h2><p className="mt-1.5 text-sm leading-6 text-muted-foreground">Connect a model provider to start chatting and reviewing in this workspace.</p></div></div><Button asChild variant="secondary"><Link to={`/connections${suffix}`} onClick={() => setOpen(false)}>Connect a provider<ArrowRight className="size-4" /></Link></Button></section>
      <Link to={`/setup${suffix}`} onClick={() => setOpen(false)} className="inline-flex w-fit items-center gap-1.5 rounded-lg text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-foreground/40">Prefer a walkthrough? Guided setup<ArrowUpRight className="size-3" /></Link>
    </DialogContent>
  </Dialog>;
}
