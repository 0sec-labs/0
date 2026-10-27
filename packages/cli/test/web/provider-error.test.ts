import { expect, test } from "vitest";
import { consoleErrorMessage, needsModelSourceReconnect, needsProviderSignIn } from "../../../dashboard/src/console/provider-error";
import { errorProvider } from "../../../dashboard/src/console/connection-recovery";

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
  expect(consoleErrorMessage("ChatGPT request timed out")).toBe("ChatGPT request timed out");
  expect(needsProviderSignIn("ChatGPT request timed out")).toBe(false);
});
