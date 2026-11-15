import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentFileEditWarning, AgentFileNote } from "@/components/sentinels/agent-file";
import { editedSinceApply, managedEditWarning, managedNote, type Sentinel } from "./model";

const agent = (fileState?: Sentinel["fileState"]) => ({ id: "a", name: "A", ...(fileState ? { fileState } : {}) }) as unknown as Sentinel;

describe("Agents defined by a file", () => {
  it("say where they live in one line, and say nothing for Agents made in the app", () => {
    expect(managedNote(agent({ source: "file", path: ".0/agents/pen-tester.md" }))).toBe("Managed by .0/agents/pen-tester.md");
    expect(managedNote(agent({ source: "app" }))).toBeNull();
    expect(managedNote(agent())).toBeNull();
    expect(managedEditWarning(agent({ source: "app" }))).toBeNull();
    expect(managedEditWarning(agent({ source: "file", path: "a.md" }))).toBe("The file overwrites changes made here the next time it is applied.");
  });
  it("notice edits made in the app since the last apply", () => {
    expect(editedSinceApply(agent({ source: "file", path: "a.md", edited: true }))).toBe(true);
    expect(editedSinceApply(agent({ source: "file", path: "a.md", edited: false }))).toBe(false);
    expect(editedSinceApply(agent({ source: "app", edited: true }))).toBe(false);
  });
  it("render the note and the warning only for managed Agents", () => {
    expect(renderToStaticMarkup(createElement(AgentFileNote, { sentinel: agent({ source: "file", path: "a.md" }) }))).toContain("Managed by a.md");
    expect(renderToStaticMarkup(createElement(AgentFileNote, { sentinel: agent({ source: "file", path: "a.md", edited: true }) }))).toContain("Edited since the file was last applied");
    expect(renderToStaticMarkup(createElement(AgentFileNote, { sentinel: agent({ source: "app" }) }))).toBe("");
    expect(renderToStaticMarkup(createElement(AgentFileEditWarning, { sentinel: agent({ source: "file", path: "a.md" }) }))).toContain("overwrites changes");
    expect(renderToStaticMarkup(createElement(AgentFileEditWarning, { sentinel: agent() }))).toBe("");
  });
});
