/**
 * Single import point for visualization spec types; every viz module imports only from this file.
 *
 * These are the renderer's normalised shapes (what `parse.ts` produces after clamping), a deliberate subset of the
 * engine's `shared/visualization.ts` input schema (which adds layout, groups, captions and ids). They stay local
 * because that engine module is not in the `@0/engine/shared` build this package compiles against yet, and its
 * input types are looser than the validated shapes the views rely on. Limits live in `parse.ts` (VIZ_LIMITS) and
 * mirror the engine's VISUALIZATION_LIMITS.
 */
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

export const NODE_TYPES = ["host", "service", "identity", "vuln", "asset", "step", "datastore", "external"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface GraphNode {
  id: string;
  label: string;
  type?: NodeType;
  severity?: Severity;
}
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}
export interface GraphSpec {
  kind: "graph";
  title?: string;
  summary?: string;
  direction: "LR" | "TB";
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ChartType = "bar" | "line" | "pie" | "stacked";
export interface ChartSeries {
  name: string;
  data: number[];
}
export interface ChartSpec {
  kind: "chart";
  title?: string;
  summary?: string;
  chartType: ChartType;
  unit?: string;
  /** Category labels (x axis, or pie slice names). */
  categories: string[];
  series: ChartSeries[];
}

export interface TimelineEvent {
  t: string;
  label: string;
  detail?: string;
  severity?: Severity;
}
export interface TimelineSpec {
  kind: "timeline";
  title?: string;
  summary?: string;
  events: TimelineEvent[];
}

export type TableCell = string | number | boolean | null;
export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
}
export interface TableSpec {
  kind: "table";
  title?: string;
  summary?: string;
  columns: TableColumn[];
  rows: Record<string, TableCell>[];
}

export interface MermaidSpec {
  kind: "mermaid";
  title?: string;
  summary?: string;
  source: string;
}

export type VizSpec = GraphSpec | ChartSpec | TimelineSpec | TableSpec | MermaidSpec;
export type VizKind = VizSpec["kind"];
