import { describe, expect, it } from "vitest";
import { readTimeoutMs } from "@/api";

describe("readTimeoutMs", () => {
  it("gives a plain read 30 seconds and a long poll its wait plus a margin", () => {
    expect(readTimeoutMs("/api/console/sessions/a?window=40")).toBe(30_000);
    expect(readTimeoutMs("/api/console/sessions/a/events?after=3&wait=25")).toBe(40_000);
    expect(readTimeoutMs("/api/console/providers?wait=1")).toBe(30_000);
    expect(readTimeoutMs("/api/x?wait=60&window=1")).toBe(75_000);
  });
});
