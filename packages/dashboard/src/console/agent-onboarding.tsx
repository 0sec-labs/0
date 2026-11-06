import { Disclosure } from "@/components/ui/disclosure";
import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";

export const setupPrompt = `Help me use 0.security for my task from this coding agent. Prefer the CLI; configure MCP only if this client needs a tool connection.

Discover installed capabilities with 0 --version, 0 --help, relevant subcommand --help, 0 doctor, and 0 workbench status --json. Choose among review, scan, workflow, sessions, runs, findings, api, and web for the smallest operation serving my task.

Reuse an existing browser console. If needed, inspect 0 web --help and start it with --no-open --ready-json; use its returned URL for /onboarding, /connections, and /models. 0's model connection is separate from this coding agent's model session. I complete OAuth/browser or device approval myself. Never request or expose keys, tokens, or credential files in chat; use existing named credential environment variables or the console's credential inputs.

Choose local execution or a registered remote engine. Preserve client integrations, model connections, workspace grants, and execution profiles; never disable the workbench or switch SmolVM to host execution automatically. Remote workspace, scope, model, and apply permissions belong to that engine; do not configure its provider through this client. For web operations, inspect 0 api --help, the selected engine's handshake/capabilities, and documented API paths; do not copy local credentials or configuration to it.

Discover definitions with 0 workflow list --help and 0 workflow show --help; inspect 0 workflow run --help only when execution is requested. Use sessions and runs help for inspection, results, continuation, and cancellation. Setup and discovery do not authorize assessments, workflow runs, live-target requests, or patch application. Before authorized execution, resolve and show the target, workspace or scope file, model connection, and limits; live workflows also need the host project's scope plugin. Inspect exit status and retained evidence before claiming success.

MCP is optional: inspect 0 mcp-server --help and the client's actual configuration format, preserving other integrations. Use an absolute executable path if needed. Local stdio requires operator-selected host-local execution; with SmolVM, prefer isolated CLI workflows unless I explicitly choose host execution. Local workflows use --workflows --workspace <authorized-absolute-root>, or --workflows --scope <absolute-scope-json> for live targets. Remote engines use --workflows --backend <registered-id> (optional --backends-config), require workflow-engine capability, and omit local workspace/scope/db-path flags. Expose only needed tools, inspect schemas, and verify discovery without launching work. Connecting does not attach this agent to a browser conversation; disconnect cancels local stdio runs but remote runs persist.

Summarize readiness, any remaining sign-in or authorization, and the next command for my task.`;

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
