import type { Severity, TableSpec, VizSpec } from "./types";
import { sanitizeSvg } from "./sanitize";

/** Categorical palette from design tokens; resolved by the browser so light/dark needs no re-render. */
export const PALETTE = [
  "var(--primary)",
  "oklch(62% .13 245)",
  "var(--success)",
  "oklch(65% .15 310)",
  "var(--warning)",
  "oklch(62% .12 195)",
  "var(--destructive)",
  "color-mix(in oklch, var(--foreground) 50%, var(--background))",
] as const;

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--destructive)",
  high: "oklch(65% .19 40)",
  medium: "var(--warning)",
  low: "oklch(62% .12 245)",
  info: "color-mix(in oklch, var(--foreground) 50%, var(--background))",
};
export const SEVERITY_LETTER: Record<Severity, string> = { critical: "C", high: "H", medium: "M", low: "L", info: "I" };

export function specToText(spec: VizSpec): string {
  if (spec.kind === "mermaid") return spec.source;
  const { kind: _kind, ...rest } = spec;
  return JSON.stringify(rest, null, 2);
}

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Neutralise spreadsheet formula injection from untrusted cells.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function tableToCsv(spec: TableSpec): string {
  return [spec.columns.map((c) => csvCell(c.label)), ...spec.rows.map((row) => spec.columns.map((c) => csvCell(row[c.key])))]
    .map((line) => line.join(",")).join("\n");
}

const STYLE_PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline"] as const;

/** Serialise a rendered SVG as a standalone file: token colours are resolved to computed values. */
export function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...svg.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  originals.forEach((original, i) => {
    const computed = getComputedStyle(original);
    const copy = copies[i] as SVGElement;
    copy.removeAttribute("class");
    copy.removeAttribute("tabindex");
    copy.removeAttribute("style");
    for (const prop of STYLE_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (value) copy.style.setProperty(prop, value);
    }
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const box = svg.viewBox.baseVal;
  if (box.width) { clone.setAttribute("width", String(box.width)); clone.setAttribute("height", String(box.height)); }
  const background = getComputedStyle(document.documentElement).getPropertyValue("--card") || "#fff";
  const backdrop = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  backdrop.setAttribute("width", "100%");
  backdrop.setAttribute("height", "100%");
  backdrop.style.fill = getComputedStyle(svg.closest("[data-slot=viz-body]") ?? document.body).backgroundColor || background;
  clone.insertBefore(backdrop, clone.firstChild);
  return sanitizeSvg(new XMLSerializer().serializeToString(clone));
}

export function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slugify(text: string | undefined, fallback: string): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || fallback;
}
