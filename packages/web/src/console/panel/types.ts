import type { ConsoleSessionSnapshot, ConsoleWorker } from "@0/engine/shared";

/** Views with a fixed identity. `agents` is the worker list, `tools` the available-tool catalog. */
export const STATIC_VIEW_IDS = ["overview", "findings", "evidence", "fixes", "browser", "visuals", "preview", "report", "agents", "tools"] as const;
export type StaticViewId = (typeof STATIC_VIEW_IDS)[number];

/** One dockable view. `agent:<workerId>` and `finding:<fingerprint>` are per-entity views. */
export type PanelViewId = StaticViewId | `agent:${string}` | `finding:${string}`;
export type PanelViewKind = StaticViewId | "agent" | "finding";

export function isStaticViewId(value: string): value is StaticViewId {
  return (STATIC_VIEW_IDS as readonly string[]).includes(value);
}
export const agentViewId = (workerId: string): PanelViewId => `agent:${workerId}`;
export const findingViewId = (fingerprint: string): PanelViewId => `finding:${fingerprint}`;

/** Narrow an untrusted string (saved state, URL) to a view id, or undefined. */
export function parsePanelViewId(value: unknown): PanelViewId | undefined {
  if (typeof value !== "string") return undefined;
  if (isStaticViewId(value)) return value;
  const match = /^(agent|finding):(.+)$/.exec(value);
  return match ? (value as PanelViewId) : undefined;
}
export function panelViewKind(id: PanelViewId): PanelViewKind {
  return id.startsWith("agent:") ? "agent" : id.startsWith("finding:") ? "finding" : (id as StaticViewId);
}
/** The entity part of `agent:<id>` / `finding:<id>`, otherwise undefined. */
export function panelViewEntity(id: PanelViewId): string | undefined {
  const index = id.indexOf(":");
  return index < 0 ? undefined : id.slice(index + 1);
}

/** Options for opening a view from anywhere in a view (jump from Overview to Findings, etc). */
export type OpenViewOptions = { title?: string; activate?: boolean };

/**
 * Props every registered view component receives. Views never touch Dockview; they ask the host to open
 * other views through `openView`.
 */
export type PanelViewProps = {
  viewId: PanelViewId;
  /** Undefined until the first snapshot arrives. */
  snapshot: ConsoleSessionSnapshot | undefined;
  sessionId: string | undefined;
  backendId: string;
  /** True while the agent run is in flight (submitting, working or cancelling). */
  busy: boolean;
  openView: (id: PanelViewId, options?: OpenViewOptions) => void;
  closeView: (id: PanelViewId) => void;
};
export type PanelViewComponent = (props: PanelViewProps) => import("react").ReactNode;

/** Worker summary used by the `+` menu Agents section. Derive from `snapshot.workers`. */
export type PanelAgentSummary = Pick<ConsoleWorker, "id" | "name" | "task" | "status">;
