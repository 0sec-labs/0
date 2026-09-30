import type { ConsoleExecutionSnapshot } from "@0/shared";

export function executionLabel(execution?: ConsoleExecutionSnapshot): string {
  if (!execution) return "Execution unknown";
  const backend = execution.backend === "smolvm" ? "SmolVM" : "Local";
  return `${backend} · ${execution.status}`;
}

export function executionDetails(execution?: ConsoleExecutionSnapshot): string[] {
  if (!execution) return [];
  return [
    execution.workspacePath && `Workspace: ${execution.workspacePath}`,
    execution.backend === "smolvm" && execution.status === "running" && execution.guestWorkspacePath && `Guest: ${execution.guestWorkspacePath}`,
    execution.runId && `Run: ${execution.runId}`,
    execution.imageDigest && `Image: ${execution.imageDigest}`,
    execution.cpus !== undefined && `${execution.cpus} CPUs`,
    execution.memoryMb !== undefined && `${execution.memoryMb} MiB memory`,
    execution.message,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}
