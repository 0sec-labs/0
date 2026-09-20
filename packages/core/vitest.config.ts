import { defineConfig } from "vitest/config";
import { osecWorkspaceAliases } from "../../vitest.workspace-aliases.ts";

export default defineConfig({
  resolve: {
    alias: osecWorkspaceAliases,
  },
  test: {
    include: ["src/**/*.test.ts"],
    // Keep native-addon and SQLite work bounded on the shared CI runner.
    maxWorkers: 2,
    // Persistence suites perform real fsync/SQLite round trips, not mocked I/O.
    // Their default deadline must tolerate shared-runner disk contention;
    // tests of actual runtime deadlines retain their explicit timeouts.
    testTimeout: 30_000,
  },
});
