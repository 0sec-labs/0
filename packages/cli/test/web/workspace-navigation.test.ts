import { expect, test } from "vitest";
import { canonicalWorkspacePath, WORKSPACE_DESTINATIONS } from "../../../dashboard/src/lib/workspace-navigation";

test("desktop and touch destinations share canonical work pages", () => {
  expect(WORKSPACE_DESTINATIONS.map(item => item.to)).toEqual([
    "/console", "/runs", "/findings", "/automations", "/skills", "/workers", "/plugins", "/learning", "/settings",
  ]);
  expect(new Set(WORKSPACE_DESTINATIONS.map(item => item.to)).size).toBe(WORKSPACE_DESTINATIONS.length);
  for (const item of WORKSPACE_DESTINATIONS) expect(canonicalWorkspacePath(item.to)).toBe(item.to);
});

test("compatibility paths preserve resource identities and only replace whole route segments", () => {
  expect(canonicalWorkspacePath("/scans/scan%3Aone")).toBe("/runs/scan%3Aone");
  expect(canonicalWorkspacePath("/threads/fingerprint")).toBe("/findings/fingerprint");
  expect(canonicalWorkspacePath("/operations")).toBe("/dashboard");
  for (const alias of ["workflows", "audits", "launcher", "launch"]) expect(canonicalWorkspacePath(`/${alias}`)).toBe("/automations");
  for (const path of ["/launchpad", "/scans-extra", "/findings/scans", "/console/workflows"]) expect(canonicalWorkspacePath(path)).toBe(path);
});
