import { describe, it, expect } from "vitest";
import { osecDB } from "./database.js";

describe("bounded verification receipt recovery", () => {
  it("bounds and filters by scan, event type and producer before loading payloads", () => {
    const db = new osecDB(":memory:");
    try {
      const config = { target: "https://target.test", mode: "web" as const, depth: "default" as const, format: "json" as const, timeout: 1000, runtime: "api" as const };
      db.createScan(config, "a"); db.createScan(config, "b");
      for (let i = 0; i < 6; i++) db.logEvent({ scanId: "a", stage: "verify", eventType: "tool_artifact", timestamp: i, payload: { tool: i % 2 ? "browser" : "access_control_workflow", marker: i } });
      db.logEvent({ scanId: "b", stage: "verify", eventType: "tool_artifact", timestamp: 100, payload: { tool: "access_control_workflow" } });
      const rows = db.getRecentScanEvents("a", "tool_artifact", 2, ["access_control_workflow"]);
      expect(rows).toHaveLength(2);
      expect(rows.map(row => JSON.parse(row.payload).marker)).toEqual([4, 2]);
      expect(() => db.getRecentScanEvents("a", "tool_artifact", 501)).toThrow(/limit/);
      expect(() => db.getRecentScanEvents("a", "tool_artifact", 5, ["' OR 1=1"])).toThrow(/tools/);
    } finally { db.close(); }
  });
});
