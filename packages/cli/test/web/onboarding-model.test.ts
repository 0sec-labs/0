import { expect, test } from "vitest";
import { chooseOnboardingModel } from "../../../dashboard/src/components/console-control/onboarding-model";
test("setup retains this provider's model and never borrows another account's preference", () => {
  expect(chooseOnboardingModel("codex", { providerId: "codex", model: "current-account-model" }, { providerId: "codex", model: "preferred" }, [{ id: "catalog" }])).toBe("current-account-model");
  expect(chooseOnboardingModel("codex", { providerId: "other", model: "other-model" }, { providerId: "codex", model: "preferred" }, [{ id: "catalog" }])).toBe("preferred");
  expect(chooseOnboardingModel("codex", null, { providerId: "other", model: "wrong-provider" }, [{ id: "" }, { id: "account-default" }])).toBe("account-default");
  expect(chooseOnboardingModel("codex", null, null)).toBe("");
});
