#!/usr/bin/env node
// Guard: CI must stay lean without weakening the release gate.
//  - No workflow except main.yml runs on a branch push without a paths filter.
//  - docker-publish.yml must not trigger on plain main pushes or Main runs on main.
//  - release.yml keeps its v* tag trigger and nightly schedule; main.yml runs on v* tags.
//  - release.yml keeps its Main gate: a `main-gate` job that polls `0: Main` for the
//    tag's own run and commit, and the publishing `release` job needs it (and `build`).
//  - docker-publish.yml publishes only after a successful Main on the tag commit and
//    still refuses any image name other than ghcr.io/<owner>/0security.
//  - Every ghcr.io image reference in any workflow is ghcr.io/<owner>/0security, and
//    only docker-publish.yml may push images.
//  - Every third-party action is pinned by a full commit SHA.
// Dependency-free: reads only the top-level `on:` block of each workflow.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const UNFILTERED_PUSH_ALLOWED = new Set(["main.yml"]);

function onBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l) && !/^\s*#/.test(l)) break;
    out.push(l.replace(/\s+#.*$/, ""));
  }
  return out;
}

// Returns the indented lines belonging to `key:` at the given indent inside a block.
function child(block, key, indent) {
  const re = new RegExp(`^ {${indent}}${key}:(.*)$`);
  const i = block.findIndex((l) => re.test(l));
  if (i < 0) return null;
  const inline = block[i].match(re)[1].trim();
  const body = [];
  for (const l of block.slice(i + 1)) {
    if (l.trim() === "" || /^\s*#/.test(l)) continue;
    if (new RegExp(`^ {0,${indent}}\\S`).test(l)) break;
    body.push(l);
  }
  return { inline, body: [inline, ...body].join("\n") };
}

// Returns the text of one top-level job (the lines under `  name:` in `jobs:`), or null.
export function jobBlock(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^  ${name}:\\s*$`).test(l));
  if (start < 0) return null;
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(l) && !/^\s*#/.test(l)) break;
    out.push(l);
  }
  return out.join("\n");
}

export function checkWorkflows(files) {
  const errors = [];
  for (const [name, text] of Object.entries(files)) {
    const block = onBlock(text);
    const push = child(block, "push", 2);
    if (push && !UNFILTERED_PUSH_ALLOWED.has(name)) {
      const branches = child(push.body.split("\n"), "branches", 4);
      const tags = child(push.body.split("\n"), "tags", 4);
      const paths = /(^|\n) {4}paths(-ignore)?:/.test(push.body);
      const everyBranch = branches ? /["']?\*\*["']?/.test(branches.body) : !tags;
      if (everyBranch && !paths) errors.push(`${name}: push on every branch without a paths filter; add paths or restrict branches`);
    }
  }
  const publish = files["docker-publish.yml"];
  if (publish !== undefined) {
    const block = onBlock(publish);
    if (child(block, "push", 2)) errors.push("docker-publish.yml: must not trigger on push (publish on release tags and nightly only)");
    const wr = child(block, "workflow_run", 2);
    if (wr) {
      const br = child(wr.body.split("\n"), "branches", 4);
      if (!br || /\bmain\b|\*\*/.test(br.body) || !/v\*/.test(br.body)) errors.push("docker-publish.yml: workflow_run must be limited to v* release tags, not main");
    }
    if (!child(block, "schedule", 2)) errors.push("docker-publish.yml: nightly schedule for :edge is missing");
  }
  const release = files["release.yml"];
  if (release !== undefined) {
    const block = onBlock(release);
    const push = child(block, "push", 2);
    if (!push || !/tags:\s*\[?\s*["']v\*["']/.test(push.body.replace(/\n\s*-\s*/g, " "))) errors.push('release.yml: push tags "v*" trigger is missing');
    if (!child(block, "schedule", 2)) errors.push("release.yml: nightly dry-run schedule is missing");
  }
  if (release !== undefined) {
    const gate = jobBlock(release, "main-gate");
    if (gate === null) errors.push("release.yml: the `main-gate` job (green Main on the exact tag commit) is missing");
    else {
      if (!/gh run list[^\n]*--workflow main\.yml/.test(gate) || !/--event push/.test(gate) || !/--branch "?\$TAG"?/.test(gate) || !/--commit "?\$sha"?/.test(gate)) errors.push("release.yml: main-gate must look up the `0: Main` push run for this tag and its commit (gh run list --workflow main.yml --event push --branch $TAG --commit $sha)");
      if (!/conclusion == "success"/.test(gate)) errors.push("release.yml: main-gate must require conclusion == success");
      if (/continue-on-error:\s*true/.test(gate)) errors.push("release.yml: main-gate must not continue on error");
    }
    const releaseJob = jobBlock(release, "release");
    if (releaseJob === null) errors.push("release.yml: the `release` publish job is missing");
    else {
      const needs = (releaseJob.match(/^ {4}needs:\s*(.*)$/m) ?? [])[1] ?? "";
      if (!/\bmain-gate\b/.test(needs) || !/\bbuild\b/.test(needs)) errors.push("release.yml: the `release` job must need both `build` and `main-gate`");
    }
    for (const asset of ["0-darwin-arm64", "0-linux-x64", "0-linux-arm64", "0-windows-x64.exe", "checksums.txt"]) {
      if (!release.includes(asset)) errors.push(`release.yml: release asset ${asset} is missing`);
    }
    if (/continue-on-error:\s*true/.test(release)) errors.push("release.yml: no job may continue on error");
  }
  if (publish !== undefined) {
    if (!/RUN_CONCLUSION" = success/.test(publish)) errors.push("docker-publish.yml: must require the Main run to have concluded success");
    if (!/TAG_SHA" = "\$RUN_SHA"/.test(publish)) errors.push("docker-publish.yml: must require the tag to point at the commit Main verified");
    if (!/Refuse any tag outside/.test(publish) || !/ghcr\.io\/\*\/0security:\*\) ;;/.test(publish)) errors.push("docker-publish.yml: the image-name refusal guard is missing");
  }
  for (const [name, text] of Object.entries(files)) {
    text.split("\n").forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      for (const m of line.matchAll(/ghcr\.io\/([^\s"'`]+)/g)) {
        if (!/^[^/]+\/0security(?![\w-])/.test(m[1]) && !/^\*\/0security/.test(m[1])) errors.push(`${name}:${i + 1}: image ghcr.io/${m[1]} is not ghcr.io/<owner>/0security`);
      }
      const uses = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
      if (uses && !uses[1].startsWith("./") && !/@[0-9a-f]{40}$/.test(uses[1])) errors.push(`${name}:${i + 1}: ${uses[1]} must be pinned by a full commit SHA`);
      if (name !== "docker-publish.yml" && /^\s*push:\s*true\s*$/.test(line)) errors.push(`${name}:${i + 1}: only docker-publish.yml may push container images`);
    });
  }
  const main = files["main.yml"];
  if (main !== undefined) {
    const push = child(onBlock(main), "push", 2);
    if (!push || !/tags:\s*\[?\s*["']v\*["']/.test(push.body.replace(/\n\s*-\s*/g, " "))) errors.push('main.yml: push tags "v*" trigger is missing (releases need a full Main on the tag)');
  }
  return errors;
}

function load(dir) {
  const files = {};
  for (const f of readdirSync(dir)) if (/\.ya?ml$/.test(f)) files[f] = readFileSync(join(dir, f), "utf8");
  return files;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const errors = checkWorkflows(load(join(process.argv[2] ?? ".", ".github/workflows")));
  if (errors.length) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log("workflow triggers ok");
}
