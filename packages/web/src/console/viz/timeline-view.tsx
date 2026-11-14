import { SEVERITY_COLOR, SEVERITY_LETTER } from "./export";
import type { TimelineSpec } from "./types";

const ROW = 44;
const WIDTH = 640;
const TIME_COL = 150;

export default function TimelineView({ spec }: { spec: TimelineSpec; expanded?: boolean }) {
  const height = spec.events.length * ROW + 16;
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  return (
    <div className="max-h-[28rem] overflow-auto">
      <svg data-viz-svg viewBox={`0 0 ${WIDTH} ${height}`} width={WIDTH} height={height} role="list" aria-label={spec.title ?? "Timeline"} className="mx-auto block h-auto max-w-full font-sans">
        <line x1={TIME_COL} x2={TIME_COL} y1={12} y2={height - 12} className="stroke-border" strokeWidth={2} />
        {spec.events.map((event, i) => {
          const y = 8 + i * ROW + ROW / 2;
          const color = event.severity ? SEVERITY_COLOR[event.severity] : "var(--primary)";
          return (
            <g key={i} role="listitem" aria-label={`${event.t ? `${event.t}: ` : ""}${event.label}${event.severity ? `, ${event.severity}` : ""}${event.detail ? `. ${event.detail}` : ""}`}>
              <title>{[event.t, event.label, event.detail].filter(Boolean).join(" — ")}</title>
              <text x={TIME_COL - 14} y={y + 4} textAnchor="end" fontSize={11} className="fill-muted-foreground">{clip(event.t, 22)}</text>
              <circle cx={TIME_COL} cy={y} r={6} className="stroke-card" strokeWidth={2} style={{ fill: color }} />
              <text x={TIME_COL + 16} y={event.detail ? y - 3 : y + 4} fontSize={12} fontWeight={500} className="fill-foreground">
                {event.severity ? `[${SEVERITY_LETTER[event.severity]}] ` : ""}{clip(event.label, 70)}
              </text>
              {event.detail && <text x={TIME_COL + 16} y={y + 12} fontSize={10.5} className="fill-muted-foreground">{clip(event.detail, 84)}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
