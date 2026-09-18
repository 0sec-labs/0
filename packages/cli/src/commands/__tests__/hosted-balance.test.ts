import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { CloudClient } from "@0sec/core";
import { registerHostedCommand } from "../hosted.js";

const output = vi.hoisted(() => ({ stdout: vi.fn(), stderr: vi.fn() }));
vi.mock("../../presentation/process-output.js", () => ({ consolePresentationOutput: output }));
const originalExitCode = process.exitCode;

function readyAccount() {
  return {
    schemaVersion: "credits-v1",
    snapshotAt: "2026-09-18T12:00:00.000Z",
    policyVersion: "credits-v1",
    scope: { orgId: "test-org" },
    state: "ready" as const,
    reason: null,
    free: {
      state: "active" as const,
      claimableCreditNanos: "0",
      spendableCreditNanos: "100000000000",
      heldCreditNanos: "0",
      resetAt: "2026-10-01T00:00:00.000Z",
    },
    subscription: {
      state: "none" as const,
      priceCents: 1500 as const,
      periodStart: null,
      periodEnd: null,
      windows: [],
    },
    prepaid: {
      spendableCreditNanos: "0",
      heldCreditNanos: "0",
      settledDeficitCreditNanos: "0",
      holdShortfallCreditNanos: "0",
      consentEnabled: false,
    },
    purchase: {
      enabled: true,
      presets: [{ principalCents: 1000, creditNanos: "1000000000000" }],
      customMinCents: 1000,
      customMaxCents: 100000,
      stepCents: 100 as const,
      currency: "usd" as const,
    },
    admission: { eligible: true, reason: null },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  output.stdout.mockClear();
  output.stderr.mockClear();
  process.exitCode = originalExitCode;
});

it("shows credit account detail in human output", async () => {
  vi.stubEnv("0SEC_CLOUD_TOKEN", "fixture-token");
  vi.stubEnv("0SEC_CLOUD_HOST", "https://fixture.invalid");
  const account = vi.spyOn(CloudClient.prototype, "getInferenceAccount");
  account.mockResolvedValueOnce(readyAccount());
  const command = new Command("0sec");
  registerHostedCommand(command);
  await command.parseAsync(["node", "0sec", "balance"]);
  const line = String(output.stdout.mock.lastCall?.[0] ?? "");
  expect(line).toContain("Free state");
  expect(line).toContain("100,000,000,000");
  expect(line).not.toContain("remainingPercent");
  expect(line).not.toContain("supplier");
  expect(line).not.toContain("USD");
  expect(process.exitCode).toBe(0);
  expect(output.stderr).not.toHaveBeenCalled();
});

it("shows state and reason when account is disabled", async () => {
  vi.stubEnv("0SEC_CLOUD_TOKEN", "fixture-token");
  vi.stubEnv("0SEC_CLOUD_HOST", "https://fixture.invalid");
  const account = vi.spyOn(CloudClient.prototype, "getInferenceAccount");
  account.mockResolvedValueOnce({
    ...readyAccount(),
    state: "disabled" as const,
    reason: "policy_disabled",
    free: {
      state: "unresolved" as const,
      claimableCreditNanos: null,
      spendableCreditNanos: null,
      heldCreditNanos: null,
      resetAt: null,
    },
  });
  const command = new Command("0sec");
  registerHostedCommand(command);
  await command.parseAsync(["node", "0sec", "balance"]);
  const line = String(output.stdout.mock.lastCall?.[0] ?? "");
  expect(line).toContain("disabled");
  expect(line).toContain("policy_disabled");
  expect(process.exitCode).toBe(0);
  expect(output.stderr).not.toHaveBeenCalled();
});

it("emits raw JSON with --json flag", async () => {
  vi.stubEnv("0SEC_CLOUD_TOKEN", "fixture-token");
  vi.stubEnv("0SEC_CLOUD_HOST", "https://fixture.invalid");
  const account = vi.spyOn(CloudClient.prototype, "getInferenceAccount");
  account.mockResolvedValueOnce(readyAccount());
  const command = new Command("0sec");
  registerHostedCommand(command);
  await command.parseAsync(["node", "0sec", "balance", "--json"]);
  const raw = String(output.stdout.mock.lastCall?.[0] ?? "");
  const parsed = JSON.parse(raw);
  expect(parsed.schemaVersion).toBe("credits-v1");
  expect(parsed.state).toBe("ready");
  expect(parsed.free.spendableCreditNanos).toBe("100000000000");
  expect(process.exitCode).toBe(0);
  expect(output.stderr).not.toHaveBeenCalled();
});

it("handles null account (unsupported schema) gracefully", async () => {
  vi.stubEnv("0SEC_CLOUD_TOKEN", "fixture-token");
  vi.stubEnv("0SEC_CLOUD_HOST", "https://fixture.invalid");
  const account = vi.spyOn(CloudClient.prototype, "getInferenceAccount");
  account.mockResolvedValueOnce(null);
  const command = new Command("0sec");
  registerHostedCommand(command);
  await command.parseAsync(["node", "0sec", "balance"]);
  const line = String(output.stdout.mock.lastCall?.[0] ?? "");
  expect(line).toContain("Credit data unavailable");
  expect(process.exitCode).toBe(0);
});

it("rejects on auth failure rather than showing unavailable credits", async () => {
  vi.stubEnv("0SEC_CLOUD_TOKEN", "bad-token");
  vi.stubEnv("0SEC_CLOUD_HOST", "https://fixture.invalid");
  const account = vi.spyOn(CloudClient.prototype, "getInferenceAccount");
  account.mockRejectedValueOnce(
    Object.assign(new Error("Unauthorized"), { status: 401 }),
  );
  const command = new Command("0sec");
  registerHostedCommand(command);
  await command.parseAsync(["node", "0sec", "balance"]);
  expect(process.exitCode).toBe(2); // EXIT_AUTH
  expect(output.stderr).toHaveBeenCalled();
});