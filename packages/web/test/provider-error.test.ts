import { expect, test } from "vitest";
import { classifyRunError, consoleErrorMessage, needsModelSourceReconnect, needsProviderSignIn } from "../src/console/provider-error";
import { errorProvider } from "../src/console/connection-recovery";

test("remote relay expiry is a model-source failure, not an expired ChatGPT login", () => {
  const message = "ChatGPT (Codex backend) API error: ChatGPT (Codex backend) transport failure [unknown]: Provider relay grant expired. Reconnect the local model source.";
  expect(needsModelSourceReconnect(message)).toBe(true);
  expect(needsProviderSignIn(message)).toBe(false);
  expect(errorProvider(message, "chatgpt-codex")).toBeUndefined();
  expect(consoleErrorMessage(message)).toContain("Reconnect");
  expect(consoleErrorMessage(message)).not.toMatch(/sign in/i);
});

test("actual authentication failures retain account recovery while transport faults do not", () => {
  for (const message of ["Codex model discovery failed (HTTP 401)", "ChatGPT OAuth expired", "OpenAI invalid_api_key", "ChatGPT authentication failed"]) {
    expect(needsProviderSignIn(message)).toBe(true);
    expect(needsModelSourceReconnect(message)).toBe(false);
  }
  expect(consoleErrorMessage("ChatGPT request timed out")).toMatch(/took too long/);
  expect(needsProviderSignIn("ChatGPT request timed out")).toBe(false);
});

test("every failure class gets a specific plain message and the right retry rule", () => {
  const cases: Array<[string, string, RegExp, boolean]> = [
    ["Failed to send prompt", "send", /Couldn't send your message.*progress is kept/i, true],
    ["fetch failed: ECONNRESET", "network", /connection to the model dropped/i, true],
    ["request timed out after 60s", "timeout", /took too long/i, true],
    ["HTTP 429 Too Many Requests", "rate-limit", /rate limiting/i, true],
    ["API error: HTTP 503 overloaded", "provider-busy", /busy/i, true],
    ["API error 401 invalid_api_key", "sign-in", /connection needs attention/i, false],
    ["Provider relay grant expired. Reconnect the local model source.", "model-source", /Reconnect/i, false],
    ["model_disabled", "model-disabled", /turned off/i, false],
    ["The model `gpt-9` does not exist (404 model_not_found)", "model-unavailable", /isn't available.*Pick another model/i, false],
    ["maximum context length is 128000 tokens", "context", /longer than the model can read/i, false],
    ["Local scope for tool \"read_file\" is out of scope", "folder", /can't use that folder/i, false],
    ['{"error":{"type":"invalid_request_error"}}', "rejected", /rejected this request/i, true],
    ["Malformed tool arguments for bash", "rejected", /rejected this request/i, true],
  ];
  for (const [raw, kind, message, retryable] of cases) {
    const error = classifyRunError(raw);
    expect([raw, error.kind]).toEqual([raw, kind]);
    expect(error.message).toMatch(message);
    expect(error.retryable).toBe(retryable);
    expect(error.message).not.toContain(raw);
  }
  expect(classifyRunError("This thread is busy with another turn.").kind).toBe("other");
});
