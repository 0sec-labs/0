import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { retainBrowserScreenshot } from "./browser-evidence.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==";
it("does not transmit screenshots when cloud retention is not configured", async () => {
  vi.stubEnv("ZERO_CLOUD_SINK", undefined); vi.stubEnv("ZERO_CLOUD_SCAN_ID", undefined); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect(await retainBrowserScreenshot(png)).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
it("requires a matching durable receipt and strips URL secrets", async () => {
  vi.stubEnv("ZERO_CLOUD_SINK", "https://cloud.test/api"); vi.stubEnv("ZERO_CLOUD_SCAN_ID", "scan"); vi.stubEnv("ZERO_CLOUD_TOKEN", randomUUID()); vi.stubEnv("ZERO_CLOUD_ORG_ID", "org");
  const fetch = vi.fn(async (_url, options) => {
    const meta = JSON.parse(decodeURIComponent(options.headers["x-0-browser-evidence"]));
    expect(meta.url).toBe("https://target.test/path");
    const sha = options.headers["x-0-artifact-sha256"];
    return new Response(JSON.stringify({ artifact: { sha256: sha, reference: `0-scan-artifact/v1/scan/${sha}`, media_type: "image/png", size_bytes: options.body.length } }), { status: 201 });
  }); vi.stubGlobal("fetch", fetch);
  expect(await retainBrowserScreenshot(png, undefined, "https://user:secret@target.test/path?token=secret#secret")).toMatchObject({ reference: expect.stringContaining("0-scan-artifact/v1/scan/") });
});
it("does not infer retention from HTTP success with wrong receipt", async () => {
  vi.stubEnv("ZERO_CLOUD_SINK", "https://cloud.test"); vi.stubEnv("ZERO_CLOUD_SCAN_ID", "scan");
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"artifact":{}}', {status: 201})));
  await expect(retainBrowserScreenshot(png)).rejects.toThrow("Invalid screenshot receipt");
});
