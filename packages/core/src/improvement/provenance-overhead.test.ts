/** Explicit offline microbenchmark. Timings are observations, never CI thresholds. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { evolutionComparisonIdentity } from "./evaluation.js";
import type { EvolutionConfig } from "./types.js";
it("measures bounded offline provenance overhead without dispatching workers or models", () => {
  const root = mkdtempSync(join(tmpdir(), "0-provenance-overhead-"));
  try {
    const sourceRoot = join(root, "source"); mkdirSync(sourceRoot);
    for (let index = 0; index < 32; index++) writeFileSync(join(sourceRoot, `fixture-${index}.js`), `// fixture ${index}\nexport const n = ${index};\n`);
    const config = { schemaVersion: 1, sourceRoot, storePath: join(root, "store"), sourcePaths: Array.from({ length: 32 }, (_, index) => `fixture-${index}.js`),
      command: ["node", "fixture-0.js"], maxSourceBytes: 65536, backend: "docker", image: "sha256:" + "a".repeat(64), timeoutMs: 1000, memoryMb: 128, cpus: 1, maxOutputBytes: 1024,
      kind: "source", repeats: 2, promotionPolicy: {}, cases: [
        { id: "dev", lane: "development", input: 1, expected: true }, { id: "holdout", lane: "held-out", input: 2, expected: true }, { id: "negative", lane: "negative-control", input: 3, expected: false },
      ] } as EvolutionConfig;
    const durations: number[] = []; let encoded = "";
    for (let index = 0; index < 31; index++) {
      const start = performance.now(); encoded = JSON.stringify(evolutionComparisonIdentity(config)); durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    const report = { schemaVersion: 1, kind: "offline-provenance-microbenchmark", node: process.version, platform: process.platform, arch: process.arch,
      sourceFiles: 32, iterations: 31, p50Ms: durations[15], p95Ms: durations[29], identityBytes: Buffer.byteLength(encoded), modelCalls: 0, workerExecutions: 0,
      scope: "explicit offline identity observation; not production scan latency or paid qualification" };
    expect(report.identityBytes).toBeLessThan(8192);
    if (process.env.ZERO_PROVENANCE_METRICS) { mkdirSync(dirname(process.env.ZERO_PROVENANCE_METRICS), { recursive: true }); writeFileSync(process.env.ZERO_PROVENANCE_METRICS, JSON.stringify(report, null, 2) + "\n"); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
