import { defineConfig } from "vitest/config";

// Dedicated config for the in-process TUI self-tests under test/**.
//
// These mount the real console into OpenTUI's headless renderer, drive it with
// synthetic input, and read back character frames. They are kept OUT of the
// default `test` run (src/**/*.test) because they are heavier (a full app tree
// per launch) and because they mutate process-wide state — `process.env`, the
// settings store — so files must not run in parallel within a worker.
//
// `pool: "forks"` with a single fork and no file parallelism gives each test
// file a clean, isolated process and serializes them, which is what keeps the
// env/settings mutation in `launch()`/`close()` from tearing across files.
export default defineConfig({
  test: {
    include: ["test/**/*.tui.test.ts"],
    // One fork, serialized files. Each launch() mutates process-wide state
    // (process.env, the settings store), so files must not overlap.
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    server: {
      deps: {
        // Inline zod so vitest transforms it in the same module system as the
        // workspace source that imports it. Left external, the named `z` export
        // comes back undefined across vitest's SSR interop under the Bun worker.
        inline: ["zod"],
      },
    },
  },
});
