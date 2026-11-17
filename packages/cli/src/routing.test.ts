import { describe, expect, it } from "vitest";

import { detectAndRoute, scanTargetProblem } from "./routing.js";

describe("detectAndRoute", () => {
  it("routes explicit target plans through the corresponding compatibility adapter", () => {
    expect(detectAndRoute("https://app.example.test")).toEqual([
      "scan",
      "web",
      "--target",
      "https://app.example.test",
    ]);
    expect(detectAndRoute("source:./repo")).toEqual([
      "scan",
      "source",
      "./repo",
      "--depth",
      "deep",
    ]);
    expect(detectAndRoute("pypi:requests")).toEqual([
      "scan",
      "package",
      "requests",
      "--ecosystem",
      "pypi",
    ]);
  });

  it("refuses an ambiguous bare token instead of silently starting an audit", () => {
    expect(detectAndRoute("express")).toBeNull();
  });
});

describe("scanTargetProblem", () => {
  const never = () => false;
  it("says a folder is missing for a path-shaped target that is not there, and only then", () => {
    expect(scanTargetProblem(["scan", "./nope"], never)).toMatch(/^No such folder: \.\/nope/);
    expect(scanTargetProblem(["scan", "/tmp/nope"], never)).toMatch(/^No such folder/);
    expect(scanTargetProblem(["scan", "./here"], () => true)).toBeUndefined();
  });
  it("leaves option errors to the module: explicit modules and flags are never checked", () => {
    expect(scanTargetProblem(["scan", "source", "./nope", "--cost-ceiling", "x"], never)).toBeUndefined();
    expect(scanTargetProblem(["scan", "repair", "./nope"], never)).toBeUndefined();
    expect(scanTargetProblem(["scan", "--target", "https://x.test"], never)).toBeUndefined();
    expect(scanTargetProblem(["findings", "./nope"], never)).toBeUndefined();
  });
  it("names the supported forms for an unsupported package source or scheme", () => {
    expect(scanTargetProblem(["scan", "pip:requests"], never)).toContain("Did you mean pypi:requests?");
    expect(scanTargetProblem(["scan", "docker:alpine"], never)).toContain("oci:alpine");
    expect(scanTargetProblem(["scan", "ftp://x.example/"], never)).toContain("Unsupported target");
    expect(scanTargetProblem(["scan", "express"], never)).toContain("Can't tell what \"express\" is");
  });
  it("accepts every supported target form", () => {
    for (const target of ["https://app.example.test", "npm:lodash", "pypi:requests", "cargo:serde", "oci:alpine:3", "source:./repo"]) {
      expect(scanTargetProblem(["scan", target], never)).toBeUndefined();
    }
  });
});
