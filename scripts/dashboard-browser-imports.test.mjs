import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("assessment milestone surfaces load without Node-only shared modules", async () => {
  // Vite production builds can prune unused barrel exports. Development
  // modules still evaluate them, so browser imports must stand on their own.
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [
      "packages/dashboard/src/components/access-milestone.tsx",
      "packages/dashboard/src/components/event-timeline.tsx",
      "packages/dashboard/src/lib/hunt-stream.ts",
    ],
    outdir: "/tmp/0-dashboard-boundary-test",
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    treeShaking: false,
    alias: { "@": resolve(repoRoot, "packages/dashboard/src") },
    logLevel: "silent",
  });
});
