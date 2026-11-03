import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function invokeBuilder(profile: string) {
  const root = mkdtempSync(join(tmpdir(), "0-kernel-build-contract-"));
  roots.push(root);
  const bin = join(root, "bin");
  const kernelTree = join(root, "untrusted kernel tree");
  const output = join(root, "build output");
  const log = join(root, "docker-calls.jsonl");
  mkdirSync(bin);
  mkdirSync(kernelTree);
  // Exercise the real shell wrapper, intercepting Docker before it can build
  // an image or execute source. JSON preserves argument boundaries and spaces.
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.ZERO_KERNEL_BUILD_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n`, { mode: 0o755 });
  const result = spawnSync("bash", [join(scriptDir, "build-from-tree.sh"), kernelTree, output, profile], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ZERO_KERNEL_BUILD_TEST_LOG: log, ZERO_KERNEL_VM_MAKE_JOBS: "3" },
  });
  const calls: string[][] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { result, calls, kernelTree, output };
}

describe.skipIf(process.platform === "win32")("local kernel-tree build isolation", () => {
  it.each(["kasan", "kcsan"])("builds %s without privileged execution while retaining its artifact contract", profile => {
    const { result, calls, kernelTree, output } = invokeBuilder(profile);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "build", "--build-arg", "KERNEL_MAKE_JOBS=3", "-t", "0-kernel-builder-local",
      "-f", join(scriptDir, "Dockerfile.local-tree"), scriptDir,
    ]);
    const run = calls[1];
    expect(run[0]).toBe("run");
    expect(run.some(arg => arg === "--privileged" || arg.startsWith("--privileged="))).toBe(false);
    expect(run).toEqual([
      "run", "--rm", "-e", `HOST_UID=${process.getuid!()}`, "-e", `HOST_GID=${process.getgid!()}`,
      "-e", `CONFIG_PROFILE=${profile}`, "-v", `${kernelTree}:/src/linux:ro`,
      "-v", `${output}:/out`, "0-kernel-builder-local",
    ]);
    expect(existsSync(output)).toBe(true);
  });

  it("rejects an unsupported profile before invoking Docker", () => {
    const { result, calls } = invokeBuilder("unknown-profile");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unsupported kernel config profile");
    expect(calls).toEqual([]);
  });
});
