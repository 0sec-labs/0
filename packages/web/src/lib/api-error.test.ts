import { describe, expect, it } from "vitest";
import { consoleErrorMessage, needsModelEnabled } from "@/console/provider-error";
import { API_ERROR_MESSAGES, ApiError, apiErrorFrom, describeApiFailure, errorText, isModelDisabledError, mapErrorText } from "./api-error";
import { NonJsonResponseError } from "./network-resilience";

describe("api error mapper", () => {
  it.each(["browser_only", "owner_required", "approval_required", "model_disabled"])("maps %s to a clear sentence", code => {
    const error = apiErrorFrom({ status: 403, statusText: "Forbidden" }, { code, error: "raw backend text" });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(403);
    expect(error.message).toBe(API_ERROR_MESSAGES[code]);
    expect(error.message).not.toMatch(/request failed/i);
  });
  it("keeps the backend sentence for unknown codes and falls back to the status", () => {
    expect(apiErrorFrom({ status: 409, statusText: "Conflict" }, { code: "other", error: "Sentinel changed." }).message).toBe("Sentinel changed.");
    expect(describeApiFailure({ status: 502, statusText: "Bad Gateway" })).toBe("502 Bad Gateway");
    expect(apiErrorFrom({ status: 500, statusText: "Oops" }, null).message).toBe("500 Oops");
  });
  it("detects disabled models from codes and text", () => {
    expect(isModelDisabledError(new ApiError("x", 409, "model_disabled"))).toBe(true);
    expect(isModelDisabledError(new Error("That model is turned off for this connection. Enable it in Connections first."))).toBe(true);
    expect(isModelDisabledError(new Error("boom"))).toBe(false);
    expect(needsModelEnabled("409 model_disabled")).toBe(true);
  });
  it("maps raw codes inside session error text and leaves other text alone", () => {
    expect(mapErrorText("owner_required")).toBe(API_ERROR_MESSAGES.owner_required);
    expect(consoleErrorMessage("model_disabled: gpt")).toBe(API_ERROR_MESSAGES.model_disabled);
    expect(consoleErrorMessage("Something odd happened")).toBe("Something odd happened");
  });
});

describe("friendlyValidationText", () => {
  it("turns a raw zod issue list into a sentence", async () => {
    const { friendlyValidationText, describeApiFailure } = await import("./api-error");
    const raw = JSON.stringify([{ code: "too_small", minimum: 1, path: ["name"], message: "Too small: expected string to have >=1 characters" }]);
    expect(friendlyValidationText(raw)).toBe("Enter a name.");
    expect(describeApiFailure({ status: 400, error: raw })).toBe("Enter a name.");
    expect(friendlyValidationText("Plain message")).toBe("Plain message");
    expect(friendlyValidationText("[not json")).toBe("[not json");
  });
});

describe("errorText", () => {
  const table: Array<[string, unknown, string | undefined, string]> = [
    ["plain error", new Error("Sentinel changed."), "fb", "Sentinel changed."],
    ["string input", "Bad thing", "fb", "Bad thing"],
    ["non-error uses fallback", { weird: true }, "fb", "fb"],
    ["null uses default", null, undefined, "Something went wrong. Try again."],
    ["empty message uses fallback", new Error(" "), "fb", "fb"],
    ["backend code mapped", new ApiError("x", 403, "owner_required"), "fb", "x"],
    ["raw code in text mapped", new Error("approval_required"), "fb", API_ERROR_MESSAGES.approval_required!],
    ["model disabled text mapped", new Error("model_disabled: gpt"), "fb", API_ERROR_MESSAGES.model_disabled!],
    ["zod JSON made readable", new Error(JSON.stringify([{ code: "too_small", minimum: 1, path: ["name"], message: "Too small" }])), "fb", "Enter a name."],
    ["raw url hidden", new Error("https://example.com/api/x"), "fb", "fb"],
    ["html hidden", new Error("<!doctype html><html>"), "fb", "fb"],
    ["fetch failure is Reconnecting", new TypeError("Failed to fetch"), "fb", "Connection interrupted. Reconnecting…"],
    ["502 ApiError is Reconnecting", new ApiError("502 Bad Gateway", 502), "fb", "Connection interrupted. Reconnecting…"],
    ["non-json is Reconnecting", new NonJsonResponseError("html"), "fb", "Connection interrupted. Reconnecting…"],
  ];
  it.each(table)("%s", (_name, input, fallback, expected) => {
    expect(errorText(input, fallback)).toBe(expected);
  });
});
