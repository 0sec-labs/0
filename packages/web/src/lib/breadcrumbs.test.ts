import { describe, expect, it, vi } from "vitest";

// No DOM in this package's vitest env: stub the two React primitives the hooks use so effects run synchronously.
const setters = { setLabel: vi.fn(), setActions: vi.fn() };
const cleanups: Array<() => void> = [];
let provided: unknown = setters;
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useContext: () => provided,
    useEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
  };
});

const { resolveCrumbs, useBreadcrumbLabel, useBreadcrumbActions } = await import("./breadcrumbs");

describe("resolveCrumbs", () => {
  const table: Array<[string, string, string | undefined, unknown]> = [
    ["/chats", "", undefined, null],
    ["/chats/abc", "", undefined, null],
    ["/findings", "", undefined, [{ label: "Findings" }]],
    ["/findings/fp1", "", undefined, [{ label: "Findings", to: "/findings" }, { label: "Finding" }]],
    ["/findings/fp1", "", "SQL injection", [{ label: "Findings", to: "/findings" }, { label: "SQL injection" }]],
    ["/agents", "", undefined, [{ label: "Agents" }]],
    ["/agents/s1", "", "Edge watch", [{ label: "Agents", to: "/agents" }, { label: "Edge watch" }]],
    ["/skills", "", undefined, [{ label: "Skills", to: "/skills" }, { label: "Installed" }]],
    ["/skills", "?tab=browse", undefined, [{ label: "Skills", to: "/skills" }, { label: "Browse" }]],
    ["/skills", "?skill=review", "Code review", [{ label: "Skills", to: "/skills" }, { label: "Installed", to: "/skills" }, { label: "Code review" }]],
    ["/skills/catalog/o~r~x", "", "Semgrep Scan", [{ label: "Skills", to: "/skills" }, { label: "Browse", to: "/skills?tab=browse" }, { label: "Semgrep Scan" }]],
    ["/extensions", "", undefined, [{ label: "Extensions" }]],
    ["/computers", "", undefined, [{ label: "Computers" }]],
    ["/memory", "", undefined, [{ label: "Memory" }]],
    ["/settings", "", undefined, [{ label: "Settings", to: "/settings" }, { label: "General" }]],
    ["/settings", "?section=appearance", undefined, [{ label: "Settings", to: "/settings" }, { label: "Appearance" }]],
    ["/settings", "?section=transcript", undefined, [{ label: "Settings", to: "/settings" }, { label: "Threads" }]],
    ["/settings", "?section=bogus", undefined, [{ label: "Settings", to: "/settings" }, { label: "General" }]],
    ["/console/models", "", undefined, [{ label: "Settings", to: "/settings" }, { label: "Models" }]],
    ["/doctor/", "", undefined, [{ label: "Settings", to: "/settings" }, { label: "Diagnostics" }]],
    ["/team", "", undefined, [{ label: "Settings", to: "/settings" }, { label: "Members" }]],
  ];
  it.each(table)("%s%s (%s)", (path, search, label, expected) => {
    expect(resolveCrumbs(path, search, label)).toEqual(expected);
  });
  it("ignores blank labels", () => {
    expect(resolveCrumbs("/computers", "", "  ")).toEqual([{ label: "Computers" }]);
  });
});

describe("breadcrumb hooks", () => {
  it("publishes and clears the label", () => {
    useBreadcrumbLabel("Cloudflare");
    expect(setters.setLabel).toHaveBeenLastCalledWith("Cloudflare");
    cleanups.pop()!();
    expect(setters.setLabel).toHaveBeenLastCalledWith(undefined);
  });
  it("publishes and clears actions", () => {
    const node = "actions";
    useBreadcrumbActions(node);
    expect(setters.setActions).toHaveBeenLastCalledWith(node);
    cleanups.pop()!();
    expect(setters.setActions).toHaveBeenLastCalledWith(null);
  });
  it("is a no-op outside the shell", () => {
    provided = null;
    const before = cleanups.length;
    expect(() => { useBreadcrumbLabel("x"); useBreadcrumbActions(null); }).not.toThrow();
    expect(cleanups.length).toBe(before);
  });
});
