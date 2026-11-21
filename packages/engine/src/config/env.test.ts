import { describe, expect, it } from "vitest";
import { envFlag, envInt, envString } from "./env.js";

const ENV = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe("envFlag", () => {
  it.each(["0", "false", "off", "no", "", "FALSE", " Off "])("%j is false", (v) => {
    expect(envFlag("X", true, ENV({ X: v }))).toBe(false);
  });
  it.each(["1", "true", "on", "yes", "TRUE", " Yes "])("%j is true", (v) => {
    expect(envFlag("X", false, ENV({ X: v }))).toBe(true);
  });
  it("uses the default when unset or unrecognised", () => {
    expect(envFlag("X", true, ENV({}))).toBe(true);
    expect(envFlag("X", false, ENV({}))).toBe(false);
    expect(envFlag("X", true, ENV({ X: "maybe" }))).toBe(true);
    expect(envFlag("X", false, ENV({ X: "maybe" }))).toBe(false);
  });
});

describe("envInt / envString", () => {
  it("parses integers and falls back", () => {
    expect(envInt("N", 5, ENV({ N: " 42 " }))).toBe(42);
    expect(envInt("N", 5, ENV({ N: "-3" }))).toBe(-3);
    expect(envInt("N", 5, ENV({ N: "4.5" }))).toBe(5);
    expect(envInt("N", 5, ENV({ N: "abc" }))).toBe(5);
    expect(envInt("N", 5, ENV({ N: "" }))).toBe(5);
    expect(envInt("N", 5, ENV({}))).toBe(5);
  });
  it("trims strings and falls back when blank", () => {
    expect(envString("S", "d", ENV({ S: " v " }))).toBe("v");
    expect(envString("S", "d", ENV({ S: "  " }))).toBe("d");
    expect(envString("S", undefined, ENV({}))).toBeUndefined();
  });
});
