import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENTS, contrastRatio, parseColor, type Rgb } from "../src/lib/appearance-model";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** Declarations of the rule(s) whose selector list contains `selector` verbatim. */
function declarations(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1]!.split(",").some((part: string) => part.trim() === selector)) continue;
    for (const decl of rule[2]!.split(";")) { const i = decl.indexOf(":"); if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim(); }
  }
  return out;
}
const rootTokens = declarations(":root");
function colorOf(value: string | undefined): Rgb {
  let text = value ?? "";
  for (let i = 0; i < 4; i++) text = text.replace(/var\((--[\w-]+)\)/g, (_, name: string) => rootTokens[name] ?? "");
  const rgb = parseColor(text);
  if (!rgb) throw new Error(`cannot parse ${value}`);
  return rgb;
}
const modes = [
  { name: "light", select: (id: string) => ({ ...declarations(`[data-accent="${id}"]`) }), surface: rootTokens["--card"] },
  { name: "dark", select: (id: string) => ({ ...declarations(`[data-accent="${id}"]`), ...declarations(`.dark [data-accent="${id}"]`) }), surface: declarations(".dark")["--card"] },
] as const;

describe("accent presets", () => {
  it("defines every token for every accent in both themes", () => {
    for (const mode of modes) for (const accent of ACCENTS) {
      const tokens = mode.select(accent.id);
      for (const token of ["--primary", "--primary-hover", "--primary-ink", "--ring", "--dither-ink", "--switch-on"]) expect(tokens[token], `${mode.name} ${accent.id} ${token}`).toBeTruthy();
    }
  });
  it("keeps white text on filled actions readable (>= 4.5:1), except the unchanged brand orange", () => {
    const white = colorOf("#ffffff");
    expect(declarations(":root")["--primary-foreground"]).toBe("#ffffff");
    for (const mode of modes) for (const accent of ACCENTS.filter(a => a.id !== "orange")) {
      expect(contrastRatio(white, colorOf(mode.select(accent.id)["--primary"])), `${mode.name} ${accent.id}`).toBeGreaterThanOrEqual(4.5);
    }
    // Orange is the pre-existing brand colour; pin it so it cannot silently get worse.
    expect(contrastRatio(white, colorOf(rootTokens["--brand-orange"]))).toBeGreaterThan(2.4);
  });
  it("keeps accent ink readable as text on the card surface (>= 4.5:1) for every accent", () => {
    for (const mode of modes) for (const accent of ACCENTS) {
      expect(contrastRatio(colorOf(mode.select(accent.id)["--primary-ink"]), colorOf(mode.surface)), `${mode.name} ${accent.id}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

