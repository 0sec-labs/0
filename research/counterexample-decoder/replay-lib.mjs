/** Shared counterexample replay helpers for this directory's demos. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPO = new URL("../../", import.meta.url).pathname;
export const FIXTURE = join(REPO, "packages/core/src/review/__fixtures__/c-library-demo");

export function evaluate(count, elementSize) {
  const copyBytes = count * elementSize;
  const truncated = copyBytes % 65536;
  const allocBytes = truncated === 0 ? 1 : truncated;
  return { count, elementSize, copyBytes, allocBytes, accepted: true, violates: copyBytes > allocBytes };
}

export function witnessBuffer({ count, elementSize, copyBytes }) {
  const data = Buffer.alloc(8 + copyBytes, 0x41);
  data.writeUInt32LE(count, 0);
  data.writeUInt32LE(elementSize, 4);
  return data;
}

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

export function build(workDir, name, sourcePath) {
  const mainPath = join(workDir, `${name}-main.c`);
  const binPath = join(workDir, name);
  writeFileSync(mainPath, harnessSource(), { mode: 0o600 });
  execFileSync("clang", ["-fsanitize=address", "-g", "-O1",
    "-I", join(FIXTURE, "include"), sourcePath, mainPath, "-o", binPath], { stdio: "pipe" });
  return binPath;
}

export function replay(binPath, witnessPath) {
  try {
    // foxguard: ignore[js/no-command-injection] the caller supplies owned replay artifacts and execFileSync passes argv without a shell.
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

export function summarize(output) {
  const lines = output.split("\n");
  return {
    heapBufferOverflow: /heap-buffer-overflow/.test(output),
    summaryLine: (lines.find(l => l.includes("SUMMARY: AddressSanitizer")) ?? "").trim() || null,
    writeLine: (lines.find(l => /WRITE of size/.test(l)) ?? "").trim() || null,
  };
}
