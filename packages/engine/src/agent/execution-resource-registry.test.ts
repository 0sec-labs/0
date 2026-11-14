import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { observeExecutionResources, trackExecutionResourceSpawn, type ExecutionResourceEvent } from "./execution-resource-registry.js";

describe("execution spawn ownership", () => {
  it("publishes intent before the OS spawn and registers its actual child", async () => {
    const events: ExecutionResourceEvent[] = [];
    const dispose = observeExecutionResources(event => events.push(event));
    try {
      const child = trackExecutionResourceSpawn(() => {
        expect(events.map(event => event.type)).toEqual(["creating"]);
        return spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      });
      await once(child, "close");
      expect(events.map(event => event.type)).toEqual(["creating", "registered"]);
      expect(events[1]).toMatchObject({ pid: child.pid });
    } finally { dispose(); }
  });
  it("settles synchronous spawn rejection without claiming a child exists", () => {
    const events: ExecutionResourceEvent[] = [];
    const dispose = observeExecutionResources(event => events.push(event));
    try {
      expect(() => trackExecutionResourceSpawn(() => { throw new Error("synthetic spawn rejection"); })).toThrow("synthetic spawn rejection");
      expect(events.map(event => event.type)).toEqual(["creating", "failed"]);
    } finally { dispose(); }
  });
  it("settles an asynchronous missing-executable rejection", async () => {
    const events: ExecutionResourceEvent[] = [];
    const dispose = observeExecutionResources(event => events.push(event));
    try {
      const child = trackExecutionResourceSpawn(() => spawn("/nonexistent/zero-owned-fixture", [], { stdio: "ignore" }));
      await new Promise<void>(resolve => child.once("error", () => resolve()));
      expect(events.map(event => event.type)).toEqual(["creating", "failed"]);
    } finally { dispose(); }
  });
});
