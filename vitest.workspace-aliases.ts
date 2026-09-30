import { fileURLToPath } from "node:url";

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Resolve workspace deps to TypeScript source so tests do not depend on stale
// or missing dist output from sibling packages.
export const osecWorkspaceAliases = {
  "@0/benchmark/kernel-weaponization-collector": fromRoot(
    "./packages/benchmark/src/kernel-weaponization-collector.ts",
  ),
  "@0/benchmark/bench-integrations": fromRoot(
    "./packages/benchmark/src/bench-integrations/index.ts",
  ),
  "@0/core": fromRoot("./packages/core/src/index.ts"),
  "@0/db": fromRoot("./packages/db/src/index.ts"),
  "@0/shared": fromRoot("./packages/shared/src/index.ts"),
  "@0/templates": fromRoot("./packages/templates/src/index.ts"),
};
