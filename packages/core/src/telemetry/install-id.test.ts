import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInstallId, INSTALL_ID_FILENAME, newSessionId } from "./install-id.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dirs: string[] = [];
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "0sec-analytics-id-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("getInstallId", () => {
  it("returns a UUID", () => {
    const id = getInstallId({ homeDir: tmpHome() });
    expect(id).toMatch(UUID_RE);
  });

  it("is stable across calls (persisted)", () => {
    const home = tmpHome();
    const first = getInstallId({ homeDir: home });
    const second = getInstallId({ homeDir: home });
    expect(second).toBe(first);
    // And a fresh home yields a different id.
    expect(getInstallId({ homeDir: tmpHome() })).not.toBe(first);
  });

  it("persists to ~/.0sec/analytics-id with 0600 perms", () => {
    const home = tmpHome();
    const id = getInstallId({ homeDir: home });
    const path = join(home, ".0sec", INSTALL_ID_FILENAME);
    expect(readFileSync(path, "utf8").trim()).toBe(id);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("regenerates a malformed stored value", () => {
    const home = tmpHome();
    const good = getInstallId({ homeDir: home });
    // Corrupt the file.
    const path = join(home, ".0sec", INSTALL_ID_FILENAME);
    rmSync(path);
    writeFileSync(path, "not-a-uuid\n");
    const regenerated = getInstallId({ homeDir: home });
    expect(regenerated).toMatch(UUID_RE);
    expect(regenerated).not.toBe("not-a-uuid");
    expect(regenerated).not.toBe(good);
  });
});

describe("newSessionId", () => {
  it("returns a fresh UUID each call", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });
});
