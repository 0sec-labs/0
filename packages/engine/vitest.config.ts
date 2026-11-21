import { defineConfig } from "vitest/config";
import { osecWorkspaceAliases } from "../../scripts/config/vitest.workspace-aliases.ts";

export default defineConfig({
  resolve: {
    alias: osecWorkspaceAliases,
  },
  test: {
    include: ["src/**/*.test.ts"],
    // Threads and scans read Memory only when a test opts in; never touch the real ~/.0/memory.
    env: { ZERO_DISABLE_MEMORY: "1" },
    // Keep native-addon and SQLite work bounded on the shared CI runner; use the cores on a developer machine.
    maxWorkers: process.env.CI ? 2 : undefined,
    // Persistence suites perform real fsync/SQLite round trips, not mocked I/O.
    // Their default deadline must tolerate shared-runner disk contention;
    // tests of actual runtime deadlines retain their explicit timeouts.
    testTimeout: 30_000,
  },
});
