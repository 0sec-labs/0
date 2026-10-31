import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Exercise the actual transitive package used by the MCP HTTP server.
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve("@modelcontextprotocol/sdk/server/index.js"));
const expressRequire = createRequire(sdkRequire.resolve("express"));
const qs = expressRequire("qs") as { stringify(value: unknown, options: Record<string, unknown>): string };

describe("MCP HTTP dependency serialization", () => {
  for (const encodeValuesOnly of [false, true]) {
    it(`handles hostile comma-array elements (encodeValuesOnly=${encodeValuesOnly})`, () => {
      const options = { arrayFormat: "comma", encodeValuesOnly };
      const hostile = JSON.parse('{"a":[{"toString":"x"}]}');
      expect(() => qs.stringify(hostile, options)).not.toThrow();
      const plain = Object.assign(Object.create(null), { b: "c" });
      expect(() => qs.stringify({ a: [plain] }, options)).not.toThrow();
      expect(qs.stringify({ a: ["x", "y"] }, options)).toBe(encodeValuesOnly ? "a=x,y" : "a=x%2Cy");
    });
  }
});
