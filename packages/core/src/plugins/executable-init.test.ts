import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ExecutablePluginManager } from "./executable.js";
import { SelfExtensionRegistry } from "./self-extension.js";
import { BUILTIN_GUARDS } from "./guards.js";
it("keeps lazy initialization failure observable without an unhandled dashboard rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-executable-init-"));
  try {
    const path = join(root, "not-a-directory");
    writeFileSync(path, "fixture");
    const manager = new ExecutablePluginManager({ root: path, registry: new SelfExtensionRegistry({ enabled: true, baseGuards: BUILTIN_GUARDS }), backend: "docker", image: "unused" });
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(manager.ready).rejects.toThrow("unsafe evolution directory");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
