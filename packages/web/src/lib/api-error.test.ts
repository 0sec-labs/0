import { describe, expect, it } from "vitest";
import { consoleErrorMessage, needsModelEnabled } from "@/console/provider-error";
import { API_ERROR_MESSAGES, ApiError, apiErrorFrom, describeApiFailure, isModelDisabledError, mapErrorText } from "./api-error";

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
