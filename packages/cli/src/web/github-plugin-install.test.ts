import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubPluginInstaller, type PluginFetcher } from "./github-plugin-install.js";

const SHA = "a".repeat(40);
const manifest = { id: "acme-scan", name: "Acme Scan", version: "1.0.0", tools: [{ name: "acme_scan", description: "Scan things", parameters: {}, capabilities: ["network", "filesystem-read"] }] };
const entry = Buffer.from("process.stdin.resume();\n");

describe("GitHub plugin install", () => {
  let home: string;
  const fetcher = vi.fn<PluginFetcher>();
  let installer: GithubPluginInstaller; let now = 1_000_000;
  const post = (path: string, body: unknown) => installer.handle(path, "POST", body);
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "zero-gh-plugin-home-")); now = 1_000_000;
    fetcher.mockReset(); fetcher.mockResolvedValue({ sha: SHA, manifest: Buffer.from(JSON.stringify(manifest)), entry });
    installer = new GithubPluginInstaller({ homeDir: home, fetcher, now: () => now });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("pins the SHA, shows permissions and installs nothing at review time", async () => {
    const result = await post("plugins/install-github", { repo: "acme/scan", ref: "v1" });
    expect(result?.status).toBe(200);
    const review = (result!.data as { review: Record<string, unknown> }).review;
    expect(review).toMatchObject({ repo: "acme/scan", ref: "v1", sha: SHA, id: "acme-scan", version: "1.0.0", capabilities: ["network", "filesystem-read"], alreadyInstalled: false });
    expect(fetcher).toHaveBeenCalledWith("acme/scan", "v1");
    expect(existsSync(join(home, ".0", "plugins", "acme-scan"))).toBe(false);
  });

  it("installs only with the reviewed SHA and permission hash, writes provenance, never enables", async () => {
    const review = ((await post("plugins/install-github", { repo: "acme/scan" }))!.data as { review: { reviewId: string; permissionHash: string } }).review;
    for (const wrong of [{ sha: "b".repeat(40), permissionHash: review.permissionHash }, { sha: SHA, permissionHash: "0".repeat(64) }, { sha: SHA, permissionHash: review.permissionHash, approved: false }]) {
      const refused = await post("plugins/install-github/approve", { reviewId: review.reviewId, approved: true, ...wrong });
      expect(refused?.status).toBe(409);
    }
    expect(existsSync(join(home, ".0", "plugins", "acme-scan"))).toBe(false);
    const ok = await post("plugins/install-github/approve", { reviewId: review.reviewId, sha: SHA, permissionHash: review.permissionHash, approved: true });
    expect(ok?.status).toBe(200); expect(ok!.data).toMatchObject({ ok: true, id: "acme-scan", sha: SHA, state: "installed" });
    const dir = join(home, ".0", "plugins", "acme-scan");
    expect(readFileSync(join(dir, "plugin.js"))).toEqual(entry);
    expect(JSON.parse(readFileSync(join(dir, "source.json"), "utf8"))).toMatchObject({ repo: "acme/scan", sha: SHA });
    expect(lstatSync(join(dir, "plugin.js")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, ".0", "plugin-enablement"))).toBe(false);
    // Review is single-use.
    expect((await post("plugins/install-github/approve", { reviewId: review.reviewId, sha: SHA, permissionHash: review.permissionHash, approved: true }))?.status).toBe(409);
  });

  it("updating is a new flow that must opt into replacing the install", async () => {
    const first = ((await post("plugins/install-github", { repo: "acme/scan" }))!.data as { review: { reviewId: string; permissionHash: string } }).review;
    await post("plugins/install-github/approve", { reviewId: first.reviewId, sha: SHA, permissionHash: first.permissionHash, approved: true });
    const second = ((await post("plugins/install-github", { repo: "acme/scan" }))!.data as { review: { reviewId: string; permissionHash: string; alreadyInstalled: boolean } }).review;
    expect(second.alreadyInstalled).toBe(true);
    const refused = await post("plugins/install-github/approve", { reviewId: second.reviewId, sha: SHA, permissionHash: second.permissionHash, approved: true });
    expect((refused!.data as { code: string }).code).toBe("already_installed");
    const replaced = await post("plugins/install-github/approve", { reviewId: second.reviewId, sha: SHA, permissionHash: second.permissionHash, approved: true, replaceExisting: true });
    expect(replaced?.status).toBe(200);
  });

  it("expires reviews", async () => {
    const review = ((await post("plugins/install-github", { repo: "acme/scan" }))!.data as { review: { reviewId: string; permissionHash: string } }).review;
    now += 16 * 60_000;
    expect((await post("plugins/install-github/approve", { reviewId: review.reviewId, sha: SHA, permissionHash: review.permissionHash, approved: true }))!.data).toMatchObject({ code: "review_expired" });
  });

  it("validates repo, ref and manifest before anything is staged", async () => {
    for (const body of [{ repo: "../x" }, { repo: "a/b/c" }, { repo: "acme/scan", ref: "--upload-pack=x" }, { repo: "acme/scan", ref: "a..b" }, {}]) expect((await post("plugins/install-github", body))?.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce({ sha: SHA, manifest: Buffer.from("{not json"), entry });
    expect((await post("plugins/install-github", { repo: "acme/scan" }))!.data).toMatchObject({ code: "invalid_manifest" });
    fetcher.mockResolvedValueOnce({ sha: SHA, manifest: Buffer.from(JSON.stringify({ ...manifest, tools: [{ ...manifest.tools[0], name: "run_command" }] })), entry });
    expect((await post("plugins/install-github", { repo: "acme/scan" }))!.data).toMatchObject({ code: "invalid_manifest" });
    fetcher.mockRejectedValueOnce(new Error("fatal: token ghp_secret leaked"));
    const failed = await post("plugins/install-github", { repo: "acme/scan" });
    expect(failed?.status).toBe(409); expect(JSON.stringify(failed)).not.toContain("ghp_secret");
  });
});
