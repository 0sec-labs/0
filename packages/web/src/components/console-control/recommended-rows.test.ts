import { describe, expect, it } from "vitest";
import { withRecommendedFirst } from "./recommended-rows";

const row = (id: string, providerId = "openai") => ({ key: `${providerId}:${id}`, id, providerId, providerLabel: providerId, detail: "", disabled: false });
describe("withRecommendedFirst", () => {
  it("moves marked picks to the top in role order and keeps the rest", () => {
    const out = withRecommendedFirst([row("a"), row("b"), row("c")], [{ label: "Orchestrator", providerId: "openai", model: "c" }, { label: "Scanner", providerId: "openai", model: "a" }, { label: "Gone", providerId: "openai", model: "zzz" }]);
    expect(out.map(item => item.id)).toEqual(["c", "a", "b"]);
    expect(out.map(item => item.recommended?.label)).toEqual(["Orchestrator", "Scanner", undefined]);
  });
});
