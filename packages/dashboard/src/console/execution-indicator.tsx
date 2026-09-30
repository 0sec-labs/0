import type { ConsoleExecutionSnapshot } from "@0/shared";
import { executionDetails, executionLabel } from "./execution-status";

export function ExecutionIndicator({ execution }: { execution?: ConsoleExecutionSnapshot }) {
  const details = executionDetails(execution);
  return <details className="text-xs text-muted-foreground">
    <summary className="cursor-pointer" aria-label={`Execution: ${executionLabel(execution)}`}>{executionLabel(execution)}</summary>
    <div className="mt-2 space-y-1 rounded-md border border-border bg-background p-2">
      {details.length ? details.map((detail, index) => <p key={index} className="break-all">{detail}</p>) : <p>{execution ? "Workspace details unavailable." : "The engine has not reported its execution backend."}</p>}
    </div>
  </details>;
}
