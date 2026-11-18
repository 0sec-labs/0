import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/ui/components/toast";
import { useEffect, useState } from "react";
import { Check, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/provider-icon";

export const setupPrompt = `Help me use 0security for my task from this coding agent. Use the CLI directly when shell access is available.

Discover installed capabilities with 0 --version, 0 --help, relevant subcommand --help, 0 config doctor, and 0 config doctor workbench status --json. Choose among scan, findings, threads, sentinels, skills, memory, models, computers and config for the smallest operation serving my task.

Reuse an existing browser console. If needed, inspect 0 --help and start it with --no-open --ready-json; use its returned URL for /connections and /models. 0's model connection is separate from this coding agent's model session. I complete OAuth/browser or device approval myself. Never request or expose keys, tokens, or credential files in chat; use existing named credential environment variables or the console's credential inputs.

Choose local execution or a registered remote engine. Preserve client integrations, model connections, workspace grants, and execution profiles; never disable the workbench or switch SmolVM to host execution automatically. Remote workspace, model, and apply permissions belong to that engine; do not configure its provider through this client. For web operations, inspect 0 api --help, the selected engine's handshake/capabilities, and documented API paths; do not copy local credentials or configuration to it.

Discover definitions with 0 sentinels list --help; inspect 0 sentinels run --help only when execution is requested. Use 0 threads --help and 0 scan --help for inspection, results, continuation, and cancellation. Setup and discovery do not authorize assessments, automation runs, live-target requests, or patch application. Before authorized execution, resolve and show the target, workspace or scope file, model connection, and limits; live automations also need the host project's scope extension. Inspect exit status and retained evidence before claiming success.

Summarize readiness, any remaining sign-in or authorization, and the next command for my task.`;

const AGENTS = ["claude", "codex", "cursor", "opencode"] as const;

export function AgentOnboarding() {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 5000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyPrompt = () => {
    void navigator.clipboard
      .writeText(setupPrompt)
      .then(() => {
        setCopied(true);
      })
      .catch(() => {
        setCopied(false);
        // A toast and a dialog keep the chip row and composer where they are.
        toast({ id: "copy-setup-prompt", title: "Couldn't copy the prompt", kind: "error", action: { label: "Show prompt", onClick: () => setManual(true) } });
      });
  };
  return (
    <div className="inline-flex max-w-full flex-col items-center gap-2">
      <Button
        variant="chip"
        size="sm"
        onClick={copyPrompt}
        className="max-w-full !px-2.5"
        aria-label={
          copied ? "Copied prompt. Paste into your agent." : "Set up your coding agent: copy CLI setup prompt"
        }
      >
        <span className="grid min-w-0 text-left">
          <span
            className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 transition-[opacity,transform] duration-[var(--ui-duration-standard)] motion-reduce:transition-none ${copied ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"}`}
            aria-hidden={copied}
          >
            <TerminalSquare aria-hidden="true" strokeWidth={1} className="shrink-0 text-icon-muted" />
            <span>Set up your coding agent</span>
            <span className="flex gap-1.5 text-icon-muted opacity-80" aria-hidden="true">
              {AGENTS.map((id) => (
                <ProviderIcon key={id} providerId={id} className="size-3.5" />
              ))}
            </span>
          </span>
          <span
            className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 transition-[opacity,transform] duration-[var(--ui-duration-standard)] motion-reduce:transition-none ${copied ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"}`}
            aria-hidden={!copied}
          >
            <Check aria-hidden="true" strokeWidth={1} className="shrink-0 text-icon-muted" />
            <span>Copied prompt · Paste into your agent</span>
          </span>
        </span>
      </Button>
      <span role="status" className="sr-only">
        {copied ? "Copied prompt. Paste into your agent." : ""}
      </span>
      <Dialog open={manual} onOpenChange={setManual}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>Setup prompt</DialogTitle></DialogHeader>
          <pre tabIndex={0} aria-label="Setup prompt" className="whitespace-pre-wrap break-words rounded-[var(--radius-panel)] bg-muted p-3 text-xs select-text">{setupPrompt}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
