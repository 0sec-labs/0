import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { RecordedFindingStatus } from "../src/components/recorded-finding-status.js";
const dashboardRequire = createRequire(new URL("../package.json", import.meta.url));
const { renderToStaticMarkup } = dashboardRequire("react-dom/server");

describe("recorded finding status", () => {
  it.each(["discovered", "suspected", "confirmed", "verified", "reported", "fixed"])("renders recorded %s separately from reproduction evidence", status => {
    const html = renderToStaticMarkup(RecordedFindingStatus({ status }));
    expect(html).toContain(`Recorded status: ${status}`);
    expect(html).toContain("Recorded lifecycle label; inspect the evidence to establish reproduction.");
    expect(html).not.toContain("reproduced");
  });
});
