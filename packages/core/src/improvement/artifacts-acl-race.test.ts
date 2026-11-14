import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { assertPrivateStorage } from "./private-storage.js";
import { readEvolutionArtifact } from "./artifacts.js";
vi.mock("./private-storage.js", () => ({ assertPrivateStorage: vi.fn() }));
it("rejects artifact pathname replacement during the native ACL probe", () => {
  const root = mkdtempSync(join(tmpdir(), "zero-acl-swap-"));
  const path = join(root, "receipt.json");
  try {
    writeFileSync(path, '{"original":true}', { mode: 0o600 });
    vi.mocked(assertPrivateStorage).mockImplementation(() => {
      renameSync(path, join(root, "original.json"));
      writeFileSync(path, '{"replacement":true}', { mode: 0o600 });
    });
    expect(() => readEvolutionArtifact(path)).toThrow("unsafe evolution artifact");
  } finally { vi.mocked(assertPrivateStorage).mockReset(); rmSync(root, { recursive: true, force: true }); }
});
