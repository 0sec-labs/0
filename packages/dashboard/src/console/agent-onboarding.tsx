import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, ArrowUpRight } from "lucide-react";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const setupPrompt = `Help me connect this coding agent to 0.security's local MCP server.
First check whether the 0 CLI is installed and whether this agent supports local stdio MCP servers. Inspect the client's current configuration and preserve existing integrations.
Ask me for the authorized target URL and an absolute path to its scope JSON file before configuring target tools. Do not infer authorization from conversation history.
The server command is: 0 mcp-server --target <authorized-url> --scan-id <unique-session-id> --scope <absolute-scope-json> --tools http_request,crawl,query_findings
Use an absolute executable path if the client cannot resolve 0. Apply the client's actual MCP configuration format, show me the proposed change, and wait for approval before writing it.
Verify that the server exposes the selected tools. This is a scoped tool integration, not a replacement for the 0 browser console, and does not automatically start an assessment.`;

export function AgentOnboarding({ sessionId }: { sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const suffix = sessionId ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(`/console/${sessionId}`)}` : "";
  return <><Button variant="secondary" size="sm" className="inline-flex gap-4 px-4" onClick={() => setOpen(true)}><span>Onboard your agent</span><span className="flex gap-1.5" aria-hidden="true"><span title="Claude"><ProviderIcon providerId="claude" className="size-4 text-[#D97757]" /></span><span title="Codex"><ProviderIcon providerId="codex" className="size-4" /></span><span title="Cursor"><ProviderIcon providerId="cursor" className="size-4" /></span><span title="OpenCode"><ProviderIcon providerId="opencode" className="size-4" /></span></span></Button>
    <Dialog open={open} onOpenChange={value => { setOpen(value); setCopied(false); setError(""); }}><DialogContent><DialogHeader><DialogTitle>Onboard your agent</DialogTitle><DialogDescription className="sr-only">Connect a model provider, or let your coding agent use 0's tools.</DialogDescription></DialogHeader>
      <Button asChild><Link to={`/connections${suffix}`} onClick={() => setOpen(false)}>Connect a provider<ArrowUpRight className="size-4" /></Link></Button>
      <div className="space-y-3 rounded-2xl bg-muted/40 p-4"><p className="text-sm text-muted-foreground">Or paste this prompt into your coding agent.</p><Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(setupPrompt).then(() => { setCopied(true); setError(""); }).catch(() => setError("Couldn't copy. Open the prompt below and copy it.")); }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : "Copy prompt"}</Button><details><summary className="cursor-pointer text-xs text-muted-foreground">Show prompt</summary><p className="mt-3 whitespace-pre-wrap text-sm leading-6">{setupPrompt}</p></details>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>
      <Button asChild variant="ghost"><Link to={`/setup${suffix}`} onClick={() => setOpen(false)}>Guided setup</Link></Button>
    </DialogContent></Dialog>
  </>;
}
