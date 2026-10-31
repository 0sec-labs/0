import { spawnSync } from "node:child_process";

const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@0/core",
    "exec",
    "vitest",
    "run",
    "src/unified-pipeline.dispatch.test.ts",
    "-t",
    "runPipeline — diff-aware review",
    "--reporter=dot",
  ],
  { stdio: "inherit", cwd: new URL("..", import.meta.url) },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
