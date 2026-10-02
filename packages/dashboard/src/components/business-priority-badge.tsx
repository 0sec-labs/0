import { getFindingPriority } from "@0/shared/dist/finding-priority.js";
import { Badge } from "./ui/badge";
import type { FindingRecord } from "@/types";

export function BusinessPriorityBadge({ finding }: { finding: Pick<FindingRecord, "severity" | "impactAssessment"> }) {
  const priority = getFindingPriority(finding);
  const variant = priority.label === "Urgent" ? "danger" : priority.label === "High" ? "warning" : priority.label === "Moderate" ? "info" : "neutral";
  return <Badge variant={variant} title={priority.rationale} aria-label={`Business impact: ${priority.label}`}>{priority.label}</Badge>;
}
