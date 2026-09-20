import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import type { UsageAccount } from "@0sec/core";
import { registerHostedCommand } from "../hosted.js";

const output = vi.hoisted(() => ({ stdout: vi.fn(), stderr: vi.fn() }));
vi.mock("../../presentation/process-output.js", () => ({ consolePresentationOutput: output }));
const originalExitCode = process.exitCode;

function account(): UsageAccount {
  return {
    schemaVersion: "usage-v2", snapshotAt: "2026-09-18T12:00:00.000Z",
    scope: { orgId: "fixture-org" }, state: "ready", reason: null,
    plan: { id: "pro", name: "Pro", monthlyPriceUsd: "39.00" },
    included: { state: "active", usedPercent: 37.5, resetsAt: "2026-10-18T12:00:00.000Z" },
    prepaid: { balanceUsd: "123456789.012345678", fallbackEnabled: false },
    canManageBilling: true,
    admission: { eligible: true, reason: null },
  };
}

beforeEach(() => {
  vi.stubEnv("0SEC_CLOUD_TOKEN", "synthetic-fixture-token");
  vi.stubEnv("0SEC_CLOUD_HOST", "https://fixture.invalid");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  output.stdout.mockClear();
  output.stderr.mockClear();
  process.exitCode = originalExitCode;
});

async function run(args: string[], body: unknown, status = 200): Promise<string> {
  vi.stubGlobal("fetch", async () => Response.json(body, { status }));
  const command = new Command("0sec");
  registerHostedCommand(command);
  await command.parseAsync(["node", "0sec", ...args]);
  return String(output.stdout.mock.lastCall?.[0] ?? "");
}

it("shows included percentage and exact prepaid money", async () => {
  const text = await run(["balance"], account());
  expect(text).toContain("37.5%");
  expect(text).toContain("$123456789.012345678");
  expect(process.exitCode).toBe(0);
});

it("keeps JSON amounts as exact wire strings and excludes private extensions", async () => {
  const parsed = JSON.parse(await run(["balance", "--json"], {
    ...account(), supplierCostUsd: "private-cost-value",
  }));
  expect(parsed.prepaid.balanceUsd).toBe("123456789.012345678");
  expect(JSON.stringify(parsed)).not.toContain("private-cost-value");
});

it("does not reject authenticated disabled or legacy account responses", async () => {
  const disabled = await run(["balance"], { ...account(), state: "disabled", reason: "policy_disabled" });
  expect(disabled).toContain("policy_disabled");
  expect(process.exitCode).toBe(0);
  const legacy = await run(["balance", "--json"], { credits: { remainingPercent: 70 } });
  expect(JSON.parse(legacy)).toBeNull();
  expect(process.exitCode).toBe(0);
  expect(output.stderr).not.toHaveBeenCalled();
});

it("reports a real HTTP authentication failure without exposing the token", async () => {
  await run(["balance"], { error: "invalid_token" }, 401);
  expect(process.exitCode).toBe(2);
  expect(output.stderr).toHaveBeenCalled();
  expect(JSON.stringify(output.stderr.mock.calls)).not.toContain("synthetic-fixture-token");
});

it("exposes model identity and capabilities without supplier metadata in either output mode", async () => {
  const payload = { object: "list", data: [{
    id: "fixture-fast", object: "model", owned_by: "private-owner", provider: "private-provider",
    upstream_model: "private-upstream", wire_api: "responses", context_length: 128000, max_output_tokens: 8192,
    pricing: { input_per_million_usd: 13.37, output_per_million_usd: 42.4242, cached_input_per_million_usd: 9.9997 },
  }] };
  for (const args of [["models"], ["models", "--json"]]) {
    const text = await run(args, payload);
    expect(text).toContain("fixture-fast");
    expect(text).not.toMatch(/private-|13\.37|42\.4242|9\.9997|responses/);
    if (args.includes("--json")) expect(JSON.parse(text)[0].contextTokens).toBe(128000);
  }
});
