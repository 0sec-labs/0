import type { ScanReport } from "@0/shared"

export function formatJson(report: ScanReport): string {
  return JSON.stringify(report, null, 2);
}
