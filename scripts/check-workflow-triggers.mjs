#!/usr/bin/env node
// Guard: CI must stay lean without weakening the release gate.
//  - No workflow except main.yml runs on a branch push without a paths filter.
//  - docker-publish.yml must not trigger on plain main pushes or Main runs on main.
//  - release.yml keeps its v* tag trigger and nightly schedule; main.yml runs on v* tags.
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
