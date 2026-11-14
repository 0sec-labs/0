import { expect, test } from "vitest";
import { canonicalWorkspacePath, WORKSPACE_DESTINATIONS } from "../src/lib/workspace-navigation";

test("desktop and touch destinations share canonical work pages", () => {
  expect(WORKSPACE_DESTINATIONS.map(item => item.to)).toEqual([
    "/chats", "/findings", "/automations", "/plugins/skills", "/engines", "/plugins", "/learning", "/settings",
  ]);
  expect(new Set(WORKSPACE_DESTINATIONS.map(item => item.to)).size).toBe(WORKSPACE_DESTINATIONS.length);
  for (const item of WORKSPACE_DESTINATIONS) expect(canonicalWorkspacePath(item.to)).toBe(item.to);
});

test("compatibility paths preserve resource identities and only replace whole route segments", () => {
  expect(canonicalWorkspacePath("/scans/scan%3Aone")).toBe("/runs/scan%3Aone");
  expect(canonicalWorkspacePath("/threads/fingerprint")).toBe("/findings/fingerprint");
  expect(canonicalWorkspacePath("/console")).toBe("/chats");
  expect(canonicalWorkspacePath("/console/abc")).toBe("/chats/abc");
  expect(canonicalWorkspacePath("/console/saved/abc")).toBe("/chats/saved/abc");
  expect(canonicalWorkspacePath("/workers")).toBe("/engines");
  expect(canonicalWorkspacePath("/engagements")).toBe("/scope");
  expect(canonicalWorkspacePath("/skills")).toBe("/plugins/skills");
  expect(canonicalWorkspacePath("/operations")).toBe("/dashboard");
  for (const alias of ["workflows", "audits", "launcher", "launch"]) expect(canonicalWorkspacePath(`/${alias}`)).toBe("/automations");
  for (const path of ["/launchpad", "/scans-extra", "/findings/scans", "/chats/workflows"]) expect(canonicalWorkspacePath(path)).toBe(path);
});
