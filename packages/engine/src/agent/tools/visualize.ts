/**
 * `visualize` tool definition: render a validated, declarative visual inline in
 * the operator chat (graph / attack-graph, chart, timeline, table, mermaid).
 *
 * Authority-free: it only records display data. The runtime handler
 * (`visualize`) lives on `ToolExecutor` (agent/tools.ts); the spec contract and
 * caps live in shared/visualization.ts so the web client validates identically.
 */
import type { ToolDefinition } from "../types.js";

export const visualizeToolDefinitions: Record<string, ToolDefinition> = {
  visualize: {
    name: "visualize",
    description:
      "Show the operator an inline visual in the chat: kind = graph | attack-graph (nodes + edges, " +
      "e.g. an attack path), chart (bar|line|area|pie|stacked), timeline, table, or mermaid (sequence/flow " +
      "source). Declarative data only: all labels are PLAIN TEXT (no HTML, no URLs, no markdown); use host " +
      "names, paths or ids instead of links. Required: title and summary (what it shows and the conclusion; " +
      "used as alt text). Caps: 200 nodes, 400 edges, 500 table rows, 12 chart series, 64 KB spec; split " +
      "or aggregate larger data. Load the `visualize` skill for exact spec shapes. Errors name the offending " +
      "field; fix and retry. Shorten and never copy target-controlled text verbatim into a label.",
    parameters: {
      kind: {
        type: "string",
        description: "Visual type.",
        enum: ["graph", "attack-graph", "chart", "timeline", "table", "mermaid"],
      },
      title: { type: "string", description: "Short title (<=120 chars), plain text." },
      summary: { type: "string", description: "Required alt text (<=600 chars): what the visual shows and the key takeaway." },
      caption: { type: "string", description: "Optional one-line caption (<=300 chars)." },
      spec: {
        type: "object",
        description:
          "Kind-specific spec. graph/attack-graph: {nodes:[{id,label,type?,severity?,detail?,ref?:{findingId|file|agentId}}], " +
          "edges:[{from,to,label?,kind?,order?}], layout?, direction?, groups?}. chart: {type, series:[{name,data:[{x,y}]}], " +
          "xLabel?, yLabel?, unit?}. timeline: {events:[{t,label,detail?,kind?,severity?}]}. table: {columns:[{key,label,align?,type?}], " +
          "rows:[{<key>: string|number|boolean|null}]}. mermaid: {source}.",
      },
    },
    required: ["kind", "title", "summary", "spec"],
  },
};

export const visualizeDispatch: Record<string, string> = {
  visualize: "visualize",
};
