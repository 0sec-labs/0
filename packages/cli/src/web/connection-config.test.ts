import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionConfigEnvPatch, loadConnectionConfigs, saveConnectionConfig, validateConnectionConfig } from "./connection-config.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it.each(["http://192.0.2.10:20128/v1", "https://router.example/api/v1"])("persists a custom API endpoint and arbitrary model: %s", baseUrl => {
  const home = mkdtempSync(join(tmpdir(), "0-custom-provider-")); homes.push(home);
  saveConnectionConfig("openai", { baseUrl, model: "9router/vendor/new-model:latest" }, home);
  expect(loadConnectionConfigs(home).openai).toEqual({ baseUrl, model: "9router/vendor/new-model:latest" });
  expect(connectionConfigEnvPatch({}, home)).toEqual({ OPENAI_BASE_URL: baseUrl, OPENAI_MODEL: "9router/vendor/new-model:latest" });
  expect(connectionConfigEnvPatch({ OPENAI_BASE_URL: "https://explicit.example/v1", OPENAI_MODEL: "explicit" }, home)).toEqual({});
});

it.each(["ftp://router.example/v1", "https://user:secret@router.example/v1", "https://router.example/v1?token=secret", "https://router.example/v1#fragment"])("rejects malformed custom endpoint %s", baseUrl => {
  expect(() => validateConnectionConfig("openai", { baseUrl })).toThrow();
});

it.each(["", "model with spaces", "model\nheader", "x".repeat(257)])("rejects malformed model IDs", model => {
  expect(() => validateConnectionConfig("openai", { model })).toThrow();
});

it("preserves provider-specific transport restrictions", () => {
  expect(() => validateConnectionConfig("anthropic", { baseUrl: "http://remote.example/v1" })).toThrow();
  expect(() => validateConnectionConfig("anthropic", { model: "arbitrary" })).toThrow();
});
