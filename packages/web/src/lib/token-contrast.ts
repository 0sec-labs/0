import { contrast, mixSrgb } from "./color-themes";

export type TokenMap = Record<string, string>;
export interface ContrastPair { text: string; surface: string; min: number }

/** Body text and the surfaces it sits on, with the WCAG AA minimum each pair must reach. --muted-foreground-3 is decorative (disabled, hairline icons) and not text. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...["--background", "--panel", "--card", "--popover", "--card-hover"].flatMap(surface => [
    { text: "--foreground", surface, min: 4.5 },
    { text: "--muted-foreground-1", surface, min: 4.5 },
    { text: "--muted-foreground-2", surface, min: 4.5 },
    { text: "--primary-ink", surface, min: 4.5 },
  ]),
  { text: "--primary-foreground", surface: "--primary", min: 4.5 },
];

/** Resolves `var(--x)` references and `color-mix(in <space>, a N%, b)` (computed in sRGB, within a point of the browser's oklch mix) to a plain colour. */
export function resolveToken(name: string, tokens: TokenMap, depth = 0): string {
  const raw = tokens[name];
  if (raw === undefined || depth > 8) throw new Error(`unresolved token ${name}`);
  const value = raw.replace(/var\((--[\w-]+)\)/g, (_, ref: string) => resolveToken(ref, tokens, depth + 1));
  const mix = /^color-mix\(in \w+,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(value.trim());
  return mix ? mixSrgb(mix[1]!, mix[3]!, Number(mix[2])) : value.trim();
}

export function contrastReport(tokens: TokenMap, pairs: readonly ContrastPair[] = CONTRAST_PAIRS) {
  return pairs.map(pair => ({ ...pair, ratio: contrast(resolveToken(pair.text, tokens), resolveToken(pair.surface, tokens)) }));
}
