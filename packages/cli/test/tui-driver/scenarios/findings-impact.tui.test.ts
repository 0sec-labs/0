import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { osecDB } from "@0/db";
import type { Finding, ImpactAssessment } from "@0/shared";
import { launch, type TuiHandle } from "../index.js";
import { frameLines } from "./_helpers.js";

let tui: TuiHandle | undefined;
let root: string | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.restoreAllMocks();
});

const ALPHA_IMPACT: ImpactAssessment = {
  reachability_tier: "local-unpriv",
  blast_radius: "One account cache",
  weaponizability: "info-leak",
  business_impact: "modest",
  rationale: "Only the local cache is in scope.",
};
const BETA_IMPACT: ImpactAssessment = {
  reachability_tier: "remote-auth",
  blast_radius: "Authenticated tenant records",
  weaponizability: "integrity-tampering",
  business_impact: "notable",
  rationale: "An authenticated actor can change tenant records.",
};

function seed(longEvidence = false): { dbPath: string; scanId: string } {
  root = mkdtempSync(join(tmpdir(), "0-finding-impact-"));
  const dbPath = join(root, "0.db");
  const db = new osecDB(dbPath);
  try {
    const scanId = db.createScan({ target: root, mode: "deep", depth: "quick", format: "json", timeout: 1000 });
    const save = (id: string, title: string, timestamp: number, impactAssessment?: ImpactAssessment, fingerprint = id) => {
      db.saveFinding(scanId, {
        id, title, timestamp, impactAssessment, fingerprint,
        templateId: "manual", severity: "high", category: "information-disclosure", status: "discovered",
        description: `${title} description`,
        evidence: {
          request: `${id}.ts:1`,
          response: longEvidence && id === "F-alpha"
            ? `${Array.from({ length: 120 }, (_, i) => `Persisted response row ${i}: source inspection content.`).join("\n")}\nEVIDENCE_TAIL_RETAINED`
            : `${id} source inspection only`,
          analysis: `${id} evidence analysis`,
        },
      });
    };
    save("F-alpha-old", "Alpha stale", 10, { ...ALPHA_IMPACT, business_impact: "headline", blast_radius: "Stale scope" }, "alpha-family");
    save("F-alpha", "Alpha latest", 40, ALPHA_IMPACT, "alpha-family");
    save("F-beta", "Beta tenant", 30, BETA_IMPACT);
    save("F-gamma", "Gamma missing", 20);
    save("F-delta", "Delta malformed", 15, { business_impact: "headline" } as Finding["impactAssessment"]);
    return { dbPath, scanId };
  } finally {
    db.close();
  }
}

test.each([false, true])("persisted impact follows selection and filtered actions in raw mode %s", async (all) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  const fixture = seed();
  tui = await launch({
    cols: 160, rows: 60,
    route: { type: "findings", options: { dbPath: fixture.dbPath, severity: "high", limit: 10, all } },
  });
  const alpha = await tui.waitForText(/Business impact: modest/);
  expect(alpha).toContain("Assessment for F-alpha");
  expect(alpha).toContain("One account cache");
  expect(alpha).not.toContain("Stale scope");
  expect(alpha).not.toContain("FILTERS");
  expect(alpha.indexOf("DESCRIPTION")).toBeLessThan(alpha.indexOf("IMPACT"));
  expect(alpha.indexOf("IMPACT")).toBeLessThan(alpha.indexOf("EVIDENCE"));
  expect(alpha.indexOf("EVIDENCE")).toBeLessThan(alpha.indexOf("SOURCE FIX"));
  expect(alpha).toContain("scope severity:high");
  expect(alpha).toContain("limit 10");

  await tui.sendKey("down");
  const beta = await tui.waitForText(/Business impact: notable/);
  expect(beta).toContain("Assessment for F-beta");
  expect(beta).toContain("Authenticated tenant records");
  expect(beta).not.toContain("One account cache");

  await tui.sendKeys("/Beta");
  await tui.sendKey("return");
  await tui.sendKeys("a");
  await tui.waitForText(/Updated/);
  const db = new osecDB(fixture.dbPath);
  try {
    expect(db.getFinding("F-beta")?.triageStatus).toBe("accepted");
    expect(db.getFinding("F-alpha")?.triageStatus).toBe("new");
  } finally {
    db.close();
  }
  await tui.waitForText(/Business impact: notable/);
  await tui.sendKey("return");
  const detail = await tui.waitForText(/FINDING · F-beta/);
  expect(detail).toContain("Beta tenant");
  expect(detail).toContain("Assessment for F-beta");
  expect(detail).toContain("Business impact: notable");
  expect(detail).not.toContain("FILTERS");
  await tui.sendKey("end");
  expect(await tui.waitForText(/Replay verification: not run/)).toContain("Source check: not run");
});

test.each(["Gamma", "Delta"])("%s has no inferred impact in preview or full detail", async (title) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  const fixture = seed();
  tui = await launch({ cols: 160, rows: 60, route: { type: "findings", options: { dbPath: fixture.dbPath, limit: 10 } } });
  await tui.waitForText(/Business impact: modest/);
  await tui.sendKeys(`/${title}`);
  await tui.sendKey("return");
  const preview = await tui.waitForText(/Not assessed/);
  expect(preview).not.toContain("Business impact:");
  expect(preview).not.toContain("FILTERS");
  await tui.sendKey("return");
  const detail = await tui.waitForText(new RegExp(`FINDING · F-${title.toLowerCase()}`));
  expect(detail).toContain(title);
  expect(detail).toContain("Not assessed");
  expect(detail).not.toContain("Business impact:");
  await tui.sendKey("end");
  expect(await tui.waitForText(/Replay verification: not run/)).toContain("Source check: not run");
});

test("the finding preview keeps evidence beyond the former forty-row truncation scrollable", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  const fixture = seed(true);
  tui = await launch({
    cols: 160, rows: 60, settings: { mouseSupport: true },
    route: { type: "findings", options: { dbPath: fixture.dbPath, limit: 10 } },
  });
  await tui.waitForText(/Business impact: modest/);
  const requestRow = frameLines(tui.rawFrame())
    .map((line, y) => ({ line, y }))
    .find(({ line }) => line.includes("request"));
  expect(requestRow).toBeDefined();
  const x = requestRow!.line.indexOf("request") + 2;
  for (let i = 0; i < 12 && !tui.captureFrame().includes("EVIDENCE_TAIL_RETAINED"); i++) {
    await tui.scroll(x, requestRow!.y, 20);
  }
  expect(tui.captureFrame()).toContain("EVIDENCE_TAIL_RETAINED");
  expect(tui.captureFrame()).toContain("SOURCE FIX");
});
