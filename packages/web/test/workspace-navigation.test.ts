import { expect, test } from "vitest";
import { canonicalWorkspacePath, isSidebarDestinationActive, legacyExploreSkillsRedirect, SIDEBAR_DESTINATIONS, WORKSPACE_DESTINATIONS } from "../src/lib/workspace-navigation";

test("desktop and touch destinations share canonical work pages", () => {
  expect(WORKSPACE_DESTINATIONS.map(item => item.to)).toEqual([
    "/chats", "/findings", "/automations", "/plugins/skills", "/memory", "/computers", "/plugins/explore", "/plugins", "/settings",
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
  expect(canonicalWorkspacePath("/workers")).toBe("/computers");
  expect(canonicalWorkspacePath("/engagements")).toBe("/scope");
  expect(canonicalWorkspacePath("/skills")).toBe("/plugins/skills");
  expect(canonicalWorkspacePath("/operations")).toBe("/dashboard");
  for (const alias of ["workflows", "audits", "launcher", "launch"]) expect(canonicalWorkspacePath(`/${alias}`)).toBe("/automations");
  for (const path of ["/launchpad", "/scans-extra", "/findings/scans", "/chats/workflows"]) expect(canonicalWorkspacePath(path)).toBe(path);
});

test("the sidebar lists six destinations after New thread, in order, with no overflow menu", () => {
  expect(SIDEBAR_DESTINATIONS).toEqual(["/findings", "/automations", "/plugins/skills", "/memory", "/computers", "/plugins/explore"]);
  const labels = SIDEBAR_DESTINATIONS.map(to => WORKSPACE_DESTINATIONS.find(item => item.to === to)?.label);
  expect(labels).toEqual(["Findings", "Automations", "Skills", "Memory", "Computers", "Explore"]);
});

test("sidebar active state: Skills owns /plugins/skills*, Explore the other plugin pages", () => {
  const activeFor = (path: string) => SIDEBAR_DESTINATIONS.filter(to => isSidebarDestinationActive(to, path));
  expect(activeFor("/plugins/skills")).toEqual(["/plugins/skills"]);
  expect(activeFor("/plugins/skills/catalog/o~r~x")).toEqual(["/plugins/skills"]);
  expect(activeFor("/plugins/explore")).toEqual(["/plugins/explore"]);
  expect(activeFor("/plugins")).toEqual(["/plugins/explore"]);
  expect(activeFor("/plugins/cloudflare")).toEqual(["/plugins/explore"]);
  expect(activeFor("/memory")).toEqual(["/memory"]);
  expect(activeFor("/computers")).toEqual(["/computers"]);
  expect(activeFor("/findings/abc")).toEqual(["/findings"]);
  expect(activeFor("/settings")).toEqual([]);
});

test("old Explore skills URLs redirect to Skills > Browse; other Explore URLs do not", () => {
  expect(legacyExploreSkillsRedirect("?tab=skills")).toBe("/plugins/skills?tab=browse");
  expect(legacyExploreSkillsRedirect("?tab=skill&q=semgrep&page=2")).toBe("/plugins/skills?tab=browse&q=semgrep");
  expect(legacyExploreSkillsRedirect("?tab=themes")).toBeNull();
  expect(legacyExploreSkillsRedirect("")).toBeNull();
});
