import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../", import.meta.url);
const fromRoot = (path: string): string => fileURLToPath(new URL(path, repoRoot));

// Resolve workspace deps to TypeScript source so tests do not depend on stale
// or missing dist output from sibling packages.
export const osecWorkspaceAliases = {
  "@0/bench/kernel-weaponization-collector": fromRoot(
    "./packages/bench/src/kernel-weaponization-collector.ts",
  ),
  "@0/bench/bench-integrations": fromRoot(
    "./packages/bench/src/bench-integrations/index.ts",
  ),
  // Subpaths first: alias keys match as prefixes, so "@0/engine" must come last.
  "@0/engine/storage": fromRoot("./packages/engine/src/storage/index.ts"),
  "@0/engine/shared": fromRoot("./packages/engine/src/shared/index.ts"),
  "@0/engine/templates": fromRoot("./packages/engine/src/templates/index.ts"),
  "@0/engine/redteam": fromRoot("./packages/engine/src/redteam/index.ts"),
  "@0/engine": fromRoot("./packages/engine/src/index.ts"),
};
