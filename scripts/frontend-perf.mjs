// Production-build perf probe: node scripts/frontend-perf.mjs <console-url> <scenario: home|thread|findings> [shot.png]
// Drives headless Chromium (playwright-core) and reads CDP Performance.getMetrics. The thread and findings
// scenarios mock the API with a 300-message transcript and 500 findings so no data has to be seeded.
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const [url, scenario = "home", shot] = process.argv.slice(2);

const finding = (i) => ({
  id: `f${i}`, scanId: "s1", title: `Finding ${i}: unsanitised input reaches shell`, description: "Input reaches a shell call.", severity: ["critical", "high", "medium", "low"][i % 4],
  category: "injection", status: "open", fingerprint: `fp${i}`, triageStatus: "new", timestamp: Date.now() - i * 1000, evidenceRequest: "", evidenceResponse: "",
});
const group = (i) => ({
  fingerprint: `fp${i}`, latest: finding(i), count: 1, scanCount: 1,
  workflow: { status: "backlog", persistedStatus: "backlog", recommendedStatus: "backlog", phase: "triage", reviewGate: "none", reviewReason: null, assignee: null, updatedAt: null, consensus: "none", activeAgentRoles: [], evidenceSignal: "weak", verdictCounts: { truePositive: 0, falsePositive: 0, unsure: 0, total: 0 } },
});
const messages = Array.from({ length: 300 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}. ` + "The quick brown fox jumps over the lazy dog. ".repeat(6) }] }));

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
if (scenario === "findings") {
  await page.route("**/api/dashboard", r => r.fulfill({ json: { cases: [], scans: [], groups: Array.from({ length: 500 }, (_, i) => group(i)), workers: [], queue: { runnable: 0, active: 0, blockedByDependency: 0, manualReview: 0, staleWorkers: 0, recoveredClaims: 0 } } }));
}
if (scenario === "thread") {
  await page.route("**/api/console/saved/**", r => r.fulfill({ json: { meta: { id: "t1", savedAt: Date.now(), cwd: "/tmp", messageCount: 300, preview: "Perf thread" }, messages, total: 300, firstIndex: 0, hasMore: false } }));
}
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
let transfer = 0;
page.on("response", async r => { try { transfer += (await r.body()).length; } catch {} });
const path = scenario === "findings" ? "/findings" : scenario === "thread" ? "/chats/saved/t1" : "/";
await page.goto(url.replace(/\/$/, "") + path, { waitUntil: "load" });
await page.waitForTimeout(3500);
const nav = await page.evaluate(() => {
  const res = performance.getEntriesByType("resource");
  const fcp = performance.getEntriesByType("paint").find(p => p.name === "first-contentful-paint");
  return { fcp: Math.round(fcp?.startTime ?? 0), jsKB: Math.round(res.filter(e => e.name.endsWith(".js")).reduce((a, e) => a + e.encodedBodySize, 0) / 1024), requests: res.length, nodes: document.getElementsByTagName("*").length, fonts: res.filter(e => /woff2/.test(e.name)).length };
});
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(x => [x.name, x.value]));
const a = await metrics();
const renderMs = Math.round((a.LayoutDuration + a.RecalcStyleDuration) * 1000);
await page.waitForTimeout(10000);
const c = await metrics();
if (shot) await page.screenshot({ path: shot });
console.log(JSON.stringify({ scenario, ...nav, idleTaskPct: +(((c.TaskDuration - a.TaskDuration) / 10) * 100).toFixed(2), idleScriptPct: +(((c.ScriptDuration - a.ScriptDuration) / 10) * 100).toFixed(2), renderMs, heapMB: Math.round(c.JSHeapUsedSize / 1e6), layouts: c.LayoutCount - a.LayoutCount }));
await b.close();
