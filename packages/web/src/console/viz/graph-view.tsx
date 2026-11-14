import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { layoutGraph } from "./layout";
import { SEVERITY_COLOR, SEVERITY_LETTER } from "./export";
import type { GraphSpec } from "./types";

const TYPE_LABEL_MAX = 26;

export default function GraphView({ spec, expanded }: { spec: GraphSpec; expanded?: boolean }) {
  const markerId = `arrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const layout = useMemo(() => layoutGraph(spec), [spec]);
  const nodes = useMemo(() => new Map(spec.nodes.map((node) => [node.id, node])), [spec]);
  const placed = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]);
  const [selected, setSelected] = useState<string>();
  const [active, setActive] = useState(spec.nodes[0]!.id);
  const refs = useRef(new Map<string, SVGGElement>());
  const next = useMemo(() => {
    const out = new Map<string, string[]>();
    const back = new Map<string, string[]>();
    for (const edge of spec.edges) {
      (out.get(edge.from) ?? out.set(edge.from, []).get(edge.from)!).push(edge.to);
      (back.get(edge.to) ?? back.set(edge.to, []).get(edge.to)!).push(edge.from);
    }
    return { out, back };
  }, [spec]);

  const focusNode = (id: string | undefined) => {
    if (!id) return;
    setActive(id);
    refs.current.get(id)?.focus();
  };
  const onKey = (event: KeyboardEvent, id: string) => {
    const horizontal = spec.direction !== "TB";
    const forward = horizontal ? "ArrowRight" : "ArrowDown";
    const backward = horizontal ? "ArrowLeft" : "ArrowUp";
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected((cur) => (cur === id ? undefined : id)); }
    else if (event.key === "Escape") setSelected(undefined);
    else if (event.key === forward) { event.preventDefault(); focusNode(next.out.get(id)?.[0]); }
    else if (event.key === backward) { event.preventDefault(); focusNode(next.back.get(id)?.[0]); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "ArrowRight" || event.key === "ArrowLeft") {
      // Move between siblings in the same layer.
      event.preventDefault();
      const here = placed.get(id)!;
      const siblings = layout.nodes.filter((n) => n.layer === here.layer).sort((a, b) => (horizontal ? a.y - b.y : a.x - b.x));
      const index = siblings.findIndex((n) => n.id === id);
      const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
      focusNode(siblings[index + step]?.id);
    }
  };
  const related = selected ? new Set([selected, ...(next.out.get(selected) ?? []), ...(next.back.get(selected) ?? [])]) : undefined;
  const chosen = selected ? nodes.get(selected) : undefined;
  const chosenEdges = selected ? spec.edges.filter((e) => e.from === selected || e.to === selected) : [];

  return (
    <div className="min-w-0">
      <div className={expanded ? "overflow-auto" : "max-h-[28rem] overflow-auto"}>
        <svg
          data-viz-svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          role="group"
          aria-label={spec.title ? `${spec.title}: graph nodes` : "Graph nodes"}
          className="mx-auto block h-auto max-w-none font-sans text-xs"
          style={expanded ? { minWidth: "100%" } : { maxWidth: "100%" }}
        >
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
            </marker>
          </defs>
          <g fill="none">
            {layout.edges.map((edge, i) => {
              const dim = related && !(edge.from === selected || edge.to === selected);
              return (
                <g key={i} opacity={dim ? 0.2 : 1}>
                  <path d={edge.path} className="stroke-muted-foreground" strokeWidth={edge.from === selected || edge.to === selected ? 2 : 1.25} markerEnd={`url(#${markerId})`} strokeDasharray={edge.reversed ? "4 3" : undefined} />
                  {edge.label && <text x={edge.labelX} y={edge.labelY} textAnchor="middle" className="fill-muted-foreground stroke-card" strokeWidth={3} paintOrder="stroke" fontSize={10}>{edge.label}</text>}
                </g>
              );
            })}
          </g>
          {layout.nodes.map((place) => {
            const node = nodes.get(place.id)!;
            const incoming = next.back.get(node.id)?.length ?? 0;
            const outgoing = next.out.get(node.id)?.length ?? 0;
            const label = node.label.length > TYPE_LABEL_MAX + 8 ? `${node.label.slice(0, TYPE_LABEL_MAX + 7)}…` : node.label;
            const accent = node.severity ? SEVERITY_COLOR[node.severity] : "var(--border-1)";
            return (
              <g
                key={node.id}
                ref={(el) => { if (el) refs.current.set(node.id, el); else refs.current.delete(node.id); }}
                role="button"
                tabIndex={active === node.id ? 0 : -1}
                aria-pressed={selected === node.id}
                aria-label={`${node.label}${node.type ? `, ${node.type}` : ""}${node.severity ? `, ${node.severity} severity` : ""}. ${incoming} incoming, ${outgoing} outgoing.`}
                transform={`translate(${place.x} ${place.y})`}
                opacity={related && !related.has(node.id) ? 0.35 : 1}
                className="cursor-pointer outline-none [&:focus-visible>rect:first-of-type]:stroke-[var(--ring)] [&:focus-visible>rect:first-of-type]:stroke-[3px]"
                onClick={() => { setActive(node.id); setSelected((cur) => (cur === node.id ? undefined : node.id)); }}
                onFocus={() => setActive(node.id)}
                onKeyDown={(event) => onKey(event, node.id)}
              >
                <title>{node.label}</title>
                <rect width={place.width} height={place.height} rx={8} className="fill-card" style={{ stroke: selected === node.id ? "var(--primary)" : accent }} strokeWidth={selected === node.id ? 2.5 : 1.5} />
                {node.severity && <rect width={4} height={place.height - 12} x={0} y={6} rx={2} style={{ fill: accent }} />}
                {node.type && <text x={14} y={16} fontSize={9} className="fill-muted-foreground uppercase" letterSpacing={0.6}>{node.type}</text>}
                <text x={14} y={node.type ? 33 : 27} fontSize={12} fontWeight={500} className="fill-foreground">{label}</text>
                {node.severity && <text x={place.width - 12} y={16} textAnchor="end" fontSize={9} fontWeight={700} style={{ fill: accent }}>{SEVERITY_LETTER[node.severity]}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      <p aria-live="polite" className="mt-2 min-h-4 px-3 text-xs text-muted-foreground">
        {chosen
          ? `${chosen.label}${chosen.type ? ` (${chosen.type})` : ""}${chosen.severity ? ` · ${chosen.severity}` : ""}${chosenEdges.length ? ` — ${chosenEdges.map((e) => `${nodes.get(e.from)!.label} → ${nodes.get(e.to)!.label}${e.label ? ` (${e.label})` : ""}`).join("; ")}` : ""}`
          : "Select a node to highlight its connections. Arrow keys follow edges."}
      </p>
    </div>
  );
}
