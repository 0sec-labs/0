import { useMemo } from "react";
import { formatValue, niceTicks, pieSlices, yDomain } from "./chart-model";
import { PALETTE } from "./export";
import type { ChartSpec } from "./types";

const W = 640;
const H = 320;
const M = { top: 16, right: 16, bottom: 56, left: 52 };
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function Legend({ names, y }: { names: string[]; y: number }) {
  let x = M.left;
  return (
    <g aria-hidden="true">
      {names.map((name, i) => {
        const at = x;
        x += clip(name, 18).length * 6.4 + 34;
        return (
          <g key={i} transform={`translate(${at} ${y})`}>
            <rect width={10} height={10} rx={2} style={{ fill: PALETTE[i % PALETTE.length] }} />
            <text x={15} y={9} fontSize={11} className="fill-muted-foreground">{clip(name, 18)}</text>
          </g>
        );
      })}
    </g>
  );
}

function Cartesian({ spec }: { spec: ChartSpec }) {
  const domain = yDomain(spec);
  const { ticks, min, max } = niceTicks(domain.min, domain.max);
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const y = (value: number) => M.top + plotH - ((value - min) / (max - min || 1)) * plotH;
  const count = spec.categories.length;
  const band = plotW / count;
  const stacked = spec.chartType === "stacked";
  const bar = spec.chartType === "bar" ? band * 0.7 / spec.series.length : band * 0.6;
  const labelEvery = Math.ceil(count / Math.max(1, Math.floor(plotW / 56)));
  return (
    <g>
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={M.left} x2={W - M.right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? "stroke-muted-foreground" : "stroke-border"} strokeWidth={tick === 0 ? 1 : 0.75} />
          <text x={M.left - 8} y={y(tick) + 4} textAnchor="end" fontSize={10.5} className="fill-muted-foreground">{formatValue(tick, spec.unit)}</text>
        </g>
      ))}
      {spec.categories.map((category, i) => i % labelEvery === 0 && (
        <text key={i} x={M.left + band * i + band / 2} y={H - M.bottom + 16} textAnchor="middle" fontSize={10.5} className="fill-muted-foreground">{clip(category, Math.max(6, Math.floor(band / 6)))}</text>
      ))}
      {spec.chartType === "line"
        ? spec.series.map((series, s) => {
            const color = PALETTE[s % PALETTE.length];
            const points = series.data.map((value, i) => [M.left + band * i + band / 2, y(value)] as const);
            return (
              <g key={s}>
                <polyline points={points.map(([px, py]) => `${px},${py}`).join(" ")} fill="none" strokeWidth={2} strokeLinejoin="round" style={{ stroke: color }} />
                {points.map(([px, py], i) => <circle key={i} cx={px} cy={py} r={3.5} className="stroke-card" strokeWidth={1.5} style={{ fill: color }}><title>{`${series.name}, ${spec.categories[i]}: ${formatValue(series.data[i]!, spec.unit)}`}</title></circle>)}
              </g>
            );
          })
        : spec.categories.map((category, i) => {
            let base = 0;
            return (
              <g key={i}>
                {spec.series.map((series, s) => {
                  const value = series.data[i]!;
                  const top = stacked ? base + value : value;
                  const from = stacked ? base : 0;
                  if (stacked) base += value;
                  const px = stacked ? M.left + band * i + (band - bar) / 2 : M.left + band * i + band * 0.15 + bar * s;
                  const y1 = y(Math.max(top, from));
                  const y2 = y(Math.min(top, from));
                  return (
                    <rect key={s} x={px} y={y1} width={Math.max(1, bar - (stacked ? 0 : 2))} height={Math.max(1, y2 - y1)} rx={2} style={{ fill: PALETTE[s % PALETTE.length] }}>
                      <title>{`${series.name}, ${category}: ${formatValue(value, spec.unit)}`}</title>
                    </rect>
                  );
                })}
              </g>
            );
          })}
      {spec.series.length > 1 && <Legend names={spec.series.map((s) => s.name)} y={H - 16} />}
    </g>
  );
}

function Pie({ spec }: { spec: ChartSpec }) {
  const slices = useMemo(() => pieSlices(spec.categories, spec.series[0]!.data, 150, H / 2, 120), [spec]);
  const total = spec.series[0]!.data.reduce((sum, v) => sum + v, 0);
  return (
    <g>
      {slices.map((slice, i) => (
        <path key={i} d={slice.path} className="stroke-card" strokeWidth={1.5} style={{ fill: PALETTE[i % PALETTE.length] }}>
          <title>{`${slice.label}: ${formatValue(slice.value, spec.unit)} (${Math.round(slice.fraction * 100)}%)`}</title>
        </path>
      ))}
      <g aria-hidden="true">
        {slices.map((slice, i) => (
          <g key={i} transform={`translate(300 ${24 + i * 22})`}>
            <rect width={10} height={10} rx={2} style={{ fill: PALETTE[i % PALETTE.length] }} />
            <text x={16} y={9} fontSize={11.5} className="fill-foreground">{clip(slice.label, 28)}</text>
            <text x={W - 316} y={9} textAnchor="end" fontSize={11.5} className="fill-muted-foreground">{formatValue(slice.value, spec.unit)} · {total ? Math.round(slice.fraction * 100) : 0}%</text>
          </g>
        ))}
      </g>
    </g>
  );
}

export default function ChartView({ spec }: { spec: ChartSpec; expanded?: boolean }) {
  return (
    <div className="min-w-0">
      <svg data-viz-svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={spec.summary ?? spec.title ?? `${spec.chartType} chart`} className="mx-auto block h-auto max-w-full font-sans">
        {spec.chartType === "pie" ? <Pie spec={spec} /> : <Cartesian spec={spec} />}
      </svg>
      <details className="px-3 pb-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer rounded-sm py-1 outline-none focus-visible:outline-2 focus-visible:outline-ring">View data</summary>
        <div className="max-h-48 overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead><tr><th className="py-1 pr-3 font-semibold" scope="col" /> {spec.series.map((s, i) => <th key={i} scope="col" className="py-1 pr-3 font-semibold">{s.name}</th>)}</tr></thead>
            <tbody>
              {spec.categories.map((category, i) => (
                <tr key={i} className="border-t border-border/60">
                  <th scope="row" className="py-1 pr-3 font-normal">{category}</th>
                  {spec.series.map((s, j) => <td key={j} className="py-1 pr-3 tabular-nums">{formatValue(s.data[i]!, spec.unit)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
