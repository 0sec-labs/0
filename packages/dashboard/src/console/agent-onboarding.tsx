import { useState } from "react";
import { Check, Copy, ChevronDown } from "lucide-react";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export const setupPrompt = `Help me connect this coding agent to 0.security's local stdio MCP server.
First check that the 0 CLI is installed and that this client supports local stdio MCP servers. Inspect the client's configuration and preserve existing integrations.
Check the selected 0 execution profile. MCP stdio currently requires operator-selected host-local execution; the SmolVM CLI bridge does not support bidirectional MCP transport. Do not automatically disable the workbench or change the execution profile. If SmolVM is selected, explain the prerequisite and use isolated CLI workflow commands instead unless the operator explicitly chooses host execution.
For reusable workflow execution, configure: 0 mcp-server --workflows --workspace <authorized-absolute-repository-root>
For authorized live-target workflows, configure: 0 mcp-server --workflows --scope <absolute-scope-json> [--target <authorized-url>]
Use only workspace roots and live targets the user authorizes for this connection. Live workflows require a scope file and the enabled scope plugin in the host project. Atomic tools enforce the scope file when that plugin is enabled.
Discover templates with list_templates and get_template; inspect or save reusable definitions with list_workflows, get_workflow, and save_workflow. Use start_run to launch a pinned template or saved workflow revision. Poll get_run for status, use get_run_results for retained findings and artifacts, and cancel_run to stop an owned run. Inspect the actual tool schemas before supplying inputs.
Assessments use 0's configured model provider, separately from this external agent's model session. Check 0's provider configuration before starting a run and show the resolved target, connection, and limits.
Atomic target tools are also available. Configure only the tools needed, for example: 0 mcp-server --target <authorized-url> --scan-id <unique-scan-id> --scope <absolute-scope-json> --tools http_request,crawl,query_findings
Atomic tools do not start a full assessment. An explicit --tools selection controls exposure; enabling workflows does not implicitly authorize additional targets.
Use an absolute executable path if the client cannot resolve 0. Apply this client's actual MCP configuration format and show the configuration change.
Verify the selected tools are exposed. Connecting does not start a run or attach this client to a browser conversation. Runs started by this stdio host live while the host lives; disconnecting cancels its active runs.`;

export function AgentOnboarding() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const copyPrompt = () => {
    void navigator.clipboard.writeText(setupPrompt).then(() => { setCopied(true); setError(""); }).catch(() => { setCopied(false); setError("Couldn't copy. Open the setup prompt below and copy it manually."); });
  };
  const agents = [{ id: "claude", label: "Claude", color: "text-[#D97757]" }, { id: "codex", label: "Codex", color: "" }, { id: "cursor", label: "Cursor", color: "" }, { id: "opencode", label: "OpenCode", color: "" }];
  return <Dialog open={open} onOpenChange={value => { setOpen(value); setCopied(false); setError(""); }}>
    <DialogTrigger asChild><Button variant="secondary" size="sm" className="inline-flex gap-4 px-4"><span>Connect an external agent</span><span className="flex gap-1.5" aria-hidden="true">{agents.map(agent => <ProviderIcon key={agent.id} providerId={agent.id} className={`size-4 ${agent.color}`} />)}</span></Button></DialogTrigger>
    <DialogContent aria-describedby={undefined} className="gap-5 sm:max-w-sm">
      <DialogHeader><DialogTitle>Connect an external agent</DialogTitle></DialogHeader>
      <div className="flex flex-wrap gap-x-5 gap-y-3">{agents.map(agent => <span key={agent.id} className="inline-flex items-center gap-2 text-xs text-muted-foreground"><ProviderIcon providerId={agent.id} className={`size-4 ${agent.color}`} />{agent.label}</span>)}</div>
      <Button onClick={copyPrompt} className="w-full" aria-live="polite">{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : "Copy setup prompt"}</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <details className="group"><summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden"><ChevronDown className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />View prompt</summary><pre tabIndex={0} aria-label="Setup prompt" className="mt-3 max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-muted/35 p-3 font-sans text-xs leading-6 focus-visible:outline-1 focus-visible:outline-foreground/40">{setupPrompt}</pre></details>
    </DialogContent>
  </Dialog>;
}
