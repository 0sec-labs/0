import type { FindingProvenance } from "@/types";

function day(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Plain words for where a finding came from; null when the engine did not record it. */
export function provenanceLabel(provenance: FindingProvenance | null | undefined): string | null {
  if (!provenance || provenance.kind === "unknown") return null;
  const when = day(provenance.startedAt);
  const on = when ? ` on ${when}` : "";
  switch (provenance.kind) {
    case "scan": return `From scan ${provenance.target || provenance.scanId.slice(0, 8)}${on}`;
    case "agent": return `From Sentinel ${provenance.agent}`;
    case "thread": return "From thread";
    case "ci-import": return `Imported from a CI report${on}`;
  }
}
