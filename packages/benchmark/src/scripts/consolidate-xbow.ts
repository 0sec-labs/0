#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { aggregateXbowReports, type XbowReport, type ReportSource } from "../../scripts/xbow-cohorts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : "0sec-labs/0sec";
const workflow = args.includes("--workflow") ? args[args.indexOf("--workflow") + 1] : "xbow-bench.yml";
const limitRuns = args.includes("--limit-runs") ? parseInt(args[args.indexOf("--limit-runs") + 1], 10) : 50;
const outputPath = args.includes("--output")
  ? args[args.indexOf("--output") + 1]
  : join(__dirname, "..", "..", "results", "xbow-canonical.json");

interface RunSummary {
  databaseId: number;
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface ArtifactSummary {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  archive_download_url: string;
  workflow_run?: {
    id: number;
  };
}

interface ArtifactPage {
  total_count?: number;
  artifacts?: ArtifactSummary[];
}

function ghJson<T>(argv: string[]): T {
  const output = execFileSync("gh", argv, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(output) as T;
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function fetchXbowArtifacts(
  repoName: string,
  runIds: Set<number>,
  oldestRunCreatedAt: string,
): ArtifactSummary[] {
  const matches: ArtifactSummary[] = [];
  const oldestMs = Date.parse(oldestRunCreatedAt);

  for (let page = 1; page <= 10; page += 1) {
    const payload = ghJson<ArtifactPage>([
      "api",
      `repos/${repoName}/actions/artifacts?per_page=100&page=${page}`,
    ]);
    const artifacts = payload.artifacts ?? [];
    if (artifacts.length === 0) break;

    for (const artifact of artifacts) {
      if (!artifact.name.startsWith("xbow-results-")) continue;
      if (artifact.expired) continue;
      if (!artifact.workflow_run?.id || !runIds.has(artifact.workflow_run.id)) continue;
      matches.push(artifact);
    }

    const last = artifacts[artifacts.length - 1];
    if (!last) break;
    const lastMs = Date.parse(last.created_at);
    if (Number.isFinite(oldestMs) && Number.isFinite(lastMs) && lastMs < oldestMs) {
      break;
    }
  }

  return matches;
}

function downloadArtifact(repoName: string, artifact: ArtifactSummary, outputDir: string): string[] {
  const zipPath = join(outputDir, `${artifact.id}.zip`);
  const extractDir = join(outputDir, String(artifact.id));
  mkdirSync(extractDir, { recursive: true });

  const zipBuffer = execFileSync(
    "gh",
    ["api", `repos/${repoName}/actions/artifacts/${artifact.id}/zip`],
    {
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 100 * 1024 * 1024,
      encoding: "buffer",
    },
  );
  writeFileSync(zipPath, zipBuffer);
  execFileSync("unzip", ["-qq", zipPath, "-d", extractDir], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 100 * 1024 * 1024,
  });
  rmSync(zipPath, { force: true });
  return walk(extractDir).filter((file) => basename(file) === "xbow-latest.json");
}

const runs = ghJson<RunSummary[]>([
  "run",
  "list",
  "--repo",
  repo,
  "--workflow",
  workflow,
  "--limit",
  String(limitRuns),
  "--json",
  "databaseId,status,conclusion,createdAt,updatedAt,url",
]).filter((run) => run.status === "completed");
const xbowArtifacts = runs.length > 0
  ? fetchXbowArtifacts(
      repo,
      new Set(runs.map((run) => run.databaseId)),
      runs[runs.length - 1]!.createdAt,
    )
  : [];
const artifactsByRunId = new Map<number, ArtifactSummary[]>();
for (const artifact of xbowArtifacts) {
  const runId = artifact.workflow_run?.id;
  if (!runId) continue;
  const list = artifactsByRunId.get(runId) ?? [];
  list.push(artifact);
  artifactsByRunId.set(runId, list);
}

const reports: Array<{ report: XbowReport; source: ReportSource }> = [];
const skippedRuns: Array<{ runId: number; reason: string }> = [];

for (const run of runs) {
  const downloadDir = mkdtempSync(join(tmpdir(), "0sec-xbow-consolidate-"));
  try {
    const artifacts = artifactsByRunId.get(run.databaseId) ?? [];
    if (artifacts.length === 0) {
      skippedRuns.push({ runId: run.databaseId, reason: "no xbow-results artifact found" });
      continue;
    }

    let reportFiles: string[] = [];
    try {
      for (const artifact of artifacts) {
        reportFiles = reportFiles.concat(downloadArtifact(repo, artifact, downloadDir));
      }
    } catch (err) {
      skippedRuns.push({
        runId: run.databaseId,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (reportFiles.length === 0) {
      skippedRuns.push({ runId: run.databaseId, reason: "no xbow-latest.json artifact found" });
      continue;
    }

    for (const file of reportFiles) {
      const report = JSON.parse(readFileSync(file, "utf8")) as XbowReport;
      reports.push({ report, source: {
        runId: run.databaseId, url: run.url, createdAt: run.createdAt,
        artifact: basename(dirname(file)), reportFile: file.slice(downloadDir.length + 1),
      } });
    }
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

const summary = aggregateXbowReports(reports);

const canonical = {
  generatedAt: new Date().toISOString(),
  repo,
  workflow,
  runWindow: {
    limitRuns,
    completedRunsConsidered: runs.length,
    xbowArtifactsConsidered: xbowArtifacts.length,
    skippedRuns,
  },
  ...summary,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(canonical, null, 2) + "\n");

console.log(`Wrote ${outputPath}`);
console.log(`  Historical union (not a single-run score): ${summary.counts.aggregate} unique challenges`);
console.log(`  black-box: ${summary.counts.blackBox}; white-box: ${summary.counts.whiteBox}; unknown mode: ${summary.counts.unknownMode}`);
console.log(`  ${summary.cohorts.length} separate report/model/mode/attempt-policy cohorts; no cross-report per-model score`);
