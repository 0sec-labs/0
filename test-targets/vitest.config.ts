import { defineConfig } from "vitest/config";
import { osecWorkspaceAliases } from "../scripts/config/vitest.workspace-aliases.ts";

export default defineConfig({
  resolve: {
    alias: osecWorkspaceAliases,
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
