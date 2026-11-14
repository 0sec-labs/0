import type { ScanReport } from "@0/engine/shared";

export function formatJson(report: ScanReport): string {
  return JSON.stringify(report, null, 2);
}
