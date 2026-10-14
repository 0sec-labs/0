import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ deployWorker: vi.fn() }));
vi.mock("../../worker-deploy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../worker-deploy.js")>();
  return { ...actual, deployWorker: mocks.deployWorker };
});
const { registerWorkerCommand } = await import("../worker.js");

async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerWorkerCommand(program);
  await program.parseAsync(["node", "0", ...argv]);
}

beforeEach(() => mocks.deployWorker.mockReset());
describe("worker deploy command", () => {
  it("deploys to an SSH host and prints the backend result", async () => {
    mocks.deployWorker.mockResolvedValue({ backendId: "ssh-worker", engine: "http://127.0.0.1:8100/", target: "/tmp/zero-engine/work/target", backendsConfig: "/x/backends.json", tokenEnv: "ZERO_SSH_WORKER_TOKEN" });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCli(["worker", "deploy", "--ssh", "ops@build-1", "--target-git", "https://example.test/repo.git"]);
    expect(mocks.deployWorker).toHaveBeenCalledWith(expect.objectContaining({ ssh: "ops@build-1", targetGit: "https://example.test/repo.git" }));
    expect(JSON.parse(String(write.mock.calls[0]![0])).backendId).toBe("ssh-worker");
    write.mockRestore();
  });

  it("rejects a non-numeric engine port before touching the worker", async () => {
    await expect(runCli(["worker", "deploy", "--engine-port", "abc"])).rejects.toThrow(/--engine-port/);
    expect(mocks.deployWorker).not.toHaveBeenCalled();
  });

  it("rejects SSH option injection and shell-bearing git URLs before any network call", async () => {
    await expect(runCli(["worker", "deploy", "--ssh", "-oProxyCommand=touch /tmp/pwned"])).rejects.toThrow(/--ssh/);
    await expect(runCli(["worker", "deploy", "--ssh", "ops@build-1", "--target-git", "https://x.test/r.git'; rm -rf / #"])).rejects.toThrow(/--target-git/);
    expect(mocks.deployWorker).not.toHaveBeenCalled();
  });
});
