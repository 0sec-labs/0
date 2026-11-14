import { describe, expect, it } from "vitest";
import { accountDisplayName, disconnectCopy, newAccountId } from "./connection-model";
describe("connection model", () => {
  it("names the account", () => {
    expect(accountDisplayName("OpenAI", "Work key", "work")).toBe("OpenAI (Work key)");
    expect(accountDisplayName("OpenAI", undefined, "default")).toBe("OpenAI (default)");
    expect(accountDisplayName("OpenAI", "OpenAI", "x")).toBe("OpenAI");
  });
  it("says what is removed", () => {
    const text = disconnectCopy("openai", "OpenAI (Work)", "this Mac", 3);
    expect(text).toContain("saved credentials");
    expect(text).toContain("model on/off switches");
    expect(text).toContain("Your other accounts");
  });
  it("makes unique account ids", () => {
    expect(newAccountId("Work key", ["default"])).toBe("work-key");
    expect(newAccountId("Work key", ["default", "work-key"])).toBe("work-key-2");
    expect(newAccountId("  ", [])).toBe("account");
    expect(newAccountId("default", ["default"])).toBe("default-2");
  });
});
