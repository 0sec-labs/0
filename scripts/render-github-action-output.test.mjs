import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function sarifLocations(annotations) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "0-action-output-test-"));
  try {
    const findings = annotations.map((reviewAnnotation, index) => ({
      id: `finding-${index}`, templateId: "0:path-traversal", title: "Download route reads any file",
      description: "The download handler joins the user path to the storage root.", severity: "high",
      category: "path-traversal", status: "confirmed", reviewAnnotation,
    }));
    writeFileSync(join(root, "report.json"), JSON.stringify({ target: "/home/runner/work/app/app", findings, warnings: [], summary: {} }));
    const rendered = spawnSync(process.execPath, [
      "scripts/render-github-action-output.mjs", join(root, "report.json"), join(root, "report.sarif"), "sarif", "review", ".", "none", "0",
    ], { env: { ...process.env, GITHUB_OUTPUT: join(root, "github-output") }, encoding: "utf8" });
    assert.equal(rendered.status, 0, rendered.stderr);
    const results = JSON.parse(readFileSync(join(root, "report.sarif"), "utf8")).runs[0].results;
    return results.map(result => result.locations[0].physicalLocation);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test("SARIF locates a source-review finding at its cited file and lines", () => {
  assert.deepEqual(sarifLocations([{ path: "src/routes/download.ts", startLine: 42, endLine: 44 }]), [
    { artifactLocation: { uri: "src/routes/download.ts" }, region: { startLine: 42, endLine: 44 } },
  ]);
});
test("SARIF keeps the cited file but drops an invalid cited line range", () => {
  assert.deepEqual(sarifLocations([{ path: "src/routes/download.ts", startLine: 0 }, { path: "src/routes/download.ts", startLine: 42, endLine: 40 }]), [
    { artifactLocation: { uri: "src/routes/download.ts" } },
    { artifactLocation: { uri: "src/routes/download.ts" }, region: { startLine: 42 } },
  ]);
});
test("SARIF locates a finding without a source annotation at the scan target", () => {
  assert.deepEqual(sarifLocations([undefined]), [{ artifactLocation: { uri: "/home/runner/work/app/app" } }]);
});
