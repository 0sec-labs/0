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
/** Blue is the unattributed default, so its tokens are the :root (light) and .dark values; the other presets override them. */
const select = (id: string, dark: boolean) => id === "blue"
  ? { ...rootTokens, ...(dark ? declarations(".dark") : {}) }
  : { ...declarations(`[data-accent="${id}"]`), ...(dark ? declarations(`.dark [data-accent="${id}"]`) : {}) };
const modes = [
  { name: "light", select: (id: string) => select(id, false), surface: rootTokens["--card"] },
  { name: "dark", select: (id: string) => select(id, true), surface: declarations(".dark")["--card"] },
] as const;

describe("accent presets", () => {
  it("defines every token for every accent in both themes", () => {
    for (const mode of modes) for (const accent of ACCENTS) {
      const tokens = mode.select(accent.id);
      for (const token of ["--primary", "--primary-hover", "--primary-ink", "--ring", "--dither-ink", "--switch-on"]) expect(tokens[token], `${mode.name} ${accent.id} ${token}`).toBeTruthy();
    }
  });
  it("keeps filled-action text readable (>= 4.5:1): white on colours, near-black on orange, flipped in dark neutral", () => {
    const base = declarations(":root")["--primary-foreground"];
    expect(base).toBe("#ffffff");
    for (const mode of modes) for (const accent of ACCENTS) {
      const tokens = mode.select(accent.id);
      const foreground = tokens["--primary-foreground"] ?? base;
      if (accent.id === "orange") expect(foreground, `${mode.name} orange text`).toBe("#18181b");
      expect(contrastRatio(colorOf(foreground), colorOf(tokens["--primary"])), `${mode.name} ${accent.id}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("makes Capy blue the unattributed default in both themes; neutral stays an explicit preset", () => {
    expect(ACCENTS[0]!.id).toBe("blue");
    expect(rootTokens["--primary"]).toBe("oklch(58% .213 267.8)");
    expect(declarations(".dark")["--primary"]).toBeUndefined();
    expect(declarations(".dark")["--primary-ink"]).toBe("oklch(70% .15 267.8)");
    expect(declarations('[data-accent="neutral"]')["--primary"]).toBe("#18181b");
    expect(declarations('.dark [data-accent="neutral"]')["--primary"]).toBe("#fafafa");
  });
  it("keeps accent ink readable as text on the card surface (>= 4.5:1) for every accent", () => {
    for (const mode of modes) for (const accent of ACCENTS) {
      expect(contrastRatio(colorOf(mode.select(accent.id)["--primary-ink"]), colorOf(mode.surface)), `${mode.name} ${accent.id}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

