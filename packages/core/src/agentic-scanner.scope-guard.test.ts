/**
 * Scope admission for the public engine.
 *
 * Live network targets must fail before scan initialization without a scope.
 * Explicitly local modes retain the existing opt-in global strictness switch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { agenticScan } from "./agentic-scanner.js";
import { LlmApiRuntime } from "./runtime/llm-api.js";
import type { ScanConfig } from "@0/shared";
import type { ScanEvent } from "./scanner.js";

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `0-scope-guard-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function baseConfig(overrides: Partial<ScanConfig> = {}): ScanConfig {
  return {
    target: "https://target.example.invalid",
    depth: "quick",
    format: "json",
    runtime: "api",
    ...overrides,
  } as ScanConfig;
}

describe("agenticScan — scope-guard visibility (0#133)", () => {
  let dbPath: string;
  let events: ScanEvent[];
  const ORIGINAL_REQUIRE_SCOPE = process.env["ZERO_REQUIRE_SCOPE"];

  beforeEach(() => {
    dbPath = tmpDbPath();
    events = [];
    delete process.env["ZERO_REQUIRE_SCOPE"];
    // Don't let a developer's persisted provider login turn these into live
    // native scans (same guard as agentic-scanner.events.test.ts).
    vi.spyOn(LlmApiRuntime.prototype, "getConfigurationDiagnostics").mockReturnValue({
      valid: false,
      provider: "openrouter",
      providerLabel: "OpenRouter",
      reason: "missing_key",
    });
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    if (ORIGINAL_REQUIRE_SCOPE === undefined) delete process.env["ZERO_REQUIRE_SCOPE"];
    else process.env["ZERO_REQUIRE_SCOPE"] = ORIGINAL_REQUIRE_SCOPE;
    vi.restoreAllMocks();
  });

  async function runUnscopedScan(config: ScanConfig = baseConfig()): Promise<void> {
    await expect(
      agenticScan({ config, dbPath, onEvent: (e) => { events.push(e); } }),
    ).rejects.toThrow();
  }

  it("refuses an unscoped live target before scan initialization", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
    await expect(
      agenticScan({ config: baseConfig(), dbPath, onEvent: (e) => { events.push(e); } }),
    ).rejects.toThrow(/live network target .* requires an engagement scope/);

    expect(events).toEqual([]);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an out-of-scope target before any classification request", async () => {
    const scopeFile = `${dbPath}.scope.json`;
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
    fs.writeFileSync(scopeFile, JSON.stringify({ in_scope: ["allowed.example.invalid"] }));
    try {
      await expect(agenticScan({
        config: baseConfig({ scopeFile }),
        dbPath,
      })).rejects.toThrow(/out of scope/);
      expect(request).not.toHaveBeenCalled();
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      fs.unlinkSync(scopeFile);
    }
  });

  it("does not follow redirects from an admitted auto-detect target", async () => {
    let targetRequests = 0;
    let redirectedRequests = 0;
    const destination = createServer((_request, response) => {
      redirectedRequests++;
      response.end("<html>unreviewed destination</html>");
    });
    const target = createServer((_request, response) => {
      targetRequests++;
      response.writeHead(302, {
        location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/unreviewed`,
        connection: "close",
      });
      response.end();
    });
    const scopeFile = `${dbPath}.scope.json`;
    try {
      await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
      await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
      fs.writeFileSync(scopeFile, JSON.stringify({ in_scope: ["127.0.0.1"] }));
      // The provider diagnostic stub stops the scan after the real HTTP probe.
      await expect(agenticScan({
        config: baseConfig({
          target: `http://127.0.0.1:${(target.address() as AddressInfo).port}/`,
          scopeFile,
        }),
        dbPath,
      })).rejects.toThrow();
      expect(targetRequests).toBe(1);
      expect(redirectedRequests).toBe(0);
    } finally {
      fs.rmSync(scopeFile, { force: true });
      for (const server of [target, destination]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("keeps dotted source filenames local and never probes them as HTTP targets", async () => {
    const source = `${dbPath}.source.js`;
    fs.writeFileSync(source, "export const value = 1;\n");
    process.env["ZERO_REQUIRE_SCOPE"] = "1";
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
    try {
      await expect(agenticScan({
        config: baseConfig({ target: source, repoPath: path.dirname(source), mode: "deep" }),
        dbPath,
      })).rejects.toThrow(/ZERO_REQUIRE_SCOPE is set but no engagement scope is configured/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fs.unlinkSync(source);
    }
  });

  it("keeps the global strictness switch for unscoped local modes", async () => {
    process.env["ZERO_REQUIRE_SCOPE"] = "1";
    await expect(
      agenticScan({
        config: baseConfig({ target: "lodash" }),
        dbPath,
        onEvent: (e) => { events.push(e); },
      }),
    ).rejects.toThrow(/ZERO_REQUIRE_SCOPE is set but no engagement scope is configured/);
  });

  it("stays silent when http_audit synthesises a host policy (guards active)", async () => {
    // http_audit is the one cloud mode that DOES get a ScopePolicy — built
    // in-memory from httpAuditAllowedHosts rather than from a --scope file.
    // It must not be warned at.
    await runUnscopedScan(
      baseConfig({
        mode: "http_audit",
        httpAuditAllowedHosts: ["target.example.invalid"],
      } as Partial<ScanConfig>),
    );

    expect(events.find((e) => /No engagement scope is configured/.test(e.message))).toBeUndefined();
  });
});
