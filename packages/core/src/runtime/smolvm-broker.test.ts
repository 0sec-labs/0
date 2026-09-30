import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { startWorkbenchBroker } from "./smolvm-broker.js";

const qualifiedHost = process.platform === "darwin" && process.arch === "arm64" && process.getuid?.() !== 0;

describe.skipIf(!qualifiedHost)("host sibling broker authority boundary", () => {
  it("refuses host-path/env requests, unapproved images and linked authority without executing a child", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "0-broker-boundary-")));
    const privateRoot = join(root, "private");
    await mkdir(privateRoot, { mode: 0o700 });
    // An explicit fake operator approval suffices for decoder refusals; no VM
    // should reach this archive, which intentionally is not a container image.
    const archive = join(root, "approved.tar");
    const bytes = Buffer.from("bounded fake authority approval");
    await writeFile(archive, bytes, { mode: 0o600 });
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const runtimeId = randomBytes(32).toString("hex");
    const secret = "FAKE_AUTHORITY_CANARY_MUST_NOT_LEAVE_PRIVATE_ROOT";
    const canary = join(root, "authority");
    await writeFile(canary, secret, { mode: 0o600 });
    const broker = await startWorkbenchBroker({ root: privateRoot, imageArchive: archive, imageDigest: digest, runtimeId });
    async function receipt(id: string): Promise<{ type: string; execution: { stdout: string; error: string } }> {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { return JSON.parse(await readFile(join(broker.guestRoot, `${id}.output.0.json`), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await delay(10); }
      }
      throw new Error("Bounded broker refusal did not arrive");
    }
    const base = { protocol: 1, runtimeId, profile: "offline", command: ["/bin/sh", "-c", "exit 0"], interactive: false, files: [],
      timeoutMs: 1000, memoryMb: 128, cpus: 1, maxOutputBytes: 1024 };
    try {
      const hostPathId = randomBytes(24).toString("hex");
      await writeFile(join(broker.guestRoot, `${hostPathId}.request.json`), JSON.stringify({ ...base, id: hostPathId, workspaceRoot: root, environment: { SECRET: secret } }));
      const hostPath = await receipt(hostPathId);
      expect(hostPath.execution.error).toMatch(/identity or fields/);
      expect(hostPath.execution.stdout).toBe("");

      const imageId = randomBytes(24).toString("hex");
      await writeFile(join(broker.guestRoot, `${imageId}.request.json`), JSON.stringify({ ...base, id: imageId, imageReference: `unapproved.invalid/tool@sha256:${"a".repeat(64)}` }));
      expect((await receipt(imageId)).execution.error).toMatch(/not explicitly approved/);

      // V8's grouped/repeated base64 regex used to exhaust its stack at this
      // advertised boundary, even though the decoded bytes were valid.
      const maximumId = randomBytes(24).toString("hex");
      const maximum = Buffer.alloc(4 * 1024 * 1024);
      await writeFile(join(broker.guestRoot, `${maximumId}.request.json`), JSON.stringify({ ...base, id: maximumId,
        imageReference: `unapproved.invalid/tool@sha256:${"a".repeat(64)}`,
        files: [{ path: "maximum.bin", digest: `sha256:${createHash("sha256").update(maximum).digest("hex")}`, data: maximum.toString("base64"), mode: 0o600 }] }));
      expect((await receipt(maximumId)).execution.error).toMatch(/not explicitly approved/);

      const traversalId = randomBytes(24).toString("hex");
      await writeFile(join(broker.guestRoot, `${traversalId}.request.json`), JSON.stringify({ ...base, id: traversalId,
        files: [{ path: "../authority", digest, data: bytes.toString("base64"), mode: 0o600 }] }));
      expect((await receipt(traversalId)).execution.error).toMatch(/file path/);

      const linkedId = randomBytes(24).toString("hex");
      await symlink(canary, join(broker.guestRoot, `${linkedId}.request.json`));
      const linked = await receipt(linkedId);
      expect(linked.type).toBe("complete");
      expect(linked.execution.error).toMatch(/identity or fields/);
      expect(JSON.stringify(linked)).not.toContain(secret);

      const hardlinkedId = randomBytes(24).toString("hex");
      await link(canary, join(broker.guestRoot, `${hardlinkedId}.request.json`));
      const hardlinked = await receipt(hardlinkedId);
      expect(hardlinked.execution.error).toMatch(/identity or fields/);
      expect(JSON.stringify(hardlinked)).not.toContain(secret);

      const httpId = randomBytes(24).toString("hex");
      await writeFile(join(broker.guestRoot, `${httpId}.request.json`), JSON.stringify({ ...base, id: httpId, profile: "http", httpTarget: "http://127.0.0.1:9/" }));
      expect((await receipt(httpId)).execution.error).toMatch(/did not grant HTTP/);

      const cancelledId = randomBytes(24).toString("hex");
      await writeFile(join(broker.guestRoot, `${cancelledId}.cancel.json`), JSON.stringify({ cancel: true }));
      await writeFile(join(broker.guestRoot, `${cancelledId}.request.json`), JSON.stringify({ ...base, id: cancelledId }));
      expect((await receipt(cancelledId)).execution.error).toMatch(/cancelled before VM admission/);
      await broker.close();
      expect(await readdir(privateRoot)).toEqual([]);
    } finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
  });
});
