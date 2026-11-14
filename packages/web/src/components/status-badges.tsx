import { StatusBadge, type StatusTone } from "@/ui/components/status-badge";
import type { FindingReviewGate, FindingWorkflowPhase, FindingWorkflowStatus } from "@/types";

function formatWorkflowLabel(value: FindingWorkflowStatus) {
  return value.replaceAll("_", " ");
}

export function SeverityBadge({ severity }: { severity: string }) {
  const normalized = severity.toLowerCase();
  const tone: StatusTone =
    normalized === "critical" || normalized === "high"
      ? "danger"
      : normalized === "medium"
        ? "warning"
        : normalized === "low"
          ? "info"
          : "neutral";

  return <StatusBadge tone={tone}>{severity}</StatusBadge>;
}

export function RunStatusBadge({
  value,
}: {
  value: string;
}) {
  const normalized = value.toLowerCase();
  const tone: StatusTone =
    normalized === "accepted" || normalized === "complete" || normalized === "completed"
      ? "success"
      : normalized === "suppressed"
        ? "warning"
        : normalized === "running" || normalized === "claiming"
          ? "accent"
          : normalized === "failed" || normalized === "critical" || normalized === "error"
            ? "danger"
            : normalized === "sleeping"
              ? "warning"
            : "neutral";

  return <StatusBadge tone={tone}>{value}</StatusBadge>;
}

export function PhaseBadge({
  value,
}: {
  value: FindingWorkflowPhase;
}) {
  const tone: StatusTone =
    value === "done"
      ? "success"
      : value === "cancelled" || value === "blocked"
        ? "danger"
        : value === "in_progress"
          ? "accent"
          : "neutral";

  return <StatusBadge tone={tone}>{formatWorkflowLabel(value)}</StatusBadge>;
}

export function ReviewBadge({
  value,
}: {
  value: FindingReviewGate;
}) {
  if (value === "none") return null;

  return (
    <StatusBadge tone={value === "human_review" ? "warning" : "accent"}>
      {formatWorkflowLabel(value)}
    </StatusBadge>
  );
}
