/**
 * View model for the Extensions page. Pure: API data in, plain display data out. No React, no fetching, so the rules
 * for status, toggles, the install prompt and wording are tested without a browser.
 */

export interface ExtensionRowDto {
  name: string; builtin: boolean; kind: "built-in" | "git" | "local" | "unmigrated"; version: string; description: string;
  status: "built-in" | "enabled" | "disabled" | "needs-approval" | "unmigrated" | "refused";
  enabled: boolean; revision: string | null; sourceLabel: string | null; canDo: string[]; skills: string[];
  refusal: { code: string; reason: string } | null; note: string;
  /** The connector contract it declares, when it is a connector (its card is on the Connections section). */
  connector?: import("./connector-model").ConnectorDto | null;
  /** MCP servers the extension declares; `needs-approval` means a tool changed, is new or was removed (or was never approved). */
  mcp?: Array<{ server: string; state: "not-connected" | "approved" | "needs-approval"; reason: string }>;
}
export interface ImportReportDto { importedAt: string; migrated: Array<{ kind: string; name: string; detail: string }>; notMigrated: Array<{ kind: string; name: string; detail: string }>; notes: string[] }
export interface OverviewDto { rows: ExtensionRowDto[]; importReport: ImportReportDto | null; error?: string }

export interface InstallPromptDto {
  kind: "install" | "update"; name: string; version: string; description: string;
  source: { type: "git"; url: string } | { type: "local"; path: string };
  revision: string; pinned: boolean; repoAtCommit: string; licence: string | null; canDo: string[]; warnings: string[]; hiddenUnicode: string[];
  files: Array<{ path: string; size: number }>;
  diff: { fromRevision: string; added: string[]; removed: string[]; changed: string[]; patch?: string; patchTruncated?: boolean; capabilityDelta: { added: string[]; removed: string[] } } | null;
}

export const shortRevision = (revision: string | null): string => !revision ? "" : revision.startsWith("local-") ? revision.slice(6, 13) : revision.slice(0, 7);

/** `owner/repo@abc1234`, a folder name marked local, or "Built in". */
export function sourceLine(row: Pick<ExtensionRowDto, "builtin" | "kind" | "sourceLabel" | "revision">): string {
  if (row.builtin) return "Built in";
  if (row.kind === "unmigrated") return "Earlier extension";
  const at = shortRevision(row.revision);
  if (row.kind === "local") return `${row.sourceLabel ?? "folder"} (local folder)${at ? ` @ ${at}` : ""}`;
  return `${row.sourceLabel ?? "unknown source"}${at ? `@${at}` : ""}`;
}

export type StatusTone = "neutral" | "success" | "warning" | "danger";
export interface StatusView { label: string; tone: StatusTone; detail: string }

export function statusView(row: ExtensionRowDto): StatusView {
  switch (row.status) {
    case "refused": return { label: "Refused", tone: "danger", detail: row.refusal?.reason ?? "It will not run." };
    case "unmigrated": return { label: "Could not migrate", tone: "warning", detail: row.note || "It used the old executable format and cannot run." };
    case "needs-approval": return { label: "Needs approval", tone: "warning", detail: "Review what it can do before turning it on." };
    case "enabled": {
      const review = row.mcp?.find(server => server.state === "needs-approval");
      return review ? { label: "Tools need approval", tone: "warning", detail: `MCP server ${review.server}: ${review.reason}` } : { label: "On", tone: "success", detail: "" };
    }
    case "built-in": return row.enabled ? { label: "On", tone: "success", detail: "" } : { label: "Off", tone: "warning", detail: "" };
    default: return { label: "Off", tone: "neutral", detail: "" };
  }
}

/** What the toggle does when clicked. `review` opens the prompt first; `confirm-disable` asks before turning a built-in off. */
export type ToggleIntent = "enable" | "disable" | "review" | "confirm-disable" | "none";
export function toggleIntent(row: ExtensionRowDto): ToggleIntent {
  if (row.status === "unmigrated") return "none";
  if (row.builtin) return row.enabled ? "confirm-disable" : "enable";
  if (row.status === "needs-approval") return "review";
  if (row.status === "refused") return row.enabled ? "disable" : "none";
  return row.enabled ? "disable" : "enable";
}
export const isOn = (row: ExtensionRowDto): boolean => row.enabled && row.status !== "refused" && row.status !== "needs-approval";

/** Built-ins and unmigrated entries cannot be updated from a source here. */
export const canUpdate = (row: ExtensionRowDto): boolean => !row.builtin && row.kind !== "unmigrated" && row.revision !== null;
export const canRemove = (row: ExtensionRowDto): boolean => !row.builtin;

export function importNote(report: ImportReportDto | null): string | null {
  if (!report) return null;
  const done = report.migrated.length; const skipped = report.notMigrated.length;
  if (!done && !skipped) return null;
  return `Imported ${done} item${done === 1 ? "" : "s"} from your earlier setup${skipped ? `; ${skipped} could not be migrated` : ""}.`;
}

export interface PromptView {
  title: string; repoAtCommit: string; revision: string; description: string; confirmLabel: string;
  canDo: string[]; warnings: string[];
  diff: { from: string; added: string[]; removed: string[]; changed: string[]; capabilityAdded: string[]; capabilityRemoved: string[]; patch: string; patchTruncated: boolean; hasChanges: boolean } | null;
}

export function promptView(prompt: InstallPromptDto): PromptView {
  const update = prompt.kind === "update";
  const warnings = [...prompt.warnings, ...(prompt.hiddenUnicode.length ? [`Hidden characters in ${prompt.hiddenUnicode.join(", ")}.`] : []), ...(prompt.pinned ? [] : ["Local folder: it asks again when its content changes."])];
  const d = prompt.diff;
  return {
    title: `${update ? "Update" : "Install"} ${prompt.name}${prompt.version ? ` ${prompt.version}` : ""}`,
    repoAtCommit: prompt.repoAtCommit, revision: prompt.revision, description: prompt.description, confirmLabel: update ? "Update" : "Install",
    canDo: prompt.canDo.length ? prompt.canDo : ["Nothing beyond giving the agent text instructions."], warnings,
    diff: d ? { from: shortRevision(d.fromRevision), added: d.added, removed: d.removed, changed: d.changed, capabilityAdded: d.capabilityDelta.added, capabilityRemoved: d.capabilityDelta.removed, patch: d.patch ?? "", patchTruncated: d.patchTruncated === true,
      hasChanges: d.added.length + d.removed.length + d.changed.length + d.capabilityDelta.added.length + d.capabilityDelta.removed.length > 0 } : null,
  };
}

/** What the person typed, checked before any request. Returns an error line or null. */
export function sourceProblem(input: string): string | null {
  const text = input.trim();
  if (!text) return "Enter a repository such as owner/repo, or a git URL.";
  if (/^(ssh:|git@|git:|http:|file:)/i.test(text)) return "Use an https:// URL or owner/repo.";
  if (/\s/.test(text)) return "A source cannot contain spaces.";
  return null;
}

/** One-line wording for failures the person can act on. */
export function failureLine(code: string | undefined, message: string): string {
  if (code === "review_mismatch") return "It changed since you reviewed it. Review it again.";
  if (code === "needs_approval") return "Review it before turning it on.";
  return message;
}

/** Split a typed command into words. Single and double quotes group; there is no other shell syntax. */
export function splitCommand(text: string): string[] {
  return (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(word => word.replace(/^(["'])(.*)\1$/, "$2"));
}
const isUrl = (text: string) => /^https?:\/\//i.test(text.trim());

/** The Add MCP server form checked before any request. Returns an error line or null. */
export function mcpDraftProblem(name: string, target: string): string | null {
  if (!/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/.test(name.trim())) return "Name it with lowercase letters, digits and . _ - (start with a letter).";
  if (!target.trim()) return "Enter a command or an https URL.";
  if (isUrl(target) && !/^https:\/\//i.test(target.trim())) return "A URL must start with https://.";
  if (isUrl(target) && /\s/.test(target.trim())) return "A URL cannot contain spaces.";
  return null;
}

/** `https://…` is a remote server; anything else is a command line. */
export function mcpDraftInput(name: string, target: string): { mcp: { name: string; command?: string; args?: string[]; url?: string } } {
  if (isUrl(target)) return { mcp: { name: name.trim(), url: target.trim() } };
  const [command = "", ...args] = splitCommand(target);
  return { mcp: { name: name.trim(), command, args } };
}
