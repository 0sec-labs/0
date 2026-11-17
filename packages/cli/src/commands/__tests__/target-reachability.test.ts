import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { assertTargetReachable, describeUnreachable } from "../target-reachability.js";

const failWith = (code: string) => () => Promise.reject(Object.assign(new Error(code), { code }));

describe("assertTargetReachable", () => {
  it("names a refused connection and says no scan was started", async () => {
    await expect(assertTargetReachable("http://127.0.0.1:48999/", { connectImpl: failWith("ECONNREFUSED") })).rejects.toThrow(/refused the connection.*No scan was started/);
  });
  it("names an unknown host and a timeout", async () => {
    await expect(assertTargetReachable("https://x.invalid/", { connectImpl: failWith("ENOTFOUND") })).rejects.toThrow(/Could not find the host/);
    await expect(assertTargetReachable("https://x.test/", { connectImpl: failWith("TIMEOUT") })).rejects.toThrow(/did not answer in time/);
  });
  it("connects to the default port of the scheme and never blocks on a failure it cannot classify", async () => {
    const ports: number[] = [];
    const record = (_host: string, port: number) => { ports.push(port); return Promise.resolve(); };
    await assertTargetReachable("https://x.test/", { connectImpl: record });
    await assertTargetReachable("http://x.test/", { connectImpl: record });
    await assertTargetReachable("http://x.test:8080/", { connectImpl: record });
    expect(ports).toEqual([443, 80, 8080]);
    await expect(assertTargetReachable("https://x.test/", { connectImpl: failWith("ECONNRESET") })).resolves.toBeUndefined();
    expect(describeUnreachable("https://x.test/", new Error("boom"))).toBeUndefined();
  });
  it("ignores targets that are not http(s) URLs", async () => {
    await expect(assertTargetReachable("mcp://server", { connectImpl: failWith("ECONNREFUSED") })).resolves.toBeUndefined();
    await expect(assertTargetReachable("not a url", { connectImpl: failWith("ECONNREFUSED") })).resolves.toBeUndefined();
  });
  it("connects to a real listener and reports a closed port", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    await expect(assertTargetReachable(`http://127.0.0.1:${port}/`)).resolves.toBeUndefined();
    await new Promise((resolve) => server.close(resolve));
    await expect(assertTargetReachable(`http://127.0.0.1:${port}/`)).rejects.toThrow(/refused the connection/);
  });
});
