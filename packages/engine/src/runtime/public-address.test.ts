import { describe, expect, it } from "vitest";
import { isPublicAddress } from "./public-address.js";

describe("public address check", () => {
  it("rejects private, mapped, and transition addresses while accepting public IPv4 and IPv6", () => {
    expect(isPublicAddress("140.82.114.3")).toBe(true);
    expect(isPublicAddress("2606:50c0:8000::153")).toBe(true);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("100.64.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("2002:7f00:1::1")).toBe(false);
    expect(isPublicAddress("fd00::1")).toBe(false);
  });
});
