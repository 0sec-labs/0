import type { ConsoleSessionSnapshot } from "@0/engine/shared";

/** A first-class visual produced by the `visualize` tool (see the `visual` console event). */
export interface VisualItem {
  id: string;
  version: number;
  kind: string;
  title: string;
  caption?: string;
  summary: string;
  /** Declarative spec (or mermaid source text). Untrusted; the renderer re-validates it. */
  spec: unknown;
  createdAt?: string;
  turnId?: string;
  workerId?: string;
  pinned?: boolean;
}

const str = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Never trust persisted or remote data: returns undefined unless the minimum shape is present. */
export function parseVisual(raw: unknown, fallbackId?: string): VisualItem | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id, 200) || fallbackId;
  const kind = str(raw.kind, 40);
  const summary = str(raw.summary, 2000);
  const spec = raw.spec !== undefined ? raw.spec : raw.source;
  if (!id || !kind || summary === undefined || spec === undefined || spec === null) return undefined;
  return {
    id, kind, summary, spec,
    version: typeof raw.version === "number" && Number.isFinite(raw.version) ? raw.version : 1,
    title: str(raw.title, 200) || "Visualization",
    ...(str(raw.caption, 1000) ? { caption: str(raw.caption, 1000) } : {}),
    ...(str(raw.createdAt, 64) ? { createdAt: str(raw.createdAt, 64) } : {}),
    ...(str(raw.turnId, 200) ? { turnId: str(raw.turnId, 200) } : {}),
    ...(str(raw.workerId, 200) ? { workerId: str(raw.workerId, 200) } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
  };
}

/** Content identity used to match the same visual seen as a saved tool call and as a live event. */
export const visualSignature = (visual: Pick<VisualItem, "kind" | "title" | "summary">) => `${visual.kind}\u0000${visual.title}\u0000${visual.summary}`;

/** Visual carried by a `visual` event; unknown event types and malformed payloads yield undefined. */
export function visualFromEvent(event: { type: string }): VisualItem | undefined {
  if (event.type !== "visual") return undefined;
  const payload = (event as { visual?: unknown }).visual;
  return parseVisual(payload);
}

export const VISUALIZE_TOOL = "visualize";

/** Visual described by a saved `visualize` tool call; `id` is the tool_use id. */
export function visualFromToolCall(id: string, input: unknown): VisualItem | undefined {
  return isRecord(input) ? parseVisual({ ...input, id }) : undefined;
}

/** Every visual in a snapshot (saved messages first, then events not already represented), in order. */
export function visualsFromSnapshot(snapshot: ConsoleSessionSnapshot): VisualItem[] {
  const visuals: VisualItem[] = [];
  for (const message of snapshot.messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content)
      if (block.type === "tool_use" && block.name === VISUALIZE_TOOL) {
        const visual = visualFromToolCall(block.id, block.input);
        if (visual) visuals.push(visual);
      }
  }
  const unmatched = [...visuals];
  for (const event of snapshot.events) {
    const visual = visualFromEvent(event);
    if (!visual) continue;
    const signature = visualSignature(visual);
    const index = unmatched.findIndex(item => visualSignature(item) === signature);
    if (index >= 0) { unmatched.splice(index, 1); continue; }
    if (!visuals.some(item => item.id === visual.id)) visuals.push(visual);
  }
  return visuals;
}

/** Composer text that quotes a visual (and optionally one of its nodes) so the operator can ask about it. */
export function visualReference(visual: Pick<VisualItem, "id" | "title">, node?: string): string {
  const label = node ? `${node} in "${visual.title}"` : `"${visual.title}"`;
  return `Regarding ${label} (visual ${visual.id}): `;
}

/** Flat spec for `<Visualization spec />`: kind/title/summary merged with the tool's `spec` (or mermaid `source`). */
export function visualRenderSpec(visual: VisualItem): Record<string, unknown> {
  const inner = typeof visual.spec === "string" ? { source: visual.spec } : isRecord(visual.spec) ? visual.spec : {};
  return { ...inner, kind: visual.kind, title: visual.title, summary: visual.summary };
}
