import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileNoteStore } from "@0/engine";
import { handleMemoryRequest } from "./memory-api.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "memapi-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const call = (path: string, method: string, body?: unknown, query = "") => handleMemoryRequest(path, method, body, new URLSearchParams(query), () => createFileNoteStore({ home }))!;

describe("memory API", () => {
  it("ignores other routes", () => expect(handleMemoryRequest("/api/console/learning", "GET", {}, new URLSearchParams())).toBeNull());
  it("lists, adds, filters, edits, deletes and turns off", () => {
    expect(call("/api/console/memory", "GET").data).toMatchObject({ enabled: true, notes: [], folders: [] });
    const a = (call("/api/console/memory", "POST", { text: "Use pnpm", scope: "global", kind: "command" }).data as { note: { id: string } }).note;
    call("/api/console/memory", "POST", { text: "Small PRs", scope: "folder", folder: home });
    const all = call("/api/console/memory", "GET").data as { notes: unknown[]; folders: string[] };
    expect(all.notes).toHaveLength(2); expect(all.folders).toHaveLength(1);
    expect((call("/api/console/memory", "GET", undefined, `folder=${encodeURIComponent(home)}`).data as { notes: unknown[] }).notes).toHaveLength(1);
    expect((call(`/api/console/memory/${a.id}`, "PATCH", { text: "Use pnpm 9" }).data as { note: { text: string } }).note.text).toBe("Use pnpm 9");
    expect(call(`/api/console/memory/${a.id}`, "DELETE").status).toBe(200);
    expect(call(`/api/console/memory/${a.id}`, "DELETE").status).toBe(404);
    expect(call("/api/console/memory/enabled", "POST", { enabled: false }).data).toEqual({ enabled: false });
    expect(call("/api/console/memory/clear", "POST", {}).data).toEqual({ removed: 1 });
  });
  it("rejects empty notes, a folder note without a folder and files that are not memory files", () => {
    expect(call("/api/console/memory", "POST", { text: "  " }).status).toBe(400);
    expect(call("/api/console/memory", "POST", { text: "x", scope: "folder" }).status).toBe(400);
    expect(call("/api/console/memory/import", "POST", { archive: { format: "other" } }).status).toBe(400);
    expect(call("/api/console/memory/zzz", "GET").status).toBe(405);
  });
  it("round-trips an export", () => {
    call("/api/console/memory", "POST", { text: "One", scope: "global" });
    const archive = call("/api/console/memory/export", "GET").data;
    call("/api/console/memory/clear", "POST", {});
    expect(call("/api/console/memory/import", "POST", { archive }).data).toEqual({ added: 1, total: 1 });
  });
});
