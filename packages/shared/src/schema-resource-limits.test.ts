import { describe, expect, it } from "vitest";
import { z } from "zod";
import { pocStepActionSchema } from "./finding-schemas.js";
import { SecurityWorkflowBindingsSchema } from "./security-workflows.js";

describe("schema resource limits", () => {
  it("rejects oversized arrays before running element refinements", () => {
    let evaluations = 0;
    const schema = z.array(z.string().superRefine(() => { evaluations++; })).max(2);
    const result = schema.safeParse(Array.from({ length: 10_000 }, () => "untrusted"));
    expect(result.success).toBe(false);
    expect(evaluations).toBe(0);
    expect(schema.safeParse(["bounded"]).success).toBe(true);
    expect(evaluations).toBe(1);
  });

  it("validates dictionary values after the Zod 4 explicit key migration", () => {
    const request = { type: "http", method: "GET", url: "https://example.test", headers: { Accept: "application/json" } };
    expect(pocStepActionSchema.parse(request)).toEqual(request);
    expect(pocStepActionSchema.safeParse({ ...request, headers: { Accept: 123 } }).success).toBe(false);
    expect(SecurityWorkflowBindingsSchema.parse({ nested: { count: 1 } })).toEqual({ nested: { count: 1 } });
    expect(SecurityWorkflowBindingsSchema.safeParse(JSON.parse('{"__proto__":{"authorized":true}}')).success).toBe(false);
  });
});
