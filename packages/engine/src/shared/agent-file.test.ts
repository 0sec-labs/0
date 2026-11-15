import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECURITY_WORKFLOW_TEMPLATES } from "./security-workflow-templates.js";
import { AGENT_FILE_API_VERSION, AGENT_FILE_TEMPLATE_IDS, agentFileJsonSchema, normalizeAgentFileText, parseAgentFile, serializeAgentFile } from "./agent-file.js";

const head = `apiVersion: ${AGENT_FILE_API_VERSION}\nid: demo\nname: Demo\n`;
const doc = (front: string, body = "Charter text.\n") => `---\n${front}---\n\n${body}`;
const errorsOf = (source: string) => { const r = parseAgentFile(source); if (r.ok) throw new Error("expected errors"); return r.errors; };

describe("parseAgentFile", () => {
  it("parses a minimal file and fills defaults", () => {
    const r = parseAgentFile(doc(head));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toMatchObject({ id: "demo", access: "read-only", status: "paused", web: false, memory: true, triggers: [], budget: { dailyUsd: 10, maxRunsPerDay: 20 } });
    expect(r.charter).toBe("Charter text.\n");
  });
  it("normalises CRLF and a BOM; the hash ignores both", () => {
    const lf = doc(head);
    const crlf = "﻿" + lf.replace(/\n/g, "\r\n");
    expect(parseAgentFile(crlf).ok).toBe(true);
    expect(normalizeAgentFileText(crlf)).toBe(lf);
  });
  it("handles unicode names and charters", () => {
    const r = parseAgentFile(doc(`apiVersion: ${AGENT_FILE_API_VERSION}\nid: demo\nname: "Sicherheits-Prüfer 🛡️ 日本語"\n`, "Prüfe nur Ziele im Geltungsbereich. 日本語\n"));
    expect(r.ok && r.file.name).toBe("Sicherheits-Prüfer 🛡️ 日本語");
  });
  it("reports unknown keys with line numbers and hints", () => {
    const errors = errorsOf(doc(head + "access: read-only\nproduction: true\n"));
    expect(errors[0]).toMatchObject({ line: 6, path: "production" });
    expect(errors[0]!.message).toContain("only be turned on in the app");
    const nested = errorsOf(doc(head + "scope:\n  repos: []\n  bogus: 1\n"));
    expect(nested[0]).toMatchObject({ line: 7, path: "scope.bogus" });
  });
  it("rejects bad enums and values with the line of the value", () => {
    const errors = errorsOf(doc(head + "access: yolo\n"));
    expect(errors[0]!.line).toBe(5);
    expect(errors[0]!.path).toBe("access");
    expect(errorsOf(doc(head + "access: commands\n"))).toHaveLength(1);
    expect(errorsOf(doc(head + "status: archived\n"))).toHaveLength(1);
    expect(errorsOf(doc(head + "budget:\n  dailyUsd: -1\n"))[0]!.path).toBe("budget.dailyUsd");
  });
  it("rejects duplicate keys", () => {
    expect(errorsOf(doc(head + "name: Other\n"))[0]!.message).toMatch(/unique|duplicate/i);
  });
  it("rejects missing or unclosed frontmatter and a wrong apiVersion", () => {
    expect(errorsOf("# just markdown\n")[0]!.line).toBe(1);
    expect(errorsOf("---\nid: a\n")[0]!.message).toContain("frontmatter");
    expect(errorsOf(doc("apiVersion: other/v9\nid: demo\nname: x\n"))[0]!.path).toBe("apiVersion");
  });
  it("blocks YAML injection: tags, anchors, aliases, merge keys, prototype keys", () => {
    expect(errorsOf(doc(head + "description: !!js/function 'x'\n"))).not.toHaveLength(0);
    expect(errorsOf(doc(head + "description: !custom x\n"))).not.toHaveLength(0);
    expect(errorsOf(doc(head + "skills: &a [x]\nscope:\n  repos: *a\n"))).not.toHaveLength(0);
    expect(errorsOf(doc(head + "base: &b {a: 1}\nscope:\n  <<: *b\n"))).not.toHaveLength(0);
    expect(errorsOf(doc(head + "__proto__:\n  polluted: true\n"))).not.toHaveLength(0);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it("survives a billion-laughs document", () => {
    const front = "a: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]\n";
    expect(parseAgentFile(doc(head + front)).ok).toBe(false);
  });
  it("rejects keys and values that look like secrets without echoing them", () => {
    const keyed = errorsOf(doc(head + "model:\n  provider: openai\n  model: gpt\n  apiKey: abc\n"));
    expect(keyed[0]!.message).toContain("connection");
    const token = "ghp_" + "a".repeat(36);
    const valued = errorsOf(doc(head, `Use ${token} to call the API.\n`));
    expect(valued[0]!.message).toContain("credential");
    expect(JSON.stringify(valued)).not.toContain(token);
    expect(errorsOf(doc(head + `description: ${"sk-" + "b".repeat(30)}\n`))[0]!.message).toContain("credential");
  });
  it("limits size", () => {
    expect(errorsOf(doc(head, "x".repeat(140_000)))[0]!.message).toContain("larger");
    expect(errorsOf(doc(head, "x".repeat(70_000)))[0]!.message).toContain("charter");
    expect(errorsOf(doc(head + "# " + "y".repeat(40_000) + "\n"))[0]!.message).toContain("32 KiB");
    expect(errorsOf(doc(head) + "\0")[0]!.message).toContain("NUL");
  });
  it("accepts only safe instruction paths and not together with a body", () => {
    expect(parseAgentFile(doc(head + "instructions: charters/pen-test.md\n", "")).ok).toBe(true);
    for (const bad of ["../x.md", "/etc/passwd.md", "a/../../x.md", "a\\b.md", "x.txt", "./x.md", "~/x.md"]) expect(parseAgentFile(doc(head + `instructions: ${JSON.stringify(bad)}\n`, "")).ok, bad).toBe(false);
    expect(errorsOf(doc(head + "instructions: a.md\n", "body\n"))[0]!.message).toContain("not both");
  });
  it("validates triggers", () => {
    const ok = parseAgentFile(doc(head + "triggers:\n  - on: schedule\n    frequency: weekly\n    weekday: 1\n    time: '09:00'\n    timezone: Europe/Zurich\n  - on: github-pr\n    repo: acme/app\n    commentOnPr: true\n  - on: manual\n"));
    expect(ok.ok).toBe(true);
    expect(errorsOf(doc(head + "triggers:\n  - on: schedule\n    frequency: minutes\n"))[0]!.message).toContain("interval");
    expect(errorsOf(doc(head + "triggers:\n  - on: github-pr\n    repo: nope\n"))[0]!.path).toBe("triggers.0.repo");
    expect(errorsOf(doc(head + "triggers:\n  - on: push\n"))).not.toHaveLength(0);
    expect(errorsOf(doc(head + "triggers:\n  - on: manual\n  - on: manual\n    id: manual-1\n"))[0]!.message).toContain("Duplicate");
    expect(errorsOf(doc(head + "triggers:\n  - on: manual\n    template: nope\n"))).not.toHaveLength(0);
  });
  it("serialises so that parsing returns the same values", () => {
    const parsed = parseAgentFile(doc(head + "description: 'Colon: and #hash'\nskills: [a-b]\n"));
    if (!parsed.ok) throw new Error("parse");
    const again = parseAgentFile(serializeAgentFile(parsed.file, parsed.charter));
    expect(again.ok && again.file).toEqual(parsed.file);
    expect(again.ok && again.charter).toBe(parsed.charter);
  });
});

describe("agent file JSON Schema", () => {
  it("names exactly the registered automation templates", () => {
    expect([...AGENT_FILE_TEMPLATE_IDS]).toEqual(SECURITY_WORKFLOW_TEMPLATES.map(template => template.id));
  });
  it("matches the published schema (UPDATE_GOLDEN=1 regenerates it)", () => {
    const path = new URL("../../../../docs/public/schemas/agent.v1.json", import.meta.url);
    const generated = JSON.stringify(agentFileJsonSchema(), null, 2) + "\n";
    if (process.env["UPDATE_GOLDEN"] === "1") writeFileSync(path, generated);
    expect(readFileSync(path, "utf8")).toBe(generated);
  });
  it("is draft 2020-12, rejects unknown keys and names the version", () => {
    const schema = agentFileJsonSchema() as { $schema: string; additionalProperties: boolean; properties: Record<string, { const?: string }> };
    expect(schema.$schema).toContain("2020-12");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.apiVersion!.const).toBe(AGENT_FILE_API_VERSION);
  });
});
