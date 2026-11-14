import type { GraphSpec } from "./types";

export interface PlacedNode { id: string; x: number; y: number; width: number; height: number; layer: number; band: number }
export interface PlacedEdge { from: string; to: string; label?: string; path: string; labelX: number; labelY: number; reversed: boolean }
export interface GraphLayout { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number }

const NODE_HEIGHT = 44;
const LAYER_GAP = 72;
const NODE_GAP = 20;
const PAD = 16;
const BAND_GAP = 40;
/** Wrapping stops once the canvas is no more extreme than this ratio (either orientation). */
export const MAX_ASPECT = 3;
/** Short graphs stay on one line however wide the ratio; wrapping only starts past this extent. */
const WRAP_MIN_EXTENT = 900;
/** Inline graphs are never drawn smaller than this fraction of natural size; wider ones scroll. */
export const MIN_INLINE_SCALE = 0.6;

export function nodeWidth(label: string): number {
  return Math.min(220, Math.max(96, Math.round(label.length * 6.8 + 28)));
}

/** Layer index per node: longest path from sources, after reversing back edges so cycles cannot loop. */
export function assignLayers(ids: string[], edges: { from: string; to: string }[]): { layers: Map<string, number>; reversed: Set<number> } {
  const out = new Map<string, number[]>(ids.map((id) => [id, []]));
  edges.forEach((edge, index) => { if (edge.from !== edge.to) out.get(edge.from)!.push(index); });
  const state = new Map<string, 0 | 1 | 2>();
  const reversed = new Set<number>();
  // Iterative DFS keeps hostile 200-deep chains off the call stack.
  for (const root of ids) {
    if (state.has(root)) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const list = out.get(top.id)!;
      if (top.next >= list.length) { state.set(top.id, 2); stack.pop(); continue; }
      const index = list[top.next++]!;
      const target = edges[index]!.to;
      const seen = state.get(target);
      if (seen === 1) reversed.add(index);
      else if (seen === undefined) { state.set(target, 1); stack.push({ id: target, next: 0 }); }
    }
  }
  const forward = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  edges.forEach((edge, index) => {
    if (edge.from === edge.to) return;
    const [a, b] = reversed.has(index) ? [edge.to, edge.from] : [edge.from, edge.to];
    forward.get(a)!.push(b);
    indegree.set(b, indegree.get(b)! + 1);
  });
  const layers = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of forward.get(id)!) {
      layers.set(next, Math.max(layers.get(next)!, layers.get(id)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  return { layers, reversed };
}

export function layoutGraph(spec: Pick<GraphSpec, "nodes" | "edges" | "direction">): GraphLayout {
  const ids = spec.nodes.map((node) => node.id);
  const { layers, reversed } = assignLayers(ids, spec.edges);
  const depth = Math.max(0, ...layers.values()) + 1;
  const columns: string[][] = Array.from({ length: depth }, () => []);
  for (const id of ids) columns[layers.get(id)!]!.push(id);

  // A few barycenter sweeps reduce crossings.
  const neighbours = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of spec.edges) { neighbours.get(edge.from)!.push(edge.to); neighbours.get(edge.to)!.push(edge.from); }
  const position = new Map<string, number>();
  const reindex = () => columns.forEach((column) => column.forEach((id, i) => position.set(id, i)));
  reindex();
  const sweep = (order: number[], pivot: (layer: number) => number) => {
    for (const l of order) {
      const column = columns[l]!;
      const score = new Map(column.map((id) => {
        const adjacent = neighbours.get(id)!.filter((n) => layers.get(n) === pivot(l));
        return [id, adjacent.length ? adjacent.reduce((sum, n) => sum + position.get(n)!, 0) / adjacent.length : position.get(id)!] as const;
      }));
      column.sort((a, b) => score.get(a)! - score.get(b)!);
      column.forEach((id, i) => position.set(id, i));
    }
  };
  const down = Array.from({ length: Math.max(0, depth - 1) }, (_, i) => i + 1);
  for (let pass = 0; pass < 4; pass++) { sweep(down, (l) => l - 1); sweep([...down].reverse().map((l) => l - 1), (l) => l + 1); }

  const horizontal = spec.direction !== "TB";
  const labels = new Map(spec.nodes.map((node) => [node.id, node.label]));
  const size = (id: string) => ({ width: nodeWidth(labels.get(id)!), height: NODE_HEIGHT });
  // Cross-axis extent of each column, then centre columns on the widest one.
  const crossExtent = columns.map((column) => column.reduce((sum, id) => sum + (horizontal ? NODE_HEIGHT : size(id).width) + NODE_GAP, -NODE_GAP));
  const maxCross = Math.max(0, ...crossExtent);
  const layerExtent = columns.map((column) => Math.max(0, ...column.map((id) => (horizontal ? size(id).width : NODE_HEIGHT))));
  // Long chains wrap into bands (rows when horizontal, columns when TB) so the canvas stays near a readable aspect ratio.
  const place = (perBand: number) => {
    const placedNodes = new Map<string, PlacedNode>();
    let alongEnd = 0;
    let bandOffset = PAD;
    for (let start = 0, band = 0; start < columns.length; start += perBand, band++) {
      const slice = columns.slice(start, start + perBand);
      const bandCross = Math.max(0, ...slice.map((_, i) => crossExtent[start + i]!));
      let along = PAD;
      slice.forEach((column, i) => {
        const layer = start + i;
        let cross = bandOffset + (bandCross - crossExtent[layer]!) / 2;
        for (const id of column) {
          const { width, height } = size(id);
          placedNodes.set(id, horizontal
            ? { id, layer, band, width, height, x: along + (layerExtent[layer]! - width) / 2, y: cross }
            : { id, layer, band, width, height, x: cross, y: along });
          cross += (horizontal ? height : width) + NODE_GAP;
        }
        along += layerExtent[layer]! + LAYER_GAP;
      });
      alongEnd = Math.max(alongEnd, along - LAYER_GAP + PAD);
      bandOffset += bandCross + BAND_GAP;
    }
    const crossEnd = bandOffset - BAND_GAP + PAD;
    return { placedNodes, width: horizontal ? alongEnd : crossEnd, height: horizontal ? crossEnd : alongEnd };
  };
  const ratio = (r: { width: number; height: number }) => Math.max(r.width / r.height, r.height / r.width);
  let chosen = place(depth);
  if (ratio(chosen) > MAX_ASPECT && Math.max(chosen.width, chosen.height) > WRAP_MIN_EXTENT) {
    // Fewest bands that fit the aspect limit; otherwise the most balanced attempt.
    let best = Infinity;
    for (let perBand = depth - 1; perBand >= 1; perBand--) {
      const attempt = place(perBand);
      const r = ratio(attempt);
      if (r < best) { best = r; chosen = attempt; }
      if (r <= MAX_ASPECT) break;
    }
  }
  const placed = chosen.placedNodes;

  const edges: PlacedEdge[] = spec.edges.map((edge, index) => {
    const a = placed.get(edge.from)!;
    const b = placed.get(edge.to)!;
    let path: string;
    let labelX: number;
    let labelY: number;
    if (a === b) {
      const x = a.x + a.width;
      const y = a.y + a.height / 2;
      path = `M ${x} ${y - 8} C ${x + 36} ${y - 24}, ${x + 36} ${y + 24}, ${x} ${y + 8}`;
      labelX = x + 40; labelY = y;
    } else if (a.band !== b.band) {
      const y1 = a.y + a.height;
      const y2 = b.y;
      const x1 = a.x + a.width / 2;
      const x2 = b.x + b.width / 2;
      const bend = Math.max(40, Math.abs(y2 - y1) / 2);
      path = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
      labelX = (x1 + x2) / 2; labelY = (y1 + y2) / 2;
    } else if (horizontal) {
      const forwardEdge = a.x + a.width <= b.x;
      const x1 = forwardEdge ? a.x + a.width : a.x;
      const x2 = forwardEdge ? b.x : b.x + b.width;
      const y1 = a.y + a.height / 2;
      const y2 = b.y + b.height / 2;
      const bend = Math.max(24, Math.abs(x2 - x1) / 2) * (forwardEdge ? 1 : -1);
      path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
      labelX = (x1 + x2) / 2; labelY = (y1 + y2) / 2 - 6;
    } else {
      const forwardEdge = a.y + a.height <= b.y;
      const y1 = forwardEdge ? a.y + a.height : a.y;
      const y2 = forwardEdge ? b.y : b.y + b.height;
      const x1 = a.x + a.width / 2;
      const x2 = b.x + b.width / 2;
      const bend = Math.max(24, Math.abs(y2 - y1) / 2) * (forwardEdge ? 1 : -1);
      path = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
      labelX = (x1 + x2) / 2 + 6; labelY = (y1 + y2) / 2;
    }
    return { from: edge.from, to: edge.to, label: edge.label, path, labelX, labelY, reversed: reversed.has(index) };
  });

  return { nodes: ids.map((id) => placed.get(id)!), edges, width: chosen.width, height: chosen.height };
}
