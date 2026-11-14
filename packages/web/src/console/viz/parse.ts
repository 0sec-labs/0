import {
  NODE_TYPES, SEVERITIES,
  type ChartSpec, type ChartType, type GraphSpec, type Severity, type TableCell, type TableSpec,
  type TimelineSpec, type VizKind, type VizSpec,
} from "./types";

/**
 * Aligned with the engine's VISUALIZATION_LIMITS (shared/visualization.ts). The engine rejects oversize specs;
 * this renderer additionally clamps and sanitises defensively, so a spec that slips through never overruns the DOM.
 * Engine names: specBytes, graphNodes, graphEdges, chartSeries, chartPointsPerSeries (categories), chartPointsTotal (points),
 * timelineEvents, tableColumns, tableRows, mermaidBytes, summary, label, detail.
 */
export const VIZ_LIMITS = {
  sourceChars: 64 * 1024,
  mermaidChars: 10_000,
  nodes: 200,
  edges: 400,
  columns: 20,
  rows: 500,
  events: 200,
  categories: 500,
  series: 12,
  points: 2_000,
  slices: 12,
  id: 64,
  nodeLabel: 80,
  edgeLabel: 40,
  summary: 600,
  title: 120,
  cell: 500,
  eventLabel: 120,
  eventDetail: 400,
} as const;

export type ParseResult = { ok: true; spec: VizSpec } | { ok: false; reason: string };

/** Fence languages handled by the viz registry (mermaid is rendered by its own view). */
export const VIZ_FENCES: Readonly<Record<string, VizKind>> = {
  mermaid: "mermaid",
  graph: "graph",
  "attack-graph": "graph",
  chart: "chart",
  timeline: "timeline",
  table: "table",
};
export function vizKindForFence(language: string): VizKind | undefined {
  return Object.prototype.hasOwnProperty.call(VIZ_FENCES, language) ? VIZ_FENCES[language] : undefined;
}

const fail = (reason: string): ParseResult => ({ ok: false, reason });
type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
// Control characters and bidi overrides never reach the DOM, even as text.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Plain text only: strip control/bidi characters, collapse to one line, clamp. */
export function cleanText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  const cleaned = text.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
const optText = (value: unknown, max: number): string | undefined => cleanText(value, max) || undefined;
const severityOf = (value: unknown): Severity | undefined =>
  typeof value === "string" && (SEVERITIES as readonly string[]).includes(value.toLowerCase()) ? (value.toLowerCase() as Severity) : undefined;

function listOf(value: unknown, max: number, what: string): unknown[] | string {
  if (!Array.isArray(value)) return `${what} must be an array`;
  if (value.length === 0) return `${what} is empty`;
  if (value.length > max) return `too many ${what} (${value.length} > ${max})`;
  return value;
}

function parseGraph(raw: Rec): ParseResult {
  const nodesIn = listOf(raw.nodes, VIZ_LIMITS.nodes, "nodes");
  if (typeof nodesIn === "string") return fail(nodesIn);
  const edgesIn = raw.edges === undefined ? [] : listOf(raw.edges, VIZ_LIMITS.edges, "edges");
  if (typeof edgesIn === "string") return fail(edgesIn);
  const ids = new Set<string>();
  const nodes: GraphSpec["nodes"] = [];
  for (const entry of nodesIn) {
    if (!isRec(entry)) return fail("node must be an object");
    const id = cleanText(entry.id, VIZ_LIMITS.id);
    if (!id) return fail("node id is required");
    if (ids.has(id)) return fail(`duplicate node id "${id}"`);
    ids.add(id);
    const type = typeof entry.type === "string" && (NODE_TYPES as readonly string[]).includes(entry.type) ? (entry.type as GraphSpec["nodes"][number]["type"]) : undefined;
    nodes.push({ id, label: cleanText(entry.label, VIZ_LIMITS.nodeLabel) || id, type, severity: severityOf(entry.severity) });
  }
  const edges: GraphSpec["edges"] = [];
  for (const entry of edgesIn) {
    if (!isRec(entry)) return fail("edge must be an object");
    const from = cleanText(entry.from, VIZ_LIMITS.id);
    const to = cleanText(entry.to, VIZ_LIMITS.id);
    if (!ids.has(from) || !ids.has(to)) return fail(`edge references unknown node "${ids.has(from) ? to : from}"`);
    edges.push({ from, to, label: optText(entry.label, VIZ_LIMITS.edgeLabel) });
  }
  return { ok: true, spec: { kind: "graph", title: optText(raw.title, VIZ_LIMITS.title), summary: optText(raw.summary, VIZ_LIMITS.summary), direction: raw.direction === "TB" ? "TB" : "LR", nodes, edges } };
}

const CHART_TYPES: readonly ChartType[] = ["bar", "line", "pie", "stacked"];
function parseChart(raw: Rec): ParseResult {
  const chartType = (typeof raw.type === "string" ? raw.type : raw.chartType) as ChartType;
  if (!CHART_TYPES.includes(chartType)) return fail(`chart type must be one of ${CHART_TYPES.join(", ")}`);
  const seriesIn = listOf(raw.series, VIZ_LIMITS.series, "series");
  if (typeof seriesIn === "string") return fail(seriesIn);
  const catsIn = listOf(raw.categories ?? raw.labels, VIZ_LIMITS.categories, "categories");
  if (typeof catsIn === "string") return fail(catsIn);
  const categories = catsIn.map((c) => cleanText(c, VIZ_LIMITS.nodeLabel));
  if (chartType === "pie" && categories.length > VIZ_LIMITS.slices) return fail(`too many slices (${categories.length} > ${VIZ_LIMITS.slices})`);
  if (seriesIn.length * categories.length > VIZ_LIMITS.points) return fail("too many data points");
  const series: ChartSpec["series"] = [];
  for (const entry of seriesIn) {
    if (!isRec(entry) || !Array.isArray(entry.data)) return fail("each series needs a data array");
    if (entry.data.length !== categories.length) return fail("series data length must match categories");
    const data = entry.data.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : NaN));
    if (data.some(Number.isNaN)) return fail("series data must be finite numbers");
    if ((chartType === "pie" || chartType === "stacked") && data.some((value) => value < 0)) return fail(`${chartType} charts need non-negative values`);
    series.push({ name: cleanText(entry.name, VIZ_LIMITS.nodeLabel) || `Series ${series.length + 1}`, data });
  }
  if (chartType === "pie" && series.length !== 1) return fail("pie charts take exactly one series");
  return { ok: true, spec: { kind: "chart", title: optText(raw.title, VIZ_LIMITS.title), summary: optText(raw.summary, VIZ_LIMITS.summary), chartType, unit: optText(raw.unit, 12), categories, series } };
}

function parseTimeline(raw: Rec): ParseResult {
  const eventsIn = listOf(raw.events, VIZ_LIMITS.events, "events");
  if (typeof eventsIn === "string") return fail(eventsIn);
  const events: TimelineSpec["events"] = [];
  for (const entry of eventsIn) {
    if (!isRec(entry)) return fail("event must be an object");
    const label = cleanText(entry.label, VIZ_LIMITS.eventLabel);
    if (!label) return fail("event label is required");
    events.push({ t: cleanText(entry.t ?? entry.time, 40), label, detail: optText(entry.detail, VIZ_LIMITS.eventDetail), severity: severityOf(entry.severity) });
  }
  return { ok: true, spec: { kind: "timeline", title: optText(raw.title, VIZ_LIMITS.title), summary: optText(raw.summary, VIZ_LIMITS.summary), events } };
}

function parseTable(raw: Rec): ParseResult {
  const colsIn = listOf(raw.columns, VIZ_LIMITS.columns, "columns");
  if (typeof colsIn === "string") return fail(colsIn);
  const rowsIn = raw.rows === undefined ? [] : Array.isArray(raw.rows) ? raw.rows : "rows must be an array";
  if (typeof rowsIn === "string") return fail(rowsIn);
  if (rowsIn.length > VIZ_LIMITS.rows) return fail(`too many rows (${rowsIn.length} > ${VIZ_LIMITS.rows})`);
  const columns: TableSpec["columns"] = [];
  const keys = new Set<string>();
  for (const entry of colsIn) {
    const col = typeof entry === "string" ? { key: entry, label: entry } : entry;
    if (!isRec(col)) return fail("column must be a string or object");
    const key = cleanText(col.key, VIZ_LIMITS.id);
    if (!key || keys.has(key)) return fail("column keys must be unique and non-empty");
    keys.add(key);
    columns.push({ key, label: cleanText(col.label, VIZ_LIMITS.nodeLabel) || key, align: col.align === "right" || col.align === "center" ? col.align : undefined });
  }
  const rows: TableSpec["rows"] = [];
  for (const entry of rowsIn) {
    const cells: Record<string, TableCell> = {};
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i]!;
      const value = Array.isArray(entry) ? entry[i] : isRec(entry) && Object.prototype.hasOwnProperty.call(entry, column.key) ? entry[column.key] : null;
      cells[column.key] = typeof value === "number" && Number.isFinite(value) ? value : typeof value === "boolean" ? value : value == null ? null : cleanText(value, VIZ_LIMITS.cell);
    }
    rows.push(cells);
  }
  return { ok: true, spec: { kind: "table", title: optText(raw.title, VIZ_LIMITS.title), summary: optText(raw.summary, VIZ_LIMITS.summary), columns, rows } };
}

/** Validate an already-decoded spec (e.g. a `visual` event payload). Never trusts input. */
export function validateViz(kind: string, raw: unknown): ParseResult {
  if (kind === "mermaid") {
    const source = isRec(raw) ? raw.source : raw;
    if (typeof source !== "string" || !source.trim()) return fail("mermaid source is required");
    if (source.length > VIZ_LIMITS.mermaidChars) return fail("diagram source is too large");
    const rec = isRec(raw) ? raw : {};
    return { ok: true, spec: { kind: "mermaid", title: optText(rec.title, VIZ_LIMITS.title), summary: optText(rec.summary, VIZ_LIMITS.summary), source } };
  }
  if (!isRec(raw)) return fail("spec must be a JSON object");
  switch (kind) {
    case "graph": return parseGraph(raw);
    case "chart": return parseChart(raw);
    case "timeline": return parseTimeline(raw);
    case "table": return parseTable(raw);
    default: return fail(`unsupported visualization kind "${kind.slice(0, 40)}"`);
  }
}

/** Parse a markdown fence body. Size caps are enforced BEFORE JSON.parse. */
export function parseVizFence(language: string, source: string): ParseResult {
  const kind = vizKindForFence(language);
  if (!kind) return fail("not a visualization fence");
  if (kind === "mermaid") return validateViz("mermaid", source);
  if (source.length > VIZ_LIMITS.sourceChars) return fail(`spec is too large (${source.length} > ${VIZ_LIMITS.sourceChars} characters)`);
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { return fail("spec is not valid JSON"); }
  return validateViz(kind, raw);
}

/** Text summary for alt/aria: author summary, or a generated one. */
export function describeViz(spec: VizSpec): string {
  if (spec.summary) return spec.summary;
  switch (spec.kind) {
    case "graph": return `Graph with ${spec.nodes.length} nodes and ${spec.edges.length} edges.`;
    case "chart": return `${spec.chartType} chart with ${spec.series.length} series and ${spec.categories.length} categories.`;
    case "timeline": return `Timeline of ${spec.events.length} events.`;
    case "table": return `Table with ${spec.columns.length} columns and ${spec.rows.length} rows.`;
    case "mermaid": return "Mermaid diagram.";
  }
}
