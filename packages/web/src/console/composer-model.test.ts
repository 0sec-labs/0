import { describe, expect, it } from "vitest";
import {
  curateSlashCommands,
  effortChoices,
  filterMentions,
  fuzzyScore,
  mentionToken,
  modelButtonLabel,
  orderMentions,
  type MentionItem,
} from "./composer-model";

const names = [
  "help",
  "capabilities",
  "status",
  "tools",
  "new-chat",
  "clear",
  "findings",
  "settings",
  "model",
  "launcher",
  "plugins",
  "usage",
];
const commands = names.map((name) => ({
  name,
  aliases: name === "new-chat" ? ["new"] : [],
}));

describe("slash curation", () => {
  it("shows the curated eight in order and counts the rest", () => {
    const { items, hidden } = curateSlashCommands(commands, "", false);
    expect(items.map((c) => c.name)).toEqual([
      "model",
      "new-chat",
      "status",
      "findings",
      "plugins",
      "settings",
      "tools",
      "help",
    ]);
    expect(hidden).toBe(3);
  });
  it("show all lists everything but the launcher", () => {
    const { items, hidden } = curateSlashCommands(commands, "", true);
    expect(items).toHaveLength(11);
    expect(items.some((c) => c.name === "launcher")).toBe(false);
    expect(hidden).toBe(0);
  });
  it("a typed query searches every command, including aliases", () => {
    expect(curateSlashCommands(commands, "u", false).items.map((c) => c.name)).toEqual(["usage"]);
    expect(curateSlashCommands(commands, "new", false).items.map((c) => c.name)).toEqual(["new-chat"]);
  });
});

describe("mentions", () => {
  const items: MentionItem[] = [
    { kind: "finding", id: "f1", label: "Reflected XSS in search", token: "" },
    { kind: "finding", id: "f2", label: "SQL injection", token: "" },
    {
      kind: "finding",
      id: "f3",
      label: "Open redirect (xss helper)",
      token: "",
    },
  ];
  it("fuzzy-matches subsequences and ranks prefixes first", () => {
    expect(fuzzyScore("Reflected XSS", "rxss")).toBe(10);
    expect(fuzzyScore("abc", "z")).toBeNull();
    expect(filterMentions(items, "xss").map((i) => i.id)).toEqual(["f1", "f3"]);
    expect(filterMentions(items, "sql").map((i) => i.id)).toEqual(["f2"]);
  });
  it("caps each group and keeps all items for an empty query", () => {
    expect(filterMentions(items, "", 2)).toHaveLength(2);
  });
  it("orders plugins, findings, missions", () => {
    const mk = (kind: MentionItem["kind"], id: string): MentionItem => ({
      kind,
      id,
      label: id,
      token: "",
    });
    expect(
      orderMentions({
        mission: [mk("mission", "m")],
        plugin: [mk("plugin", "p")],
        finding: [mk("finding", "f")],
      }).map((i) => i.id),
    ).toEqual(["p", "f", "m"]);
  });
  it("builds a reference token", () => {
    expect(mentionToken("finding", "abc", ' A "quoted"\n title ')).toBe(`"A 'quoted' title" (finding abc) `);
  });
});

describe("effort and model label", () => {
  it("orders effort low to high and marks the selection", () => {
    expect(effortChoices({ effort: "medium", options: ["high", "low", "medium"] })).toEqual([
      { value: "low", label: "Low", selected: false },
      { value: "medium", label: "Medium", selected: true },
      { value: "high", label: "High", selected: false },
    ]);
  });
  it("offers nothing when the model has no real choice", () => {
    expect(effortChoices(null)).toEqual([]);
    expect(effortChoices({ effort: "none", options: ["none"] })).toEqual([]);
  });
  it("falls back from runtime to remembered model to a prompt", () => {
    expect(modelButtonLabel({ model: "a" }, { model: "b" })).toEqual({
      text: "a",
      known: true,
    });
    expect(modelButtonLabel(null, { model: "b" })).toEqual({
      text: "b",
      known: true,
    });
    expect(modelButtonLabel(null, undefined)).toEqual({
      text: "Choose model",
      known: false,
    });
    expect(modelButtonLabel(null, undefined, true)).toEqual({
      text: "Default model",
      known: false,
    });
  });
});
