import * as React from "react";

/** Lifecycle labels are retained observations, not independent reproduction receipts. */
export function RecordedFindingStatus({ status }: { status: string }) {
  return <span className="text-xs text-muted-foreground" title="Recorded lifecycle label; inspect the evidence to establish reproduction.">Recorded status: {status.replaceAll("_", " ")}</span>;
}
