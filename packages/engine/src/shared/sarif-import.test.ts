import { describe, expect, it } from "vitest";
import { looksLikeSarif, parseSarif, repoRelativePath } from "./sarif-import.js";

const log = (results: unknown[], rules: unknown[] = [], extra: Record<string, unknown> = {}) => JSON.stringify({
  version: "2.1.0",
  runs: [{ tool: { driver: { name: "CodeQL", semanticVersion: "2.20.1", rules } }, results, ...extra }],
});
const at = (uri: string, startLine = 12, endLine?: number) => ({ physicalLocation: { artifactLocation: { uri }, region: { startLine, ...(endLine ? { endLine } : {}), snippet: { text: "db.query(sql)" } } } });

describe("parseSarif", () => {
  it("reads tool, rule, severity, message, location and CWE", () => {
    const parsed = parseSarif(log(
      [{ ruleId: "js/sql-injection", level: "error", message: { text: "Query built from user input." }, locations: [at("src/db.ts", 12, 14)], partialFingerprints: { primaryLocationLineHash: "abc:1" } }],
      [{ id: "js/sql-injection", shortDescription: { text: "SQL injection" }, properties: { tags: ["security", "external/cwe/cwe-089"], "security-severity": "8.8" } }],
    ));
    expect(parsed.tools).toEqual(["CodeQL"]);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({ tool: "CodeQL", toolVersion: "2.20.1", ruleId: "js/sql-injection", title: "SQL injection", severity: "high", category: "sql-injection", path: "src/db.ts", startLine: 12, endLine: 14, snippet: "db.query(sql)", cwe: ["CWE-89"] });
    expect(parsed.findings[0]!.fingerprint).toMatch(/^sarif:[0-9a-f]{24}$/);
  });

  it("gives the same fingerprint on a second run and a different one for another place", () => {
    const run = (line: number, hash: string) => parseSarif(log([{ ruleId: "r", message: { text: "m" }, locations: [at("a.ts", line)], partialFingerprints: { primaryLocationLineHash: hash } }])).findings[0]!.fingerprint;
    expect(run(10, "h1")).toBe(run(40, "h1"));
    expect(run(10, "h1")).not.toBe(run(10, "h2"));
  });

  it("maps levels when there is no security severity, and skips suppressed results", () => {
    const parsed = parseSarif(log([
      { ruleId: "a", level: "warning", message: { text: "w" } },
      { ruleId: "b", level: "note", message: { text: "n" } },
      { ruleId: "c", level: "error", message: { text: "gone" }, suppressions: [{ kind: "inSource" }] },
    ]));
    expect(parsed.findings.map(f => [f.ruleId, f.severity])).toEqual([["a", "medium"], ["b", "low"]]);
  });

  it("lets --tool override the label", () => {
    expect(parseSarif(log([{ ruleId: "r", message: { text: "m" } }]), { tool: "ci-sast" }).findings[0]!.tool).toBe("ci-sast");
  });

  it("keeps locations inside the repository and strips control characters", () => {
    const parsed = parseSarif(log([
      { ruleId: "r1", message: { text: "bell\u0007 here" }, locations: [at("../../etc/passwd")] },
      { ruleId: "r2", message: { text: "m" }, locations: [at("file:///work/x")] },
      { ruleId: "r3", message: { text: "m" }, locations: [at("./pkg/a%20b.ts")] },
    ]));
    expect(parsed.findings[0]).toMatchObject({ description: "bell here" });
    expect(parsed.findings[0]!.path).toBeUndefined();
    expect(parsed.findings[1]!.path).toBeUndefined();
    expect(parsed.findings[2]!.path).toBe("pkg/a b.ts");
  });

  it("refuses non-SARIF, other versions and oversized logs", () => {
    expect(() => parseSarif("not json")).toThrow("valid JSON");
    expect(() => parseSarif(JSON.stringify({ target: "x", findings: [] }))).toThrow("not a SARIF log");
    expect(() => parseSarif(JSON.stringify({ version: "1.0.0", runs: [] }))).toThrow("Unsupported SARIF version");
    expect(() => parseSarif(log(Array.from({ length: 5001 }, () => ({ ruleId: "r", message: { text: "m" } }))))).toThrow("more than 5000");
  });

  it("detects SARIF without parsing 0's own reports as SARIF", () => {
    expect(looksLikeSarif(log([]))).toBe(true);
    expect(looksLikeSarif(JSON.stringify({ findings: [], target: "x" }))).toBe(false);
  });

  it("makes absolute paths relative to the scanned folder, and drops other absolute paths", () => {
    const text = log([{ ruleId: "r", message: { text: "m" }, locations: [at("file:///work/app/src/a.ts", 3)] }, { ruleId: "r", message: { text: "m" }, locations: [at("file:///elsewhere/b.ts", 3)] }]);
    const parsed = parseSarif(text, { roots: ["/work/app"] }).findings;
    expect(parsed[0]!.path).toBe("src/a.ts");
    expect(parsed[1]!.path).toBeUndefined();
    expect(parseSarif(text).findings[0]!.path).toBeUndefined();
  });

  it("repoRelativePath rejects escapes and absolute paths", () => {
    expect(repoRelativePath("a/../b")).toBeUndefined();
    expect(repoRelativePath("/abs/x")).toBeUndefined();
    expect(repoRelativePath("C:\\x\\y")).toBeUndefined();
    expect(repoRelativePath("src\\a.ts")).toBe("src/a.ts");
  });
});
