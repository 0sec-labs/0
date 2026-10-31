import type { Finding } from "@0/shared";

/** Remove only an explicit finding-number prefix; preserve meaningful title text. */
export function findingTitle(finding: Finding): string {
  const title = finding.title.replace(/^F\d+\s*(?:\([^)]*\))?\s*:\s*/i, "").trim();
  return /[a-z]{3}/i.test(title) ? title : finding.description.split(/\n/)[0]!.slice(0, 160) || finding.title;
}

export function findingSummary(finding: Finding): string {
  const text = finding.description.replace(/\s+/g, " ").trim();
  const sentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || text;
  return sentence.length > 280 ? sentence.slice(0, 277).replace(/\s+\S*$/, "") + "..." : sentence;
}
export function reportDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

/** Optional edited copy; technical source fields remain unchanged. */
export interface FindingPresentation {
  title: string;
  summary: string;
  action?: string;
  deployment?: { label: string; note: string; sources?: Array<{ label: string; url: string }> };
}
export function findingPresentation(finding: Finding): FindingPresentation {
  const edited = (finding as Finding & { presentation?: FindingPresentation }).presentation;
  if (edited) return edited;
  const title = findingTitle(finding)
    .replace(/^(?:critical|high|medium|low|info|IDOR)\s*:\s*/i, "")
    .replace(/\s*[—–]\s*repo(?:[- ]tracked|\s).*$/i, "")
    .replace(/\s*\((?:app|src)\/.*\)$/, "");
  const action = [finding.evidence.analysis, finding.description].filter(Boolean).join("\n").match(/(?:Remediation|Suggested remediation|Fix):\s*([^\n]+)/i)?.[1]?.trim();
  return { title, summary: findingSummary(finding), action };
}
export function targetLabel(target: string): string {
  if (/^(?:https?:\/\/)/i.test(target)) { try { return new URL(target).hostname; } catch { return target; } }
  const parts = target.replace(/\\/g, "/").split("/").filter(Boolean);
  const review = parts.find(part => /^[a-z][a-z0-9-]*-\d{8}T\d+Z$/i.test(part));
  const name = review?.replace(/-\d{8}T\d+Z$/i, "") || (parts.at(-1) === "source" ? parts.at(-2) : parts.at(-1)) || target;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
