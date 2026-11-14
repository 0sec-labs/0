import { describe, expect, it } from "vitest";
import { applyOrder, commandPreview, draftFingerprint, emptyMcpDraft, entrySubtitle, filterByText, isFullSha, modelEnabled, moveBefore, moveId, usageBar, parseGithubRepo, safeLogo, splitArgs, toggleModel, validateMcpDraft } from "./mcp-model";

describe("splitArgs and commandPreview", () => {
  it("splits without a shell and honours quotes", () => {
    expect(splitArgs(`-y @scope/pkg --root "/my dir" 'a b' c\\ d`)).toEqual(["-y", "@scope/pkg", "--root", "/my dir", "a b", "c d"]);
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs(`"" x`)).toEqual(["", "x"]);
  });
  it("renders the exact command with quoting round-trippable by splitArgs", () => {
    const args = ["--root", "/my dir", "", 'say "hi"'];
    const preview = commandPreview("npx", args);
    expect(preview).toBe(`npx --root "/my dir" "" "say \\"hi\\""`);
    expect(splitArgs(preview)).toEqual(["npx", ...args]);
  });
});

describe("validateMcpDraft", () => {
  it("accepts a stdio server and omits empty env rows", () => {
    const result = validateMcpDraft({ ...emptyMcpDraft(), name: "Files", command: "npx", args: "-y server", env: [{ key: "TOKEN", value: "s" }, { key: "", value: "" }] });
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ name: "Files", transport: "stdio", command: "npx", args: ["-y", "server"], env: { TOKEN: "s" } });
  });
  it("rejects bad names, missing command and bad env keys", () => {
    const result = validateMcpDraft({ ...emptyMcpDraft(), name: "  ", command: "", env: [{ key: "1BAD", value: "" }] });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors).sort()).toEqual(["command", "env", "name"]);
    expect(validateMcpDraft({ ...emptyMcpDraft(), name: "a", command: "x", env: [{ key: "A", value: "1" }, { key: "A", value: "2" }] }).errors.env).toMatch(/once/);
    expect(validateMcpDraft({ ...emptyMcpDraft(), name: "a", command: "npx -y x" }).errors.command).toMatch(/Arguments/);
    expect(validateMcpDraft({ ...emptyMcpDraft(), name: "a", command: "x", env: [{ key: "NODE_OPTIONS", value: "1" }] }).errors.env).toMatch(/not allowed/);
    expect(validateMcpDraft({ ...emptyMcpDraft(), name: "a", command: "x", env: [{ key: "DYLD_INSERT_LIBRARIES", value: "1" }] }).errors.env).toMatch(/not allowed/);
    for (const cwd of ["/etc", "../x", "a/../../b", "~/x"]) expect(validateMcpDraft({ ...emptyMcpDraft(), name: "a", command: "x", cwd }).errors.cwd).toBeTruthy();
    expect(validateMcpDraft({ ...emptyMcpDraft(), name: "a", command: "x", cwd: "sub/dir" }).payload?.cwd).toBe("sub/dir");
  });
  it("validates http transport urls and keeps secrets out of the url", () => {
    const base = { ...emptyMcpDraft(), name: "Remote", transport: "http" as const };
    expect(validateMcpDraft({ ...base, url: "https://example.com/mcp", headers: [{ key: "Authorization", value: "Bearer x" }] }).payload).toEqual({ name: "Remote", transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } });
    expect(validateMcpDraft({ ...base, url: "http://x.com" }).errors.url).toMatch(/https/);
    expect(validateMcpDraft({ ...base, url: "https://x.com/#a" }).errors.url).toMatch(/fragment/);
    expect(validateMcpDraft({ ...base, transport: "sse", url: "https://x.com/sse" }).payload?.transport).toBe("sse");
    expect(validateMcpDraft({ ...base, url: "https://u:p@x.com" }).errors.url).toMatch(/header/);
    expect(validateMcpDraft({ ...base, url: "nope" }).errors.url).toBeTruthy();
    expect(validateMcpDraft({ ...base, url: "https://x.com", headers: [{ key: "bad header", value: "" }] }).errors.headers).toBeTruthy();
  });
  it("fingerprint changes when anything that will be saved changes", () => {
    const draft = { ...emptyMcpDraft(), name: "a", command: "x" };
    expect(draftFingerprint(draft)).toBe(draftFingerprint({ ...draft }));
    expect(draftFingerprint(draft)).not.toBe(draftFingerprint({ ...draft, args: "--flag" }));
  });
});

describe("parseGithubRepo", () => {
  it("parses owner/name, refs and urls", () => {
    expect(parseGithubRepo("acme/tools").value).toEqual({ repo: "acme/tools", ref: "HEAD" });
    expect(parseGithubRepo("acme/tools@v1.2").value).toEqual({ repo: "acme/tools", ref: "v1.2" });
    expect(parseGithubRepo("https://github.com/acme/tools.git").value).toEqual({ repo: "acme/tools", ref: "HEAD" });
    expect(parseGithubRepo("https://github.com/acme/tools/tree/feat/x").value).toEqual({ repo: "acme/tools", ref: "feat/x" });
    expect(parseGithubRepo("acme/tools", "main").value?.ref).toBe("main");
  });
  it("rejects malformed input", () => {
    expect(parseGithubRepo("acme").error).toBeTruthy();
    expect(parseGithubRepo("acme/tools", "a..b").error).toBeTruthy();
    expect(parseGithubRepo("../etc/passwd").error).toBeTruthy();
    expect(parseGithubRepo("acme/tools", "-rf").error).toBeTruthy();
  });
  it("recognises full commit shas only", () => { expect(isFullSha("a".repeat(40))).toBe(true); expect(isFullSha("abc123")).toBe(false); });
});

describe("safeLogo", () => {
  it("allows same-origin only", () => {
    expect(safeLogo("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(safeLogo("/assets/logo.png")).toBe("/assets/logo.png");
    for (const bad of ["https://evil.example/x.png", "//evil.example/x.png", "http://a/b", "javascript:alert(1)", "data:text/html;base64,AAAA", "/../x", "/\\evil.com", "", undefined, 3]) expect(safeLogo(bad)).toBeUndefined();
  });
});

describe("list helpers", () => {
  it("builds subtitles and filters", () => {
    expect(entrySubtitle("MCP server", { tools: 1, skills: 2 })).toBe("MCP server · 1 tool · 2 skills");
    expect(entrySubtitle("Plugin", {})).toBe("Plugin");
    const items = [{ name: "Read file", description: "x" }, { name: "Search", description: "web lookup" }];
    expect(filterByText(items, "WEB")).toEqual([items[1]]);
    expect(filterByText(items, " ")).toBe(items);
  });
  it("reorders", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    const same = ["a", "b"]; expect(moveId(same, "a", -1)).toBe(same); expect(moveId(same, "z", 1)).toBe(same);
    expect(moveBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveBefore(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    expect(applyOrder([{ id: "a" }, { id: "b" }, { id: "c" }], item => item.id, ["c", "a"]).map(item => item.id)).toEqual(["c", "a", "b"]);
    expect(applyOrder([{ id: "a" }], item => item.id, undefined)).toHaveLength(1);
  });
  it("only reports usage the backend provided", () => {
    expect(usageBar(undefined)).toBeNull();
    expect(usageBar({ available: false, source: null, window: null, reason: "not_exposed" })).toBeNull();
    expect(usageBar({ available: true, window: { kind: "credit-limit", limit: 0, remaining: 0 } })).toBeNull();
    const bar = usageBar({ available: true, window: { kind: "credit-limit", limit: 10, remaining: 2.5, usedDaily: 1, currency: "USD" } });
    expect(bar).toMatchObject({ usedPercent: 75, caption: "$7.50 of $10.00 used", breakdown: ["$1.00 today"] });
    expect(usageBar({ available: true, window: { limit: 10, remaining: -5 } })?.usedPercent).toBe(100);
  });
  it("per-model enablement defaults to all on", () => {
    expect(modelEnabled(undefined, "m")).toBe(true);
    expect(modelEnabled(["a"], "m")).toBe(false);
    expect(toggleModel(["a", "b", "c"], undefined, "b", false)).toEqual(["a", "c"]);
    expect(toggleModel(["a", "b", "c"], ["a"], "c", true)).toEqual(["a", "c"]);
  });
});
