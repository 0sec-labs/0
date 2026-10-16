import { describe, expect, it } from "vitest";
import { executionDetails, executionLabel } from "../../../dashboard/src/console/execution-status.js";

describe("authoritative web execution labels", () => {
  it("does not infer an execution backend from missing metadata", () => {
    expect(executionLabel()).toBe("Execution unknown");
    expect(executionDetails()).toEqual([]);
  });
  it("keeps selected and admitted SmolVM distinct from an active run", () => {
    expect(executionLabel({ backend: "smolvm", status: "pending" })).toBe("SmolVM · pending");
    expect(executionLabel({ backend: "smolvm", status: "ready" })).toBe("SmolVM · ready");
    expect(executionLabel({ backend: "smolvm", status: "running" })).toBe("SmolVM · running");
    expect(executionLabel({ backend: "local", status: "running" })).toBe("Local · running");
  });
  it("shows only reported workspace, run and resource details", () => {
    expect(executionDetails({ backend: "smolvm", status: "pending", guestWorkspacePath: "/workspace" })).toEqual([]);
    expect(executionDetails({ backend: "smolvm", status: "running", workspacePath: "/tmp/project", guestWorkspacePath: "/workspace", cpus: 2, memoryMb: 2048 })).toEqual(["Workspace: /tmp/project", "Guest: /workspace", "2 CPUs", "2048 MiB memory"]);
  });
});
