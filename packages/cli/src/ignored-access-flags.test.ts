import { afterEach, describe, expect, it, vi } from "vitest";
import { givenAccessOption, noteIgnoredAccessFlags, resetIgnoredAccessNote } from "./ignored-access-flags.js";

describe("ignored access flags note", () => {
  const original = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const setTty = (value: boolean) => Object.defineProperty(process.stderr, "isTTY", { value, configurable: true });
  afterEach(() => { vi.restoreAllMocks(); resetIgnoredAccessNote(); if (original) Object.defineProperty(process.stderr, "isTTY", original); else delete (process.stderr as { isTTY?: boolean }).isTTY; });

  it("prints one dim line once on a TTY", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true); setTty(true);
    expect(noteIgnoredAccessFlags(true)).toBe(true); expect(noteIgnoredAccessFlags(true)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1); expect(String(write.mock.calls[0]![0])).toContain("ignored: there is only one mode");
  });
  it("is silent off a TTY, with --json, or when no flag was given", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setTty(false); expect(noteIgnoredAccessFlags(true)).toBe(false);
    setTty(true); expect(noteIgnoredAccessFlags(true, { json: true })).toBe(false); expect(noteIgnoredAccessFlags(false)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it("recognises every retired option", () => {
    for (const key of ["access", "mode", "yolo", "autonomy", "toolAccess"]) expect(givenAccessOption({ [key]: "x" })).toBe(true);
    expect(givenAccessOption({ model: "x" })).toBe(false);
  });
});
