/**
 * The Extensions list as rows a person reads: a name, one plain sentence and a status. Pure; the page joins the extension
 * overview with connector status and the GitHub account, and this decides every word that is shown.
 */
import type { ConnectorDto, ConnectorRowDto } from "./connector-model";
import { shortRevision, statusView, type ExtensionRowDto } from "./extensions-model";
import { githubCardKind, type GitHubPublicationAccount } from "@/components/console-control/github-connection-model";

export type StatusTone = "muted" | "warning" | "danger";
export interface ItemStatus { label: string; tone: StatusTone; action: "connect" | "review" | null }
export interface ExtensionItem { name: string; title: string; sentence: string; row: ExtensionRowDto; connector: ConnectorDto | null; status: ItemStatus }

/** The first sentence of a description, cut to one line's worth. */
export function firstSentence(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const end = clean.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? clean : clean.slice(0, end + 1);
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function connectorStatus(row: ExtensionRowDto, connector: ConnectorRowDto | undefined, github: GitHubPublicationAccount | undefined): ItemStatus | null {
  if (row.name === "github" && row.enabled) {
    if (!github) return { label: "Checking…", tone: "muted", action: null };
    switch (githubCardKind(github)) {
      case "connected": return { label: "Connected", tone: "muted", action: null };
      case "needs-permissions": return { label: "Needs permissions", tone: "warning", action: "connect" };
      case "signing-in": return { label: "Signing in…", tone: "muted", action: null };
      default: return { label: "Not connected", tone: "muted", action: "connect" };
    }
  }
  if (!connector || !row.enabled) return null;
  switch (connector.status.state) {
    case "connected": return { label: "Connected", tone: "muted", action: null };
    case "needs-attention": return { label: "Needs attention", tone: "warning", action: "connect" };
    case "signing-in": return { label: "Signing in…", tone: "muted", action: null };
    case "unavailable": return { label: "Not available here", tone: "muted", action: null };
    default: return { label: "Not connected", tone: "muted", action: "connect" };
  }
}

function plainStatus(row: ExtensionRowDto): ItemStatus {
  const view = statusView(row);
  if (row.status === "needs-approval") return { label: view.label, tone: "warning", action: "review" };
  if (view.tone === "danger") return { label: view.label, tone: "danger", action: null };
  if (view.tone === "warning") return { label: view.label, tone: "warning", action: null };
  if (row.builtin) return { label: row.enabled ? "Built-in" : "Off", tone: "muted", action: null };
  return { label: row.enabled ? "On" : "Off", tone: "muted", action: null };
}

export function buildItems(rows: readonly ExtensionRowDto[], connectors: readonly ConnectorRowDto[], github: GitHubPublicationAccount | undefined): ExtensionItem[] {
  const byName = new Map(connectors.map(c => [c.extension, c] as const));
  return rows.map(row => {
    const connectorRow = byName.get(row.name);
    const connector = connectorRow?.connector ?? row.connector ?? null;
    const status = connectorStatus(row, connectorRow, github) ?? plainStatus(row);
    return { name: row.name, title: connector?.title ?? row.name, sentence: connector?.description || firstSentence(row.description), row, connector, status };
  });
}

export const matchesQuery = (item: Pick<ExtensionItem, "name" | "title" | "sentence">, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return !needle || `${item.name} ${item.title} ${item.sentence}`.toLowerCase().includes(needle);
};

const JARGON = /^connects to |cli-login|oauth-device|\bhosts?\b/i;

/** What it can read and change, in plain words, for the detail sheet. Auth method names and host lists are left out. */
export function plainAccess(item: Pick<ExtensionItem, "connector" | "row">): string[] {
  const { connector, row } = item;
  if (connector && (connector.read.length || connector.write.length)) return [...connector.read.map(r => `Read ${r}`), ...connector.write.map(w => `Change ${w}`)];
  return row.canDo.filter(line => !JARGON.test(line)).map(line => line.replace(/\s*\((text instructions|text)\)/i, "").replace(/^./, c => c.toUpperCase()));
}

/** `1.0.0`, and for installed ones the pinned commit. */
export function versionLines(row: Pick<ExtensionRowDto, "builtin" | "version" | "revision">): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  if (row.version) lines.push({ label: "Version", value: row.version });
  if (row.builtin) lines.push({ label: "Updates", value: "With 0" });
  else if (row.revision) lines.push({ label: "Pinned to", value: shortRevision(row.revision) });
  return lines;
}
