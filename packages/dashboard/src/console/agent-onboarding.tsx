import { Disclosure } from "@/components/ui/disclosure";
import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";

export const setupPrompt = `Help me connect this coding agent to 0.security's local stdio MCP server.
First check that the 0 CLI is installed and that this client supports local stdio MCP servers. Inspect the client's configuration and preserve existing integrations.
Choose a local runtime or a registered remote engine. For local targets, check the selected 0 execution profile: MCP stdio requires operator-selected host-local execution because the SmolVM CLI bridge does not support bidirectional MCP transport. Do not automatically disable the workbench or change its profile. If SmolVM is selected, use isolated CLI workflow commands unless the operator explicitly chooses host execution.
For an existing registered remote engine, configure: 0 mcp-server --workflows --backend <registered-id> [--backends-config <absolute-registry-json>]. This host runs only the network client and leaves its local execution profile unchanged. The engine owns workspace, scope, model and apply permission; do not supply local workspace/scope/db-path flags or try to configure its provider through this client. Require the backend's workflow-engine capability before launching.
For reusable workflow execution, configure: 0 mcp-server --workflows --workspace <authorized-absolute-repository-root>
For authorized live-target workflows, configure: 0 mcp-server --workflows --scope <absolute-scope-json> [--target <authorized-url>]
Use only workspace roots and live targets the user authorizes for this connection. Live workflows require a scope file and the enabled scope plugin in the host project. Atomic tools enforce the scope file when that plugin is enabled.
Discover templates with list_templates and get_template; inspect or save reusable definitions with list_workflows, get_workflow, and save_workflow. Use start_run to launch a pinned template or saved workflow revision. List owned history with list_runs, poll get_run for status, use get_run_results for retained findings and artifacts, and cancel_run to stop an owned run. Inspect the actual tool schemas before supplying inputs.
Assessments use 0's configured model provider, separately from this external agent's model session. Check 0's provider configuration before starting a run and show the resolved target, connection, and limits.
Atomic target tools are also available. Configure only the tools needed, for example: 0 mcp-server --target <authorized-url> --scan-id <unique-scan-id> --scope <absolute-scope-json> --tools http_request,crawl,query_findings
Atomic tools do not start a full assessment. An explicit --tools selection controls exposure; enabling workflows does not implicitly authorize additional targets.
Use an absolute executable path if the client cannot resolve 0. Apply this client's actual MCP configuration format and show the configuration change.
Verify the selected tools are exposed. Connecting does not start a run or attach this client to a browser conversation. Local runs live while this stdio host lives; disconnecting cancels its active runs. Remote engine runs persist when this client disconnects; cancel_run explicitly cancels an owned remote run.`;

export function AgentOnboarding() {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 5000); return () => clearTimeout(timer); }, [copied]);
  const copyPrompt = () => {
    void navigator.clipboard.writeText(setupPrompt).then(() => { setCopied(true); setError(""); }).catch(() => { setCopied(false); setError("Couldn't copy. Open the setup prompt below and copy it manually."); });
  };
  const agents = [{ id: "claude", label: "Claude", color: "text-[#D97757]" }, { id: "codex", label: "Codex", color: "" }, { id: "cursor", label: "Cursor", color: "" }, { id: "opencode", label: "OpenCode", color: "" }];
  return <div className="inline-flex max-w-full flex-col items-center gap-2">
    <Button variant="secondary" size="sm" onClick={copyPrompt} className="inline-flex max-w-full gap-3 px-4" aria-label={copied ? "Copied prompt. Paste into your agent." : "Connect an external agent: copy setup prompt"}>
      <span className="grid min-w-0 text-left"><span className={`col-start-1 row-start-1 inline-flex items-center gap-3 transition-[opacity,transform] duration-[var(--ui-duration-standard)] motion-reduce:transition-none ${copied ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"}`} aria-hidden={copied}><span>Connect an external agent</span><span className="flex gap-1.5" aria-hidden="true">{agents.map(agent => <ProviderIcon key={agent.id} providerId={agent.id} className={`size-4 ${agent.color}`} />)}</span></span><span className={`col-start-1 row-start-1 inline-flex items-center gap-2 transition-[opacity,transform] duration-[var(--ui-duration-standard)] motion-reduce:transition-none ${copied ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"}`} aria-hidden={!copied}><Check aria-hidden="true" className="size-4 shrink-0" /><span>Copied prompt · Paste into your agent</span></span></span>
    </Button>
    <span role="status" className="sr-only">{copied ? "Copied prompt. Paste into your agent." : ""}</span>
    {error && <div className="max-w-sm space-y-2 text-left"><p role="alert" className="text-xs text-destructive">{error}</p><Disclosure summary={<><ChevronDown className="size-3.5" />Copy prompt manually</>} triggerClassName="inline-flex items-center gap-1 text-xs text-muted-foreground"><pre tabIndex={0} aria-label="Setup prompt" className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-panel)] bg-muted p-3 text-xs">{setupPrompt}</pre></Disclosure></div>}
  </div>;
}
