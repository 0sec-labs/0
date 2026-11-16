import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  disable,
  emptyEnablement,
  enable,
  enablementFilePath,
  ENABLEMENT_DIR_MODE,
  ENABLEMENT_FILE_MODE,
  readEnablement,
  writeEnablement,
} from "./enablement.js";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0-enable-home-"));
  project = mkdtempSync(join(tmpdir(), "0-enable-proj-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const isEnabled = (record: { enabled: Record<string, unknown> }, id: string) => Object.hasOwn(record.enabled, id);

describe("enable / disable", () => {
  it("records the built-in as on", () => {
    const r = enable(emptyEnablement(), "acme.recon", {
      version: "1.0.0",
      capabilities: ["filesystem-read", "network"],
      now: 111,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isEnabled(r.record, "acme.recon")).toBe(true);
    expect(r.record.enabled["acme.recon"]).toEqual({ version: "1.0.0", capabilities: ["filesystem-read", "network"], enabledAt: 111 });
  });

  it("is pure — does not mutate the input record", () => {
    const base = emptyEnablement();
    const r = enable(base, "acme.recon", { version: "1.0.0", capabilities: ["network"], now: 1 });
    expect(r.ok).toBe(true);
    expect(isEnabled(base, "acme.recon")).toBe(false);
  });

  it("rejects a path-traversal plugin id before it becomes a key", () => {
    for (const bad of ["../evil", "a/b", "..", ".", "A", "foo\0bar", "/abs"]) {
      const r = enable(emptyEnablement(), bad, { version: "1.0.0", capabilities: ["network"], now: 1 });
      expect(r.ok).toBe(false);
    }
  });

  it("disable removes an approval and is a no-op when absent", () => {
    const enabled = enable(emptyEnablement(), "acme.recon", {
      version: "1.0.0",
      capabilities: ["network"],
      now: 1,
    });
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    const off = disable(enabled.record, "acme.recon");
    expect(isEnabled(off, "acme.recon")).toBe(false);
    // no-op path returns the same record
    expect(disable(off, "acme.recon")).toBe(off);
  });
});

describe("fs layer", () => {
  it("readEnablement of a missing store yields only the default-on built-in, never throwing", () => {
    const rec = readEnablement(project, home);
    expect(Object.keys(rec.enabled)).toEqual(["scope"]);
    expect(rec.enabled.scope.origin).toBe("default");
  });

  it("round-trips a built-in switch-off through the one store, with 0600/0700 perms on the per-project file", () => {
    const off = disable(readEnablement(project, home), "scope");
    expect(writeEnablement(project, off, home)).toBe(true);
    expect(isEnabled(readEnablement(project, home), "scope")).toBe(false);
    expect(statSync(enablementFilePath(project, home)).mode & 0o777).toBe(ENABLEMENT_FILE_MODE);
    expect(statSync(join(home, ".0", "plugin-enablement")).mode & 0o777).toBe(ENABLEMENT_DIR_MODE);
  });

  it("readEnablement degrades to the defaults on corrupt / non-JSON files", () => {
    const path = enablementFilePath(project, home);
    mkdirSync(join(home, ".0", "plugin-enablement"), { recursive: true });
    writeFileSync(path, "this is not json {{{");
    expect(Object.keys(readEnablement(project, home).enabled)).toEqual(["scope"]);
  });

  it("writeEnablement writes a distinct file per project realpath", () => {
    const other = mkdtempSync(join(tmpdir(), "0-enable-proj2-"));
    try {
      expect(enablementFilePath(project, home)).not.toBe(enablementFilePath(other, home));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
