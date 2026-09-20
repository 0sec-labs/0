import { describe, expect, it } from "vitest";
import { describeSpawnFailure } from "./process.js";

// Regression for #72: E2BIG is thrown synchronously out of spawn, so it never
// reached the "error" listener and surfaced as a raw stack trace.
describe("describeSpawnFailure", () => {
  it("explains an oversized argument list and how to reduce it", () => {
    const err = Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });

    const message = describeSpawnFailure(err, "claude", ["-p", "x".repeat(300_000)]);

    expect(message).toContain("too large for one command line");
    expect(message).toContain("--batch-size");
    expect(message).toMatch(/\d{6,} bytes of arguments/);
    expect(message).not.toContain("posix_spawn");
  });

  it("passes other failures through unchanged", () => {
    const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });

    expect(describeSpawnFailure(err, "claude", ["-p", "hi"])).toBe("spawn claude ENOENT");
  });
});
