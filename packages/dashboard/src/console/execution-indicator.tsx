import { Disclosure } from "@/components/ui/disclosure";
import type { ConsoleExecutionSnapshot } from "@0/shared";
import { executionDetails, executionLabel } from "./execution-status";

export function ExecutionIndicator({ execution }: { execution?: ConsoleExecutionSnapshot }) {
  const details = executionDetails(execution);
  return <Disclosure className="text-xs text-muted-foreground" aria-label={`Execution: ${executionLabel(execution)}`} summary={<> {executionLabel(execution)} </>} triggerClassName="cursor-pointer">

    <div className="mt-2 space-y-1 rounded-[var(--radius-panel)] border border-border bg-background p-2">
      {details.length ? details.map((detail, index) => <p key={index} className="break-all">{detail}</p>) : <p>{execution ? "Workspace details unavailable." : "The engine has not reported its execution backend."}</p>}
    </div>
  </Disclosure>;
}
