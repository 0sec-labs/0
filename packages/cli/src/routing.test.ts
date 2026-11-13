import { describe, expect, it } from "vitest";

import { detectAndRoute } from "./routing.js";

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
