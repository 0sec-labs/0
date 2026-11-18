import { expect, test } from "vitest";
import { LEGACY_REDIRECTS, canonicalWorkspacePath, isSidebarDestinationActive, SIDEBAR_DESTINATIONS, WORKSPACE_DESTINATIONS } from "../src/lib/workspace-navigation";

test("desktop and touch destinations share canonical work pages", () => {
  expect(WORKSPACE_DESTINATIONS.map(item => item.to)).toEqual([
    "/chats", "/findings", "/sentinels", "/skills", "/memory", "/computers", "/extensions", "/settings",
  ]);
  expect(new Set(WORKSPACE_DESTINATIONS.map(item => item.to)).size).toBe(WORKSPACE_DESTINATIONS.length);
  for (const item of WORKSPACE_DESTINATIONS) expect(canonicalWorkspacePath(item.to)).toBe(item.to);
});

test("compatibility paths preserve resource identities and only replace whole route segments", () => {
  expect(canonicalWorkspacePath("/threads/fingerprint")).toBe("/findings/fingerprint");
  expect(canonicalWorkspacePath("/console")).toBe("/chats");
  expect(canonicalWorkspacePath("/console/abc")).toBe("/chats/abc");
  expect(canonicalWorkspacePath("/console/saved/abc")).toBe("/chats/saved/abc");
  expect(canonicalWorkspacePath("/workers")).toBe("/computers");
  expect(canonicalWorkspacePath("/plugins/skills")).toBe("/skills");
  expect(canonicalWorkspacePath("/plugins/skills/catalog/o~r~x")).toBe("/skills/catalog/o~r~x");
  expect(canonicalWorkspacePath("/agents/abc")).toBe("/sentinels/abc");
  for (const path of ["/launchpad", "/scans-extra", "/findings/scans", "/chats/workflows"]) expect(canonicalWorkspacePath(path)).toBe(path);
});

test("the sidebar lists five destinations after New thread, in order, with no overflow menu", () => {
  expect(SIDEBAR_DESTINATIONS).toEqual(["/findings", "/skills", "/memory", "/computers", "/extensions"]);
  const labels = SIDEBAR_DESTINATIONS.map(to => WORKSPACE_DESTINATIONS.find(item => item.to === to)?.label);
  expect(labels).toEqual(["Findings", "Skills", "Memory", "Computers", "Extensions"]);
});

test("sidebar active state: Skills owns /skills*, Extensions owns /extensions", () => {
  const activeFor = (path: string) => SIDEBAR_DESTINATIONS.filter(to => isSidebarDestinationActive(to, path));
  expect(activeFor("/skills")).toEqual(["/skills"]);
  expect(activeFor("/skills/catalog/o~r~x")).toEqual(["/skills"]);
  expect(activeFor("/sentinels/abc")).toEqual([]);
  expect(activeFor("/extensions")).toEqual(["/extensions"]);
  expect(activeFor("/memory")).toEqual(["/memory"]);
  expect(activeFor("/computers")).toEqual(["/computers"]);
  expect(activeFor("/findings/abc")).toEqual(["/findings"]);
  expect(activeFor("/settings")).toEqual([]);
});

test("the old Explore URLs redirect to Extensions through the one legacy table", () => {
  const row = LEGACY_REDIRECTS.find(item => item.routes.includes("/plugins/explore"));
  expect(row).toMatchObject({ to: "/extensions", keep: "none" });
  expect(LEGACY_REDIRECTS.find(item => item.routes.includes("/explore"))).toBe(row);
});

test("deleted pages redirect to the page that replaced them", () => {
  const target = (route: string) => LEGACY_REDIRECTS.find(item => item.routes.includes(route))?.to;
  for (const route of ["/runs/:scanId", "/scans", "/scope", "/engagements", "/operations", "/dashboard"]) expect(target(route)).toBe("/findings");
  for (const route of ["/automations", "/workflows", "/launch"]) expect(target(route)).toBe("/sentinels");
  expect(target("/plugins/skills")).toBe("/skills");
  expect(LEGACY_REDIRECTS.every(row => row.routes.every(route => !WORKSPACE_DESTINATIONS.some(item => item.to === route)))).toBe(true);
});

test("sentinels are drawn with the Agent glyph everywhere, not lucide's Bot", async () => {
  const { CapyAgentIcon } = await import("../src/ui/icons/capy");
  expect(WORKSPACE_DESTINATIONS.find((item) => item.to === "/sentinels")?.icon).toBe(CapyAgentIcon);
});
