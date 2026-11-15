import { describe, expect, it } from "vitest";
import { deliveryLine, deliveryReason, statusLine, webhookVisible } from "./github-webhook-model";

describe("github webhook card model", () => {
  it("is visible only in server mode", () => {
    expect(webhookVisible(undefined)).toBe(false);
    expect(webhookVisible({ serverMode: false })).toBe(false);
    expect(webhookVisible({ serverMode: true, configured: false })).toBe(true);
  });
  it("words outcomes without payload content", () => {
    expect(deliveryLine({ at: "t", result: "rejected", reason: "invalid_signature" })).toBe("rejected · wrong signature");
    expect(deliveryLine({ at: "t", result: "received", event: "pull_request", reason: "synchronize:2" })).toBe("received · pull request · synchronize");
    expect(deliveryLine({ at: "t", result: "ignored", event: "push", reason: "event_not_allowed" })).toBe("ignored · push · event not used");
    expect(deliveryReason({ at: "t", result: "ignored" })).toBe("");
  });
  it("summarises the last delivery", () => {
    expect(statusLine({ serverMode: true }, () => "x")).toBe("No deliveries yet. Polling still works.");
    expect(statusLine({ serverMode: true, lastDeliveryAt: "t", lastResult: "rejected", lastReason: "invalid_signature" }, () => "2 minutes ago")).toBe("Last delivery 2 minutes ago: rejected (wrong signature)");
  });
});
