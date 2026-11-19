import { describe, expect, it } from "vitest";
import { computerLine, osLabel } from "./computers-list";

describe("computers list", () => {
  it("names operating systems in words", () => { expect(osLabel("darwin")).toBe("macOS"); expect(osLabel(undefined)).toBeNull(); expect(osLabel("freebsd")).toBe("freebsd"); });
  it("marks this computer and says the state", () => {
    expect(computerLine({ local: true, os: "darwin", status: "connected" })).toBe("This computer · macOS · Connected");
    expect(computerLine({ local: false, status: "error" })).toBe("Disconnected");
  });
});
