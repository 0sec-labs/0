import { describe, expect, it } from "vitest";
import { assertTargetReachable, describeUnreachable } from "../target-reachability.js";

const refused = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));

describe("assertTargetReachable", () => {
  it("names a refused connection and says no scan was started", async () => {
    await expect(assertTargetReachable("http://127.0.0.1:1/", { fetchImpl: refused as unknown as typeof fetch })).rejects.toThrow(/refused the connection.*No scan was started/);
  });
  it("names an unknown host and a timeout", async () => {
    const dns = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    await expect(assertTargetReachable("https://x.invalid/", { fetchImpl: dns as unknown as typeof fetch })).rejects.toThrow(/Could not find the host/);
    const slow = () => Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    await expect(assertTargetReachable("https://x.test/", { fetchImpl: slow as unknown as typeof fetch })).rejects.toThrow(/did not answer in time/);
  });
  it("treats any HTTP answer as reachable, and never blocks on a failure it cannot classify", async () => {
    await expect(assertTargetReachable("https://x.test/", { fetchImpl: (async () => new Response("no", { status: 401 })) as typeof fetch })).resolves.toBeUndefined();
    const cert = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } }));
    await expect(assertTargetReachable("https://x.test/", { fetchImpl: cert as unknown as typeof fetch })).resolves.toBeUndefined();
    expect(describeUnreachable("https://x.test/", new Error("boom"))).toBeUndefined();
  });
  it("ignores targets that are not http(s) URLs", async () => {
    await expect(assertTargetReachable("mcp://server", { fetchImpl: refused as unknown as typeof fetch })).resolves.toBeUndefined();
  });
});
