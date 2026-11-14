import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runResearch } from "../research-runner.js";
import { UserspaceCounterexampleResearchAdapter, type CounterexampleTarget } from "./userspace-counterexample-adapter.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zero-cec-adapter-test-"));
  roots.push(root);
  return root;
}

function clangAvailable(): boolean {
  try { execFileSync("clang", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

function sourceTree(root: string): string {
  const src = join(root, "src");
  mkdirSync(join(src, "include"), { recursive: true });
  writeFileSync(join(src, "include", "demo.h"), "#ifndef DEMO_H\n#define DEMO_H\n#include <stddef.h>\n#include <stdint.h>\nint demo_parse(const uint8_t *data, size_t size);\n#endif\n");
  writeFileSync(join(src, "demo.c"),
    "#include \"include/demo.h\"\n#include <string.h>\n" +
    "int demo_parse(const uint8_t *data, size_t size) {\n" +
    "  if (!data || size < 4) return -1;\n" +
    "  uint8_t buf[16];\n" +
    "  memset(buf, 0, sizeof buf);\n" +
    "  if (size > sizeof buf) memcpy(buf, data, size); /* deliberate overflow for the lane test */\n" +
    "  return (int)buf[0];\n" +
    "}\n");
  return src;
}

function target(root: string, witnessInputs: string[] = []): CounterexampleTarget {
  return {
    kind: "userspace.counterexample",
    id: "cec:test",
    location: root,
    config: {
      sourceRoot: root,
      buildSystem: "cmake",
      suspectFunction: {
        header: "include/demo.h",
        functionName: "demo_parse",
        declaration: "int demo_parse(const uint8_t *data, size_t size);",
        inputShape: "bytesAndLen",
      },
      ...(witnessInputs.length > 0 ? { witnessInputs } : {}),
    },
  };
}

describe("UserspaceCounterexampleResearchAdapter (witness replay, no fuzzing)", () => {
  it("reports honestly when no witness inputs are configured", async () => {
    const root = tempRoot();
    const src = sourceTree(root);
    const result = await runResearch(new UserspaceCounterexampleResearchAdapter(), target(src), { artifactRoot: join(root, "artifacts") });
    expect(result.findings).toHaveLength(0);
    const executeEvidence = result.evidence.find(record => record.stage === "execute");
    expect(executeEvidence?.status).toBe("inconclusive");
    expect(executeEvidence?.summary).toContain("no witness inputs configured");
    const verifyEvidence = result.evidence.find(record => record.stage === "verify");
    expect(verifyEvidence?.summary).toContain("absence is not proven");
  });

  it("promotes a sanitizer-confirmed witness to a finding and binds the artifact", async () => {
    if (!clangAvailable()) return;
    const root = tempRoot();
    const src = sourceTree(root);
    const witnessPath = join(root, "witness.bin");
    writeFileSync(witnessPath, Buffer.alloc(64, 0x41));
    const result = await runResearch(new UserspaceCounterexampleResearchAdapter(), target(src, [witnessPath]), { artifactRoot: join(root, "artifacts") });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.grade).toBe("observed");
    expect(result.findings[0]!.evidence[0]!.artifacts).toEqual([witnessPath]);
    const executeEvidence = result.evidence.filter(record => record.stage === "execute" && record.status === "passed");
    expect(executeEvidence.length).toBeGreaterThan(0);
    expect(result.envelopes[0]!.artifacts.some(a => a.path === witnessPath)).toBe(true);
  });

  it("scaffolds a real Tier-2 harness from raw source", async () => {
    const root = tempRoot();
    const src = sourceTree(root);
    const result = await runResearch(new UserspaceCounterexampleResearchAdapter(), target(src), { artifactRoot: join(root, "artifacts") });
    const harnessEvidence = result.evidence.find(record => record.stage === "harness");
    expect(harnessEvidence?.status).toBe("passed");
    expect(harnessEvidence?.summary).toContain("demo_parse");
  });
});
