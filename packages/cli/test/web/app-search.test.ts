import { expect, test } from "vitest";
import { filterAppSearch, searchKeywords, SEARCH_GROUPS, type SearchableItem } from "../../../dashboard/src/components/app-search";

function item(group: SearchableItem["group"], label: string, keywords: string[] = []): SearchableItem {
  return { group, label, meta: "", keywords };
}

test("all search includes each workspace entity category and matches all words across selected fields", () => {
  const index = SEARCH_GROUPS.map(group => item(group, `${group} example`, ["security audit"]));
  expect(filterAppSearch(index, "example audit").map(result => result.group)).toEqual(SEARCH_GROUPS);
  expect(filterAppSearch([item("Skills", "Review source", ["security audit"])], "source security")).toHaveLength(1);
  expect(filterAppSearch([item("Skills", "Review source", ["security audit"])], "source missing")).toEqual([]);
  expect(filterAppSearch([item("Skills", "Review source")], "skills source")).toHaveLength(1);
});

test("matching happens before section limits, including entities beyond the old fourteen-row cutoff", () => {
  const findings = Array.from({ length: 50 }, (_, index) => item("Findings", `Finding ${index}`));
  expect(filterAppSearch(findings, "49").map(result => result.label)).toEqual(["Finding 49"]);
  expect(filterAppSearch(findings, "finding")).toHaveLength(12);
  expect(filterAppSearch(findings, "")).toHaveLength(4);
});

test("empty search offers bounded groups while chat mode preserves paginated server full-text results", () => {
  const chats = Array.from({ length: 30 }, (_, index) => item("Recent chats", `Chat ${index}`));
  const index = [...chats, ...Array.from({ length: 12 }, (_, index) => item("Pages", `Page ${index}`)), item("Memory", "Lesson")];
  expect(filterAppSearch(index, "").filter(result => result.group === "Recent chats")).toHaveLength(6);
  expect(filterAppSearch(index, "").filter(result => result.group === "Pages")).toHaveLength(6);
  expect(filterAppSearch(index, "body-only match", "chats")).toEqual(chats);
});

test("keyword selection ignores absent fields and never serializes arbitrary objects", () => {
  expect(searchKeywords("description", undefined, null, "", " ", "target")).toEqual(["description", "target"]);
});
