/**
 * Inline visualization contract shared by the engine (`visualize` tool), the
 * console gateway (`visual` event) and the web renderers.
 *
 * Declarative data in, renderer-owned markup out: a spec carries NO executable
 * or linkable content. Every string is plain text. Anything that looks like
 * HTML, a URL/scheme, a control character or a bidi override is rejected (not
 * silently rewritten) so the model gets an actionable error and retries. The
 * renderer must STILL treat all fields as untrusted text.
 *
 * `ref` is the only link target and is a symbolic id the app resolves against
 * its own records; it is never a URL.
 */
import { z } from "zod";

export const VISUALIZATION_VERSION = 1 as const;

/** Hard caps. Validation fails (never truncates) when exceeded. */
export const VISUALIZATION_LIMITS = Object.freeze({
  specBytes: 64 * 1024,
  graphNodes: 200,
  graphEdges: 400,
  graphGroups: 30,
  chartSeries: 12,
  chartPointsPerSeries: 500,
  chartPointsTotal: 2000,
  timelineEvents: 200,
  tableColumns: 20,
  tableRows: 500,
  mermaidBytes: 10_000,
  title: 120,
  caption: 300,
  summary: 600,
  label: 80,
  detail: 400,
  cell: 500,
  idLength: 64,
  perSession: 200,
});

export const VISUALIZATION_KINDS = ["graph", "attack-graph", "chart", "timeline", "table", "mermaid"] as const;
export type VisualizationKind = (typeof VISUALIZATION_KINDS)[number];

export const VISUAL_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const GRAPH_NODE_TYPES = ["host", "service", "identity", "vuln", "asset", "step", "datastore", "external"] as const;
export const GRAPH_EDGE_KINDS = ["exploits", "reaches", "authenticates", "pivots", "calls"] as const;

// ── plain-text policy ─────────────────────────────────────────────────────

// C0/C1 controls (tab/newline allowed only where `multiline`), DEL, zero-width
// and bidi embedding/override/isolate characters, BOM, line/paragraph separators.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const CONTROL_CHARS_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
// `<` before a letter, `/`, `!` or `?` opens a tag/comment/PI. Also numeric/named entities.
const HTML_LIKE = /<[a-zA-Z/!?]|&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]{2,8});/;
// Any `scheme://`, and the script-capable schemes without slashes.
const URL_LIKE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|(?<![\w-])(?:javascript|vbscript)\s*:|(?<![\w-])data:\s*[\w.+-]+\/[\w.+-]+|(?<![\w-])data:[^\s]*;base64|(?<![\w.-])www\./i;

/** Returns a reason the text is not acceptable plain text, or null. */
export function plainTextProblem(text: string, opts: { multiline?: boolean } = {}): string | null {
  if ((opts.multiline ? CONTROL_CHARS_MULTILINE : CONTROL_CHARS).test(text)) return "contains control, zero-width or bidi-override characters";
  if (HTML_LIKE.test(text)) return "contains HTML-like markup or entities (send plain text; write '<' as the word 'less than' or drop it)";
  if (URL_LIKE.test(text)) return "contains a URL or scheme (use a host name, path or symbolic id instead of a link)";
  return null;
}

function text(max: number, opts: { multiline?: boolean; min?: number } = {}) {
  return z
    .string()
    .min(opts.min ?? 0)
    .max(max)
    .superRefine((value, ctx) => {
      const problem = plainTextProblem(value, opts);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    });
}

const L = VISUALIZATION_LIMITS;
const id = z.string().regex(/^[A-Za-z0-9_.:-]+$/, "ids use letters, digits, _ . : - only").min(1).max(L.idLength);
const label = text(L.label, { min: 1 });
const severity = z.enum(VISUAL_SEVERITIES);

// ── specs ─────────────────────────────────────────────────────────────────

export const graphSpecSchema = z
  .object({
    layout: z.enum(["layered", "force", "radial"]).default("layered"),
    direction: z.enum(["LR", "TB"]).default("LR"),
    nodes: z
      .array(
        z.strictObject({
          id,
          label,
          type: z.enum(GRAPH_NODE_TYPES).optional(),
          severity: severity.optional(),
          detail: text(L.detail, { multiline: true }).optional(),
          ref: z
            .strictObject({
              findingId: id.optional(),
              file: text(300, { min: 1 }).optional(),
              agentId: id.optional(),
            })
            .refine((r) => Object.values(r).filter((v) => v !== undefined).length === 1, "ref needs exactly one of findingId, file, agentId")
            .optional(),
        }),
      )
      .min(1)
      .max(L.graphNodes),
    edges: z
      .array(
        z.strictObject({
          from: id,
          to: id,
          label: text(40).optional(),
          kind: z.enum(GRAPH_EDGE_KINDS).optional(),
          order: z.number().int().min(1).max(1000).optional(),
        }),
      )
      .max(L.graphEdges)
      .default([]),
    groups: z
      .array(z.strictObject({ id, label, nodes: z.array(id).min(1).max(L.graphNodes) }))
      .max(L.graphGroups)
      .optional(),
  })
  .strip()
  .superRefine((spec, ctx) => {
    const ids = new Set<string>();
    spec.nodes.forEach((node, index) => {
      if (ids.has(node.id)) ctx.addIssue({ code: "custom", path: ["nodes", index, "id"], message: `duplicate node id "${node.id}"` });
      ids.add(node.id);
    });
    spec.edges.forEach((edge, index) => {
      for (const end of ["from", "to"] as const) {
        if (!ids.has(edge[end])) ctx.addIssue({ code: "custom", path: ["edges", index, end], message: `edge ${end} "${edge[end]}" is not a node id` });
      }
    });
    spec.groups?.forEach((group, index) => {
      for (const member of group.nodes) {
        if (!ids.has(member)) ctx.addIssue({ code: "custom", path: ["groups", index, "nodes"], message: `group member "${member}" is not a node id` });
      }
    });
  });

const chartPoint = z.strictObject({ x: z.union([text(L.label, { min: 1 }), z.number().finite()]), y: z.number().finite() });

export const chartSpecSchema = z
  .object({
    type: z.enum(["bar", "line", "area", "pie", "stacked"]),
    xLabel: text(L.label).optional(),
    yLabel: text(L.label).optional(),
    unit: text(16).optional(),
    series: z
      .array(z.strictObject({ name: label, data: z.array(chartPoint).min(1).max(L.chartPointsPerSeries) }))
      .min(1)
      .max(L.chartSeries),
  })
  .strip()
  .superRefine((spec, ctx) => {
    const total = spec.series.reduce((sum, s) => sum + s.data.length, 0);
    if (total > L.chartPointsTotal) ctx.addIssue({ code: "custom", path: ["series"], message: `at most ${L.chartPointsTotal} points in total (got ${total})` });
    if (spec.type === "pie" && spec.series.length !== 1) ctx.addIssue({ code: "custom", path: ["series"], message: "pie charts take exactly one series" });
    if (spec.type === "pie" && spec.series[0]?.data.some((p) => p.y < 0)) ctx.addIssue({ code: "custom", path: ["series"], message: "pie values must be non-negative" });
  });

export const timelineSpecSchema = z
  .object({
    events: z
      .array(
        z.strictObject({
          t: text(40, { min: 1 }),
          label,
          detail: text(L.detail, { multiline: true }).optional(),
          kind: text(32).optional(),
          severity: severity.optional(),
        }),
      )
      .min(1)
      .max(L.timelineEvents),
  })
  .strip();

export const tableSpecSchema = z
  .object({
    columns: z
      .array(
        z.strictObject({
          key: z.string().regex(/^[A-Za-z0-9_-]+$/, "column keys use letters, digits, _ - only").min(1).max(32),
          label,
          align: z.enum(["left", "right", "center"]).optional(),
          type: z.enum(["text", "number", "severity", "code"]).optional(),
        }),
      )
      .min(1)
      .max(L.tableColumns),
    rows: z
      .array(z.record(z.string(), z.union([text(L.cell, { multiline: true }), z.number().finite(), z.boolean(), z.null()])))
      .min(1)
      .max(L.tableRows),
  })
  .strip()
  .superRefine((spec, ctx) => {
    const keys = new Set<string>();
    spec.columns.forEach((column, index) => {
      if (keys.has(column.key)) ctx.addIssue({ code: "custom", path: ["columns", index, "key"], message: `duplicate column key "${column.key}"` });
      keys.add(column.key);
    });
    spec.rows.forEach((row, index) => {
      for (const key of Object.keys(row)) {
        if (!keys.has(key)) ctx.addIssue({ code: "custom", path: ["rows", index, key], message: `cell "${key}" has no matching column` });
      }
    });
  });

// Mermaid constructs that load content, run code, or escape strict mode.
const MERMAID_DENY: Array<[RegExp, string]> = [
  [/^\s*---/, "no YAML frontmatter"],
  [/%%\s*\{/, "no %%{init}%% directives"],
  [/@\{/, "no @{ } shape/metadata blocks"],
  [/(^|\s)(click|callback|link|links)\s/i, "no click/link/callback interactions"],
  [/\b(?:img|image|icon)\b\s*[:@\[]/i, "no images or icons"],
];

export const mermaidSpecSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .superRefine((source, ctx) => {
        if (new TextEncoder().encode(source).length > L.mermaidBytes) ctx.addIssue({ code: "custom", message: `mermaid source must be at most ${L.mermaidBytes} bytes` });
        const problem = plainTextProblem(source, { multiline: true });
        if (problem) ctx.addIssue({ code: "custom", message: problem });
        for (const [pattern, reason] of MERMAID_DENY) if (pattern.test(source)) ctx.addIssue({ code: "custom", message: reason });
      }),
  })
  .strip();

export type GraphSpec = z.infer<typeof graphSpecSchema>;
export type ChartSpec = z.infer<typeof chartSpecSchema>;
export type TimelineSpec = z.infer<typeof timelineSpecSchema>;
export type TableSpec = z.infer<typeof tableSpecSchema>;
export type MermaidSpec = z.infer<typeof mermaidSpecSchema>;

const SPEC_SCHEMAS = {
  graph: graphSpecSchema,
  "attack-graph": graphSpecSchema,
  chart: chartSpecSchema,
  timeline: timelineSpecSchema,
  table: tableSpecSchema,
  mermaid: mermaidSpecSchema,
} as const;

// ── envelope ──────────────────────────────────────────────────────────────

const envelopeFields = {
  title: text(L.title, { min: 1 }),
  caption: text(L.caption).optional(),
  /** Required alt text: what the visual shows and its main conclusion. */
  summary: text(L.summary, { min: 1, multiline: true }),
};

/** Arguments of the `visualize` tool. `spec` is validated per `kind`. */
export const visualizationInputSchema = z.strictObject({
  kind: z.enum(VISUALIZATION_KINDS),
  ...envelopeFields,
  spec: z.unknown(),
});

export type VisualizationSpec = GraphSpec | ChartSpec | TimelineSpec | TableSpec | MermaidSpec;

/** The value carried by the `visual` event and persisted as the `visualize` tool input. */
export interface Visualization {
  id: string;
  version: typeof VISUALIZATION_VERSION;
  kind: VisualizationKind;
  title: string;
  caption?: string;
  summary: string;
  spec: VisualizationSpec;
  createdAt: string;
}

export type VisualizationInput = Pick<Visualization, "kind" | "title" | "caption" | "summary" | "spec">;

export type VisualizationValidation =
  | { ok: true; value: VisualizationInput; bytes: number }
  | { ok: false; error: string };

function formatIssues(error: z.ZodError, max = 8): string {
  const lines = error.issues.slice(0, max).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  if (error.issues.length > max) lines.push(`... and ${error.issues.length - max} more`);
  return lines.join("; ");
}

/**
 * Validate raw `visualize` arguments (also used by the web to re-validate a
 * persisted spec before rendering). Unknown keys inside a spec are stripped;
 * unknown top-level keys are rejected. Never throws.
 */
export function validateVisualizationInput(raw: unknown): VisualizationValidation {
  const head = visualizationInputSchema.safeParse(raw);
  if (!head.success) return { ok: false, error: `Invalid visualization: ${formatIssues(head.error)}.` };
  const { kind, spec: rawSpec, ...rest } = head.data;
  let bytes: number;
  try {
    const json = JSON.stringify(rawSpec);
    if (json === undefined) return { ok: false, error: "Invalid visualization: spec: required." };
    bytes = new TextEncoder().encode(json).length;
  } catch {
    return { ok: false, error: "Invalid visualization: spec: must be JSON-serializable." };
  }
  if (bytes > L.specBytes) return { ok: false, error: `Invalid visualization: spec is ${bytes} bytes; the limit is ${L.specBytes}. Reduce nodes/rows or split it into several visuals.` };
  const parsed = SPEC_SCHEMAS[kind].safeParse(rawSpec);
  if (!parsed.success) return { ok: false, error: `Invalid ${kind} spec: ${formatIssues(parsed.error)}.` };
  const value: VisualizationInput = { kind, title: rest.title, summary: rest.summary, spec: parsed.data };
  if (rest.caption !== undefined) value.caption = rest.caption;
  return { ok: true, value, bytes };
}

/** Validate a full persisted/emitted visualization (envelope + id/version). */
export function validateVisualization(raw: unknown): { ok: true; value: Visualization } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Invalid visualization: not an object." };
  const { id: rawId, version, createdAt, ...input } = raw as Record<string, unknown>;
  if (version !== VISUALIZATION_VERSION) return { ok: false, error: `Unsupported visualization version ${String(version)}.` };
  if (typeof rawId !== "string" || !id.safeParse(rawId).success) return { ok: false, error: "Invalid visualization: id." };
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return { ok: false, error: "Invalid visualization: createdAt." };
  const checked = validateVisualizationInput(input);
  if (!checked.ok) return checked;
  return { ok: true, value: { id: rawId, version: VISUALIZATION_VERSION, createdAt, ...checked.value } };
}
