/** The browser receives provenance only, never the raw report or execution fields. */
export function ciReportProvenance(summaryJson?: string | null) {
  if (!summaryJson) return undefined;
  try {
    const value = JSON.parse(summaryJson)?.ciImport;
    if (value?.schemaVersion !== 1 || value.source !== "ci" || value.trust !== "unverified" || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.importedAt !== "string") return undefined;
    const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata) ? value.metadata : {};
    const text = (key: string) => typeof metadata[key] === "string" ? metadata[key].slice(0, 8192) as string : null;
    return {
      trust: "unverified" as const, digest: value.digest as string, importedAt: value.importedAt as string,
      sourceExecutionStatus: (["successful", "failed", "unknown"].includes(value.sourceExecutionStatus) ? value.sourceExecutionStatus : "unknown") as "successful" | "failed" | "unknown",
      repository: text("repository"), reviewedRevision: text("reviewedRevision"), githubEventRevision: text("githubEventRevision"),
      runId: text("runId"), cliVersion: text("cliVersion"),
      cliExitCode: Number.isInteger(metadata.cliExitCode) ? metadata.cliExitCode as number : null,
    };
  } catch { return undefined; }
}
