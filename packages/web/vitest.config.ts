import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

// Browser-app unit tests live in test/ (they previously sat in packages/cli/test/web).
export default defineConfig({
  resolve: { alias: { "@": resolve(rootDir, "src") } },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
