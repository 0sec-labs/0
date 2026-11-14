import { expect, test } from "vitest";
import { LOCAL_RECENT_GROUP, RECENT_GROUP, filterAppSearch, searchKeywords, SEARCH_GROUPS, type SearchableItem } from "../src/components/app-search";

function item(group: SearchableItem["group"], label: string, keywords: string[] = []): SearchableItem {
  return { group, label, meta: "", keywords };
}

test("all search includes each workspace entity category and matches all words across selected fields", () => {
  const index = SEARCH_GROUPS.map(group => item(group, `${group} example`, ["security audit"]));
  expect(filterAppSearch(index, "example audit").map(result => result.group)).toEqual(SEARCH_GROUPS.filter(group => group !== LOCAL_RECENT_GROUP));
  expect(filterAppSearch([item("Skills", "Review source", ["security audit"])], "source security")).toHaveLength(1);
  expect(filterAppSearch([item("Skills", "Review source", ["security audit"])], "source missing")).toEqual([]);
  expect(filterAppSearch([item("Skills", "Review source")], "skills source")).toHaveLength(1);
});

test("matching happens before section limits, including entities beyond the old fourteen-row cutoff", () => {
  const findings = Array.from({ length: 50 }, (_, index) => item("Findings", `Finding ${index}`));
  expect(filterAppSearch(findings, "49").map(result => result.label)).toEqual(["Finding 49"]);
  expect(filterAppSearch(findings, "finding")).toHaveLength(8);
  expect(filterAppSearch(findings, "")).toHaveLength(4);
});

test("empty search offers bounded groups while chat mode preserves paginated server full-text results", () => {
  const chats = Array.from({ length: 30 }, (_, index) => item(RECENT_GROUP, `Chat ${index}`));
  const index = [...chats, ...Array.from({ length: 12 }, (_, index) => item("Pages", `Page ${index}`)), item("Memory", "Lesson")];
  expect(filterAppSearch(index, "").filter(result => result.group === RECENT_GROUP)).toHaveLength(6);
  expect(filterAppSearch(index, "").filter(result => result.group === "Pages")).toHaveLength(6);
  expect(filterAppSearch(index, "body-only match", "chats")).toEqual(chats);
});

test("keyword selection ignores absent fields and never serializes arbitrary objects", () => {
  expect(searchKeywords("description", undefined, null, "", " ", "target")).toEqual(["description", "target"]);
});

test("the mission vocabulary drives the recent group label", async () => {
  const { VOCAB, v } = await import("../src/lib/vocabulary");
  expect(RECENT_GROUP).toBe(`Recent ${VOCAB.mission.plural}`);
  expect(v("Open {a mission}")).toBe(`Open a ${VOCAB.mission.singular}`);
});
