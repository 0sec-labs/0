#!/usr/bin/env node
// Post `0` review findings that carry a proposed replacement as one GitHub pull request review
// with inline `suggestion` blocks. Opt-in, run from its own least-privilege job
// (`pull-requests: write`), never from the job that holds model credentials.
//
// The report is untrusted: its text is derived from model output on contributor code. Titles and
// descriptions are neutralised, every comment must land on lines that are part of the PR diff, and
// nothing here executes report content.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_COMMENTS_DEFAULT = 20;
const MARKER_PREFIX = "<!-- 0-suggestion:";

/** Lines of the new file (RIGHT side) that appear in a unified-diff `patch`, grouped per hunk. */
export function rightLinesByHunk(patch) {
  const hunks = [];
  let current;
  let line = 0;
  for (const raw of String(patch ?? "").split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      current = new Set();
      hunks.push(current);
      line = Number(header[1]);
      continue;
    }
    if (!current || raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("-")) continue; // deleted lines have no RIGHT-side number
    current.add(line);
    line += 1;
  }
  return hunks;
}

/** True only when every line of the range sits inside one hunk of the PR diff. */
export function rangeInDiff(hunks, start, end) {
  return hunks.some((hunk) => {
    for (let n = start; n <= end; n += 1) if (!hunk.has(n)) return false;
    return true;
  });
}

function neutralise(text, max) {
  return String(text ?? "")
    .replace(/<!--/g, "")
    .replace(/</g, "&lt;")
    .replace(/@/g, "@​")
    .replace(/\]\(/g, "] (")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A fence longer than any backtick run in the text, so the suggestion cannot close early. */
function fenceFor(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function commentBody(finding, annotation) {
  const replacement = String(annotation.suggestion).replace(/\r\n/g, "\n").replace(/\n$/, "");
  const fence = fenceFor(replacement);
  const id = neutralise(finding.id ?? finding.templateId ?? "finding", 80).replace(/[^A-Za-z0-9._-]/g, "_");
  return [
    `${MARKER_PREFIX}${id}:${annotation.path}:${annotation.startLine} -->`,
    `**${neutralise(finding.severity, 16)}: ${neutralise(finding.title, 200)}**`,
    "",
    neutralise(finding.description, 800),
    "",
    `${fence}suggestion`,
    replacement,
    fence,
    "",
    "_Proposed fix from 0. It has not been run or tested; review it before applying._",
  ].join("\n");
}

/** Pure planning step: which findings become which review comments, and which are skipped and why. */
export function planComments(report, filesByPath, existingBodies, max = MAX_COMMENTS_DEFAULT) {
  const comments = [];
  const skipped = [];
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  for (const finding of findings) {
    const annotation = finding?.reviewAnnotation;
    if (!annotation || typeof annotation.suggestion !== "string" || annotation.suggestion.length === 0) continue;
    const { path, startLine } = annotation;
    const endLine = Number.isInteger(annotation.endLine) ? annotation.endLine : startLine;
    const label = `${path}:${startLine}`;
    if (typeof path !== "string" || !Number.isInteger(startLine) || startLine < 1 || endLine < startLine) {
      skipped.push(`${label} invalid location`);
      continue;
    }
    const file = filesByPath.get(path);
    if (!file) { skipped.push(`${label} not changed in this pull request`); continue; }
    if (!rangeInDiff(rightLinesByHunk(file.patch), startLine, endLine)) {
      skipped.push(`${label} lines are not in the pull request diff`);
      continue;
    }
    const body = commentBody(finding, { ...annotation, path, startLine });
    const marker = body.split("\n")[0];
    if (existingBodies.some((existing) => existing.includes(marker))) { skipped.push(`${label} already suggested`); continue; }
    if (comments.length >= max) { skipped.push(`${label} over the ${max} comment limit`); continue; }
    comments.push({
      path,
      line: endLine,
      side: "RIGHT",
      ...(endLine > startLine ? { start_line: startLine, start_side: "RIGHT" } : {}),
      body,
    });
  }
  return { comments, skipped };
}

async function github(api, token, method, route, body) {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "0-suggestions",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    const hint = response.status === 403 || response.status === 404
      ? " The token needs `pull-requests: write`; pull requests from forks get a read-only token."
      : "";
    throw new Error(`GitHub ${method} ${route} failed with ${response.status}.${hint}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function paged(api, token, route) {
  const items = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = await github(api, token, "GET", `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

export async function main(env = process.env, log = console.log) {
  const reportPath = env.INPUT_REPORT;
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  if (!reportPath || !token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) {
    throw new Error("Set INPUT_REPORT, GITHUB_TOKEN and GITHUB_REPOSITORY.");
  }
  let event = {};
  if (env.GITHUB_EVENT_PATH) { try { event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")); } catch { /* use inputs */ } }
  const number = Number(env.INPUT_PR_NUMBER || event.pull_request?.number);
  const headSha = env.INPUT_COMMIT_SHA || event.pull_request?.head?.sha;
  if (!Number.isSafeInteger(number) || number < 1 || !/^[0-9a-f]{40}$/i.test(headSha ?? "")) {
    throw new Error("A pull request number and head commit sha are required (INPUT_PR_NUMBER, INPUT_COMMIT_SHA).");
  }
  const max = Math.min(Number.parseInt(env.INPUT_MAX_COMMENTS ?? "", 10) || MAX_COMMENTS_DEFAULT, 50);
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); }
  catch { throw new Error("The report is not valid JSON."); }

  const base = `/repos/${repository}/pulls/${number}`;
  const pull = await github(api, token, "GET", base);
  if (pull.head?.sha?.toLowerCase() !== headSha.toLowerCase()) {
    log(`Skipped: the pull request head moved on from ${headSha.slice(0, 7)}; the suggestions would be outdated.`);
    return { posted: 0 };
  }
  const files = await paged(api, token, `${base}/files`);
  const existing = (await paged(api, token, `${base}/comments`)).map((comment) => String(comment.body ?? ""));
  const { comments, skipped } = planComments(report, new Map(files.map((file) => [file.filename, file])), existing, max);
  for (const reason of skipped) log(`Skipped ${reason}.`);
  if (comments.length === 0) { log("No suggestions to post."); return { posted: 0 }; }
  if (env.INPUT_DRY_RUN === "true") { log(JSON.stringify({ comments }, null, 2)); return { posted: 0, dryRun: true }; }
  await github(api, token, "POST", `${base}/reviews`, {
    commit_id: headSha,
    event: "COMMENT",
    body: `0 proposed ${comments.length} fix${comments.length === 1 ? "" : "es"} on this pull request. Each is a suggestion you can apply or dismiss.`,
    comments,
  });
  log(`Posted ${comments.length} suggestion${comments.length === 1 ? "" : "s"}.`);
  return { posted: comments.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`::error::${error.message}`); process.exit(1); });
}
