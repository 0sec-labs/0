import { describe, expect, it } from "vitest";
import {
  filterAppSearch, footerHints, highlightParts, LOCAL_RECENT_GROUP, matchScore, nextTab, parseRecents, pushRecent, RECENT_GROUP, SEARCH_TABS, wrapIndex,
  type RecentEntry, type SearchableItem,
} from "./app-search";

const item = (group: string, label: string, meta = "", keywords: string[] = [], extra: Partial<SearchableItem> = {}): SearchableItem => ({ group, label, meta, keywords, ...extra });

describe("matchScore and ranking", () => {
  it("ranks prefix over word start over substring over metadata", () => {
    const rows = [item("Pages", "Dashboard overview", "", ["models"]), item("Pages", "Choose models"), item("Pages", "Models"), item("Pages", "Bimodels")];
    const ranked = filterAppSearch(rows, "models").map(row => row.label);
    expect(ranked).toEqual(["Models", "Choose models", "Bimodels", "Dashboard overview"]);
    expect(matchScore(rows[2]!, "models")).toBe(0);
  });
  it("keeps source order for equal scores", () => {
    const rows = [item("Findings", "SQL one"), item("Findings", "SQL two")];
    expect(filterAppSearch(rows, "sql").map(row => row.label)).toEqual(["SQL one", "SQL two"]);
  });
});

describe("grouping and caps", () => {
  const many = (group: string, count: number) => Array.from({ length: count }, (_, index) => item(group, `Item ${index}`));
  it("caps every group at 8 on All with a term", () => {
    const out = filterAppSearch([...many("Findings", 20), ...many("Pages", 20)], "item");
    expect(out.filter(row => row.group === "Findings")).toHaveLength(8);
    expect(out.filter(row => row.group === "Pages")).toHaveLength(8);
  });
  it("shows short lists without a term and long lists on a dedicated tab", () => {
    expect(filterAppSearch(many("Findings", 20), "")).toHaveLength(4);
    expect(filterAppSearch(many("Findings", 20), "", "findings")).toHaveLength(20);
  });
  it("restricts a tab to its groups", () => {
    const rows = [item("Plugins", "A"), item("Skills", "B"), item("Findings", "C")];
    expect(filterAppSearch(rows, "", "plugins").map(row => row.group)).toEqual(["Plugins", "Skills"]);
  });
  it("trusts prefiltered rows and server-matched missions", () => {
    const rows = [item("Settings", "Theme", "", [], { prefiltered: true }), item(RECENT_GROUP, "Unrelated title")];
    expect(filterAppSearch(rows, "dark")).toHaveLength(2);
  });
  it("shows local recents only on All without a term", () => {
    const rows = [item(LOCAL_RECENT_GROUP, "Last page"), item("Pages", "Other")];
    expect(filterAppSearch(rows, "").map(row => row.label)).toEqual(["Last page", "Other"]);
    expect(filterAppSearch(rows, "o").map(row => row.group)).toEqual(["Pages"]);
    expect(filterAppSearch(rows, "", "settings")).toEqual([]);
  });
  it("caps local recents at 5", () => {
    expect(filterAppSearch(many(LOCAL_RECENT_GROUP, 9), "")).toHaveLength(5);
  });
});

describe("tabs and keyboard stepping", () => {
  it("wraps tabs in both directions", () => {
    expect(nextTab("all", -1)).toBe(SEARCH_TABS[SEARCH_TABS.length - 1]!.id);
    expect(nextTab(SEARCH_TABS[SEARCH_TABS.length - 1]!.id, 1)).toBe("all");
    expect(nextTab("all", 1)).toBe("chats");
  });
  it("wraps row selection", () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(-1, 1, 3)).toBe(0);
    expect(wrapIndex(-1, -1, 3)).toBe(2);
    expect(wrapIndex(0, 1, 0)).toBe(-1);
  });
});

describe("highlightParts", () => {
  it("marks every term case-insensitively and merges adjacent hits", () => {
    expect(highlightParts("Fix SQL injection", "sql inj")).toEqual([
      { text: "Fix ", match: false }, { text: "SQL", match: true }, { text: " ", match: false }, { text: "inj", match: true }, { text: "ection", match: false },
    ]);
    expect(highlightParts("abab", "ab")).toEqual([{ text: "abab", match: true }]);
  });
  it("treats regex characters literally and returns plain text for empty queries", () => {
    expect(highlightParts("a (b) c", "(b)")).toEqual([{ text: "a ", match: false }, { text: "(b)", match: true }, { text: " c", match: false }]);
    expect(highlightParts("plain", "  ")).toEqual([{ text: "plain", match: false }]);
    expect(highlightParts("", "x")).toEqual([{ text: "", match: false }]);
  });
});

describe("recents", () => {
  const entry = (id: string): RecentEntry => ({ id, kind: "page", label: id, href: `/${id}` });
  it("puts the newest first, dedupes by id and keeps five", () => {
    let list: RecentEntry[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f"]) list = pushRecent(list, entry(id));
    expect(list.map(row => row.id)).toEqual(["f", "e", "d", "c", "b"]);
    expect(pushRecent(list, entry("c")).map(row => row.id)).toEqual(["c", "f", "e", "d", "b"]);
  });
  it("drops corrupt or unsafe stored entries", () => {
    expect(parseRecents("nope")).toEqual([]);
    expect(parseRecents([entry("ok"), { id: 1 }, { ...entry("x"), href: "https://evil.example" }, null, { ...entry("y"), kind: "other" }])).toEqual([entry("ok")]);
    expect(parseRecents(Array.from({ length: 9 }, (_, index) => entry(String(index))))).toHaveLength(5);
  });
});

describe("footerHints", () => {
  it("changes with context", () => {
    const labels = (context: Parameters<typeof footerHints>[0]) => footerHints(context).map(hint => hint.keys);
    expect(labels({ hasSelection: false, canOpenInTab: false, hasQuery: false, mod: "⌘" })).toEqual(["←/→", "esc"]);
    expect(labels({ hasSelection: true, canOpenInTab: false, hasQuery: false, mod: "⌘" })).toEqual(["↵", "←/→", "esc"]);
    expect(labels({ hasSelection: true, canOpenInTab: true, hasQuery: true, mod: "⌘" })).toEqual(["↵", "⌘↵", "Tab", "←/→", "esc"]);
  });
});
