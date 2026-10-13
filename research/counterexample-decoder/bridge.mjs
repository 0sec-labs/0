#!/usr/bin/env node
/**
 * Bridge: attach counterexample replay evidence to a Zero-produced finding.
 *
 * Reads Zero's research evidence-envelopes.json, extracts the finding's own
 * proposed witness (count / element_size from its description; falls back to
 * the demo's minimal witness), replays it against the vulnerable and mitigated
 * builds, and writes finding-evidence.json — a record shaped for attachment to
 * the finding's researchEvidence chain.
 *
 * Boundary: the sanitizer replay is deterministic implementation evidence and
 * supports a "reproduced" grade for this fixture. It says nothing about other
 * targets, and the model search alone would not justify promotion.
 *
 * Usage:
 *   node bridge.mjs --envelopes /path/to/evidence-envelopes.json [--out finding-evidence.json]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE, build, evaluate, replay, summarize, witnessBuffer } from "./replay-lib.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const args = process.argv.slice(2);
const envelopesPath = args[args.indexOf("--envelopes") + 1];
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(HERE, "finding-evidence.json");
if (!envelopesPath) { console.error("usage: bridge.mjs --envelopes <path> [--out <path>]"); process.exit(64); }

const envelopes = JSON.parse(readFileSync(envelopesPath, "utf8"));
const envelope = envelopes[0];
if (!envelope) throw new Error("no evidence envelopes found");
const verifyRecord = (envelope.native?.oraclePayload ?? []).find(r => r.stage === "verify" && r.data?.id);
const finding = verifyRecord?.data;
if (!finding) throw new Error("no finding payload in envelope");

// Extract the finding's own proposed witness; fall back to the known minimal one.
const text = `${finding.description ?? ""}\n${finding.evidence?.analysis ?? ""}`;
const match = /count\s*=\s*(\d+)\D{0,40}element_size\s*=\s*(\d+)/i.exec(text);
const witness = match
  ? evaluate(Number(match[1]), Number(match[2]))
  : evaluate(256, 256);
if (!witness.violates) throw new Error(`finding-proposed witness does not violate the property: ${JSON.stringify(witness)}`);

const sha256 = p => createHash("sha256").update(readFileSync(p)).digest("hex");
const workDir = mkdtempSync(join(tmpdir(), "zero-cec-bridge-"));
try {
  const witnessPath = join(workDir, "witness.bin");
  writeFileSync(witnessPath, witnessBuffer(witness), { mode: 0o600 });
  const vulnBin = build(workDir, "decoder-vulnerable", join(FIXTURE, "src/decoder.c"));
  const patchedBin = build(workDir, "decoder-patched", join(HERE, "patched-decoder.c"));
  const vulnRun = replay(vulnBin, witnessPath);
  const patchedRun = replay(patchedBin, witnessPath);
  const vulnSummary = summarize(vulnRun.output);

  const reproduced = vulnSummary.heapBufferOverflow && patchedRun.exitCode === 0;
  const evidence = {
    schema: "zero-counterexample-evidence/v1",
    findingId: finding.id,
    findingTitle: finding.title,
    sourceRun: { evidenceEnvelopePath: envelopesPath, evidenceId: envelope.evidenceId, runId: envelope.provenance?.runId },
    grade: reproduced ? "reproduced" : "inconclusive",
    gradeBasis: reproduced
      ? "sanitizer: deterministic ASan heap-buffer-overflow replay of the finding's witness; same witness clean on reference mitigation"
      : "replay did not reproduce the claimed failure",
    witness: { ...witness, source: match ? "finding-description" : "demo-minimal-fallback" },
    replay: {
      vulnerable: { exitCode: vulnRun.exitCode, signal: vulnRun.signal, ...vulnSummary },
      patchedSameWitness: { exitCode: patchedRun.exitCode, heapBufferOverflow: summarize(patchedRun.output).heapBufferOverflow },
    },
    target: {
      source: "packages/core/src/review/__fixtures__/c-library-demo/src/decoder.c",
      sha256: sha256(join(FIXTURE, "src/decoder.c")),
      mitigationSha256: sha256(join(HERE, "patched-decoder.c")),
    },
    toolchain: execFileSync("clang", ["--version"], { encoding: "utf8" }).split("\n")[0],
  };
  writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o644 });
  console.log(JSON.stringify(evidence, null, 2));
  if (!reproduced) process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
