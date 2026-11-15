import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, filterCommands, findCommand, getCommandByName } from "./slash-commands.js";

describe("slash registry", () => {
  it("has unique names across names, aliases and legacy names", () => {
    const seen = new Map<string, string>();
    for (const c of SLASH_COMMANDS)
      for (const n of [c.name, ...c.aliases, ...c.legacy]) {
        expect(seen.get(n), `${n} defined twice`).toBeUndefined();
        seen.set(n, c.name);
      }
  });

  it("resolves canonical two-word names with arguments", () => {
    expect(findCommand("/models default gpt-5")).toMatchObject({ command: "models default", args: "gpt-5", isKnown: true });
    expect(findCommand("/config set theme dark")).toMatchObject({ command: "config set", args: "theme dark" });
    expect(findCommand("/threads   list")).toMatchObject({ command: "threads list", args: "" });
  });

  it("keeps old names working", () => {
    const old: Record<string, string> = {
      "/new-mission": "threads start",
      "/sessions": "threads list",
      "/history": "threads list",
      "/connect": "models connections",
      "/plugins": "plugin list",
      "/settings": "config list",
      "/model gpt-5": "models default",
      "/usage": "models usage",
      "/exit": "threads close",
      "/keybindings": "shortcuts",
    };
    for (const [input, canonical] of Object.entries(old)) expect(findCommand(input).command, input).toBe(canonical);
  });

  it("treats a bare noun with a stray word as unknown", () => {
    expect(findCommand("/threads").command).toBe("threads list");
    expect(findCommand("/threads bogus").isUnknown).toBe(true);
    expect(findCommand("/blarg").isUnknown).toBe(true);
    expect(findCommand("hello").isSlash).toBe(false);
  });

  it("filters word by word", () => {
    expect(filterCommands("").length).toBe(SLASH_COMMANDS.length);
    expect(filterCommands("find").map((c) => c.name)).toEqual(["findings list", "findings export"]);
    expect(filterCommands("config g").map((c) => c.name)).toEqual(["config get"]);
    expect(filterCommands("sessions").map((c) => c.name)).toEqual(["threads list"]);
  });

  it("uses user vocabulary", () => {
    const text = SLASH_COMMANDS.map((c) => `${c.description} ${c.usage ?? ""}`).join(" ");
    expect(text).not.toMatch(/mission|sentinel|workspace|engine|project/i);
    expect(getCommandByName("threads start")?.cli).toBe("threads start");
  });
});
