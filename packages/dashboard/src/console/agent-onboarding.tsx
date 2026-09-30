import { useState } from "react";
import { Check, Copy, ChevronDown } from "lucide-react";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const setupPrompt = `Help me connect this coding agent to 0.security's local MCP server.
First check whether the 0 CLI is installed and whether this agent supports local stdio MCP servers. Inspect the client's current configuration and preserve existing integrations.
Ask me for the authorized target URL and an absolute path to its scope JSON file before configuring target tools. Do not infer authorization from conversation history.
The server command is: 0 mcp-server --target <authorized-url> --scan-id <unique-session-id> --scope <absolute-scope-json> --tools http_request,crawl,query_findings
Use an absolute executable path if the client cannot resolve 0. Apply the client's actual MCP configuration format, show me the proposed change, and wait for approval before writing it.
Verify that the server exposes the selected tools. This is a scoped tool integration, not a replacement for the 0 browser chat, and does not automatically start an audit.`;

export function AgentOnboarding(_props: { sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const copyPrompt = () => {
    void navigator.clipboard.writeText(setupPrompt).then(() => { setCopied(true); setError(""); }).catch(() => { setCopied(false); setError("Couldn't copy. Open the setup prompt below and copy it manually."); });
  };
  const agents = [{ id: "claude", label: "Claude", color: "text-[#D97757]" }, { id: "codex", label: "Codex", color: "" }, { id: "cursor", label: "Cursor", color: "" }, { id: "opencode", label: "OpenCode", color: "" }];
  return <Dialog open={open} onOpenChange={value => { setOpen(value); setCopied(false); setError(""); }}>
    <DialogTrigger asChild><Button variant="secondary" size="sm" className="inline-flex gap-4 px-4"><span>Onboard your agent</span><span className="flex gap-1.5" aria-hidden="true">{agents.map(agent => <ProviderIcon key={agent.id} providerId={agent.id} className={`size-4 ${agent.color}`} />)}</span></Button></DialogTrigger>
    <DialogContent aria-describedby={undefined} className="gap-5 sm:max-w-sm">
      <DialogHeader><DialogTitle>Connect your agent</DialogTitle></DialogHeader>
      <div className="flex flex-wrap gap-x-5 gap-y-3">{agents.map(agent => <span key={agent.id} className="inline-flex items-center gap-2 text-xs text-muted-foreground"><ProviderIcon providerId={agent.id} className={`size-4 ${agent.color}`} />{agent.label}</span>)}</div>
      <Button onClick={copyPrompt} className="w-full" aria-live="polite">{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : "Copy setup prompt"}</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <details className="group"><summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden"><ChevronDown className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />View prompt</summary><pre tabIndex={0} aria-label="Setup prompt" className="mt-3 max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-muted/35 p-3 font-sans text-xs leading-6 focus-visible:outline-1 focus-visible:outline-foreground/40">{setupPrompt}</pre></details>
    </DialogContent>
  </Dialog>;
}
