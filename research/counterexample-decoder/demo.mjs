#!/usr/bin/env node
/**
 * Counterexample-first demo against the deliberately vulnerable decoder fixture.
 *
 *   property hypothesis → bounded model search → minimal violating witness
 *   → replay against vulnerable build (ASan) → replay against mitigated build
 *
 * Calibration only: the vulnerability is intentional and documented in the
 * fixture. This validates the evidence path; it is not a new discovery.
 * The vulnerable fixture is never modified. All execution is local.
 *
 * Usage: node research/counterexample-decoder/demo.mjs   (requires clang + ASan)
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../../", import.meta.url).pathname;
const HERE = new URL(".", import.meta.url).pathname;
const FIXTURE = join(REPO, "packages/core/src/review/__fixtures__/c-library-demo");
const VULN_SRC = join(FIXTURE, "src/decoder.c");
const PATCHED_SRC = join(HERE, "patched-decoder.c");

const sha256 = p => createHash("sha256").update(readFileSync(p)).digest("hex");

// --- Model -----------------------------------------------------------------
// Property: for every ACCEPTED input, bytes copied must not exceed bytes
// allocated. The vulnerable build derives allocation from a 16-bit truncation
// of the same product used for the copy length.
const MAX_COUNT = 2048, MAX_ELEMENT = 256;

function evaluate(count, elementSize) {
  const copyBytes = count * elementSize;
  const truncated = copyBytes % 65536;
  const allocBytes = truncated === 0 ? 1 : truncated; // malloc(1) on zero, per fixture
  // Input carries exactly copyBytes of payload: the bound check passes.
  const accepted = true;
  return { count, elementSize, copyBytes, allocBytes, accepted, violates: accepted && copyBytes > allocBytes };
}

function search() {
  const violations = [];
  let evaluated = 0;
  for (let count = 1; count <= MAX_COUNT; count++) {
    for (let elementSize = 1; elementSize <= MAX_ELEMENT; elementSize++) {
      evaluated++;
      const r = evaluate(count, elementSize);
      if (r.violates) violations.push(r);
    }
  }
  violations.sort((a, b) => a.copyBytes - b.copyBytes || a.count - b.count);
  return { evaluated, found: violations.length, minimal: violations[0] };
}

function witnessBuffer({ count, elementSize, copyBytes }) {
  const data = Buffer.alloc(8 + copyBytes, 0x41);
  data.writeUInt32LE(count, 0);
  data.writeUInt32LE(elementSize, 4);
  return data;
}

// --- Replay ----------------------------------------------------------------

function harnessSource() {
  return [
    '#include "decoder.h"', "#include <stdlib.h>", "#include <stdio.h>",
    "int main(int argc, char **argv) {",
    "  if (argc != 2) return 64;",
    '  FILE *f = fopen(argv[1], "rb"); if (!f) return 65;',
    '  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);',
    "  uint8_t *data = malloc((size_t)n); if (!data) return 66;",
    "  if (fread(data, 1, (size_t)n, f) != (size_t)n) return 67;",
    "  fclose(f);",
    "  uint8_t *out = NULL; size_t out_size = 0;",
    "  int rc = decode_payload(data, (size_t)n, &out, &out_size);",
    "  free(out); free(data);",
    "  return rc == 0 ? 0 : (rc == -1 ? 1 : 2);",
    "}",
  ].join("\n") + "\n";
}

function build(workDir, name, sourcePath) {
  const mainPath = join(workDir, `${name}-main.c`);
  const binPath = join(workDir, name);
  writeFileSync(mainPath, harnessSource(), { mode: 0o600 });
  execFileSync("clang", ["-fsanitize=address", "-g", "-O1",
    "-I", join(FIXTURE, "include"), sourcePath, mainPath, "-o", binPath], { stdio: "pipe" });
  return binPath;
}

function replay(binPath, witnessPath) {
  try {
    // foxguard: ignore[js/no-command-injection] both paths are generated inside the owned demo workspace and execFileSync does not invoke a shell.
    const out = execFileSync(binPath, [witnessPath], { // foxguard: ignore[js/no-command-injection]
      encoding: "utf8", timeout: 15_000, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
    });
    return { exitCode: 0, signal: null, output: out };
  } catch (error) {
    return {
      exitCode: typeof error.status === "number" ? error.status : -1,
      signal: error.signal ?? null,
      output: `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    };
  }
}

function summarize(output) {
  const lines = output.split("\n");
  return {
    heapBufferOverflow: /heap-buffer-overflow/.test(output),
    summaryLine: (lines.find(l => l.includes("SUMMARY: AddressSanitizer")) ?? "").trim() || null,
    writeLine: (lines.find(l => /WRITE of size/.test(l)) ?? "").trim() || null,
  };
}

// --- Run -------------------------------------------------------------------

const searchResult = search();
const witness = searchResult.minimal;
if (!witness) throw new Error("search found no counterexample within stated bounds");

const workDir = mkdtempSync(join(tmpdir(), "zero-cec-decoder-"));
try {
  const witnessPath = join(workDir, "witness.bin");
  writeFileSync(witnessPath, witnessBuffer(witness), { mode: 0o600 });

  const vulnBin = build(workDir, "decoder-vulnerable", VULN_SRC);
  const patchedBin = build(workDir, "decoder-patched", PATCHED_SRC);

  const vulnRun = replay(vulnBin, witnessPath);
  const patchedRun = replay(patchedBin, witnessPath);

  // Negative control: patched build must reject an input that under-supplies payload.
  const shortInput = witnessBuffer({ count: 16, elementSize: 4, copyBytes: 4096 });
  const shortPath = join(workDir, "under-supplied.bin");
  // Reuse the same field values but truncate the payload so copy_size > available.
  const truncated = Buffer.concat([shortInput.subarray(0, 8), Buffer.alloc(32, 0x42)]);
  truncated.writeUInt32LE(16, 0);
  truncated.writeUInt32LE(256, 4); // copy_size = 4096, available = 32
  writeFileSync(shortPath, truncated, { mode: 0o600 });
  const patchedReject = replay(patchedBin, shortPath);

  const vulnSummary = summarize(vulnRun.output);
  const evidence = {
    demo: "decoder-allocation-counterexample",
    status: vulnSummary.heapBufferOverflow && patchedRun.exitCode === 0 && patchedReject.exitCode === 1 ? "passed" : "unexpected-result",
    scope: "Calibration against a deliberately vulnerable fixture. Not a new vulnerability. Model property, ASan replay, and mitigation replay are separate evidence.",
    property: "for every accepted input, copyBytes <= allocBytes",
    target: {
      source: "packages/core/src/review/__fixtures__/c-library-demo/src/decoder.c",
      sha256: sha256(VULN_SRC),
      mitigationSource: "research/counterexample-decoder/patched-decoder.c",
      mitigationSha256: sha256(PATCHED_SRC),
    },
    search: {
      space: `count 1..${MAX_COUNT}, elementSize 1..${MAX_ELEMENT}`,
      evaluated: searchResult.evaluated,
      violationsFound: searchResult.found,
      minimalWitness: witness,
    },
    replay: {
      vulnerable: { exitCode: vulnRun.exitCode, ...vulnSummary },
      patchedSameWitness: { exitCode: patchedRun.exitCode, heapBufferOverflow: summarize(patchedRun.output).heapBufferOverflow },
      patchedUnderSuppliedInput: { exitCode: patchedReject.exitCode, note: "expected 1 (malformed input rejected, no crash)" },
    },
    toolchain: execFileSync("clang", ["--version"], { encoding: "utf8" }).split("\n")[0],
  };
  if (evidence.status !== "passed") {
    evidence.debug = { vulnOutput: vulnRun.output.slice(0, 3000), patchedOutput: patchedRun.output.slice(0, 1000) };
  }
  writeFileSync(join(HERE, "result.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o644 });
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.status !== "passed") process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
