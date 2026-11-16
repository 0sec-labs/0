#!/usr/bin/env node
// Run every check in a named group, keep going after a failure and end with one
// summary of what failed. Replaces long `a && b && c` chains in package.json,
// where the first red check hid every check behind it.
//   node scripts/run-checks.mjs <group>
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const GROUPS = {
  // Main `static` job (needs the shared build).
  static: [
    "pnpm check:architecture",
    "node --test scripts/check-architecture.test.mjs",
    "pnpm check:no-npm-publish",
    "pnpm check:workflow-triggers",
    "pnpm check:image-name",
    "pnpm test:image-name",
    "pnpm lint",
    "pnpm docs:check",
    "pnpm check:docs-commands",
    "pnpm test:docs-pointers",
    "node --test scripts/install-script.test.mjs",
    "pnpm check:update-contract",
  ],
  // Main `browser` job (needs the shared build and Playwright's Chromium).
  browser: [
    "node --test scripts/dashboard-model-catalog-cache.test.mjs scripts/dashboard-model-picker.test.mjs",
    "pnpm test:ci-report-browser",
    "pnpm test:home-paint",
    "pnpm test:web-cli-parity",
    "pnpm test:pr-agent-e2e",
    "pnpm test:webhook-e2e",
    "pnpm test:telemetry",
    "node --test scripts/dashboard-question-flow.test.mjs scripts/dashboard-task-progress.test.mjs scripts/dashboard-autonomy-modes.test.mjs",
    "pnpm test:dashboard",
  ],
  packages: [
    "pnpm --filter @0/bench test:targets",
    "pnpm --filter @0/cli test",
    "pnpm --filter @0/web test",
  ],
  // Cheap script-level contracts: no browser, no network.
  "public-scripts": [
    "pnpm test:dashboard-browser",
    "pnpm test:team-workspace-api",
    "pnpm test:runtime-lock",
    "pnpm test:bundle-skills",
    "pnpm test:public-source-export",
    "pnpm test:dev-engine",
    "node --test scripts/cli-process-smoke.test.mjs",
    "node --test scripts/docker-telemetry-embed.test.mjs",
    "pnpm test:docs-pointers",
    "pnpm test:docs-commands",
    "pnpm test:workflow-triggers",
    "pnpm test:release-notes",
    "pnpm test:no-npm-publish",
    "pnpm check:no-npm-publish",
    "pnpm test:test-changed",
    "pnpm check:release-notes",
    "pnpm check:update-contract",
    "pnpm test:qualification-directories",
    "pnpm test:workbench-image",
    "pnpm test:built-in-keys",
    "node --test scripts/run-checks.test.mjs",
  ],
  public: [
    "pnpm check:architecture",
    "node --test scripts/check-architecture.test.mjs",
    "pnpm test:workspace-support",
    "pnpm test:public:packages",
    "pnpm test:public:scripts",
  ],
};

export function runGroup(name, run = (cmd) => spawnSync(cmd, { shell: true, stdio: "inherit" }).status ?? 1) {
  const commands = GROUPS[name];
  if (!commands) throw new Error(`unknown check group: ${name} (known: ${Object.keys(GROUPS).join(", ")})`);
  const failed = [];
  for (const cmd of commands) {
    console.log(`\n::group::${cmd}`);
    const status = run(cmd);
    console.log("::endgroup::");
    if (status !== 0) {
      console.error(`::error::check failed (${status}): ${cmd}`);
      failed.push(cmd);
    }
  }
  return { total: commands.length, failed };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const name = process.argv[2];
  const { total, failed } = runGroup(name);
  const lines = failed.length
    ? [`${failed.length} of ${total} checks failed in ${name}:`, ...failed.map((c) => `  - ${c}`)]
    : [`all ${total} checks passed in ${name}`];
  console.log(`\n${lines.join("\n")}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${name}\n\n${lines.join("\n")}\n`);
  process.exit(failed.length ? 1 : 0);
}
