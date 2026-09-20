import { describe, expect, it } from "vitest";
import { renderFileUniverse } from "./inventory.js";

// Regression for #72: `file-review --inventory` embedded up to 2000 paths in a
// prompt that is passed as one argv entry, so a deeply nested repository
// (dotnet/sdk) failed the spawn itself with E2BIG before any model call.
describe("renderFileUniverse", () => {
  it("keeps the listing inside the argv budget for deeply nested repositories", () => {
    const files = Array.from(
      { length: 2000 },
      (_, i) => `src/runtime/src/libraries/System.Net.Http/src/System/Net/Http/very/deeply/nested/path/segment/Generated${i}Handler.cs`,
    );

    const rendered = renderFileUniverse(files);

    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(130_000);
    expect(rendered).toContain("omitted for prompt size");
    expect(rendered).toContain("2000 files");
  });

  it("lists everything and says nothing about omissions for a small repository", () => {
    const files = ["src/a.ts", "src/b.cs", "src/c.py"];

    const rendered = renderFileUniverse(files);

    expect(rendered).toBe("File universe (3 files):\nsrc/a.ts\nsrc/b.cs\nsrc/c.py");
    expect(rendered).not.toContain("omitted");
  });
});
