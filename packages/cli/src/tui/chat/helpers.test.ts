import { describe, expect, it } from "vitest";

import { activityExcerpt, reasoningExcerpt, toolActivity } from "./helpers.js";

describe("live chat activity", () => {
  it("uses completed reasoning or a stable phrase, not every partial token", () => {
    expect(reasoningExcerpt("Checking the request headers to locate the failure.")).toBe("Checking the request headers to locate the failure.");
    const first = "Reviewing the call path through the provider's response";
    expect(reasoningExcerpt(first)).toBe("Reviewing the call path through the provider's");
    expect(reasoningExcerpt(`${first} before editing`)).toBe(reasoningExcerpt(first));
    expect(reasoningExcerpt("Checking the request")).toBe("");
    expect(reasoningExcerpt("Checking the request", true)).toBe("Checking the request");
  });

  it("withholds credential-bearing excerpts and URL query details", () => {
    expect(toolActivity("bash", "curl -H 'Authorization: Bearer MY_PRIVATE_VALUE' https://example.test/a"))
      .toBe("bash · sensitive details omitted");
    expect(toolActivity("bash", "MY_TOKEN=MY_PRIVATE_VALUE run scanner"))
      .toBe("bash · sensitive details omitted");
    expect(reasoningExcerpt("The password is MY_PRIVATE_VALUE. Next I will inspect the handler."))
      .not.toContain("MY_PRIVATE_VALUE");
    expect(activityExcerpt("GET https://example.test/a?session=MY_PRIVATE_VALUE#fragment"))
      .toBe("GET https://example.test/a?[redacted]");
    expect(activityExcerpt("GET https://example.test/a?foo=MY_PRIVATE_VALUE#fragment"))
      .toBe("GET https://example.test/a?[redacted]");
  });

  it("bounds actual tool targets and strips terminal controls", () => {
    const label = toolActivity("read_file", `src/${"directory/".repeat(20)}handler.ts\u001b[31m`);
    expect(label).toContain("read_file · src/");
    expect(label.length).toBeLessThanOrEqual(88);
    expect(label).not.toContain("\u001b");
  });
});
