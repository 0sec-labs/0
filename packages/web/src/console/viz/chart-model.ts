import type { ChartSpec } from "./types";

/** "Nice" axis ticks covering [min, max]; always includes zero for bar-like charts. */
export function niceTicks(min: number, max: number, target = 5): { ticks: number[]; min: number; max: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0, 1], min: 0, max: 1 };
  if (min === max) { max = min + 1; if (min > 0) min = 0; }
  const rough = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = lo; value <= hi + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return { ticks, min: lo, max: hi };
}

export function yDomain(spec: Pick<ChartSpec, "chartType" | "series" | "categories">): { min: number; max: number } {
  if (spec.chartType === "stacked") {
    const totals = spec.categories.map((_, i) => spec.series.reduce((sum, s) => sum + s.data[i]!, 0));
    return { min: 0, max: Math.max(0, ...totals) };
  }
  const all = spec.series.flatMap((s) => s.data);
  const min = Math.min(...all);
  const max = Math.max(...all);
  return { min: spec.chartType === "bar" ? Math.min(0, min) : min, max: spec.chartType === "bar" ? Math.max(0, max) : max };
}

export interface Slice { label: string; value: number; fraction: number; path: string; labelAngle: number }
/** Donut-less pie slices as SVG arc paths. A lone 100% slice becomes a full circle path. */
export function pieSlices(categories: string[], data: number[], cx: number, cy: number, r: number): Slice[] {
  const total = data.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return [];
  let angle = -Math.PI / 2;
  const point = (a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  return data.flatMap((value, i) => {
    if (value <= 0) return [];
    const fraction = value / total;
    const sweep = fraction * Math.PI * 2;
    const start = angle;
    angle += sweep;
    const path = fraction >= 0.9999
      ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`
      : `M ${cx} ${cy} L ${point(start)} A ${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(angle)} Z`;
    return [{ label: categories[i]!, value, fraction, path, labelAngle: start + sweep / 2 }];
  });
}

export function formatValue(value: number, unit?: string): string {
  const text = Math.abs(value) >= 1000 ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value) : String(Number(value.toFixed(2)));
  return unit ? `${text}${unit.length > 1 ? " " : ""}${unit}` : text;
}
