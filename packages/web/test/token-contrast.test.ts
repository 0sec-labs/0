import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastReport, type TokenMap } from "../src/lib/token-contrast";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function declarations(selector: string): TokenMap {
  const out: TokenMap = {};
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1]!.split(",").some(part => part.trim() === selector)) continue;
    for (const decl of rule[2]!.split(";")) { const i = decl.indexOf(":"); if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim(); }
  }
  return out;
}
const light = declarations(":root");
const dark = { ...light, ...declarations(".dark") };

describe("default theme text contrast", () => {
  for (const [mode, tokens] of [["light", light], ["dark", dark]] as const) {
    it(`reads at WCAG AA on every surface in ${mode}`, () => {
      for (const row of contrastReport(tokens)) expect(row.ratio, `${mode} ${row.text} on ${row.surface}`).toBeGreaterThanOrEqual(row.min);
    });
  }
});
