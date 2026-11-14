import { expect, test } from "vitest";
import { accessProgramChange, accessProgramOptions, accessProgramStatus } from "../src/console/access-program-control";
import type { ConsoleAccessProgramConfiguration } from "@0/engine/shared";
const automatic: ConsoleAccessProgramConfiguration = { requested: null, options: ["standard", "daybreak_blue", "daybreak_red"] };

test("cyber choices are independent of model aliases and expose only server-supported request options", () => {
  expect(accessProgramOptions({ ...automatic, options: ["daybreak_blue"] })).toEqual([
    { value: "automatic", label: "Automatic" }, { value: "daybreak_blue", label: "Daybreak Blue" },
  ]);
  expect(accessProgramChange(automatic, "automatic")).toBeNull();
  expect(accessProgramChange(automatic, "daybreak_blue")).toBe("daybreak_blue");
  expect(accessProgramChange({ ...automatic, options: [] }, "daybreak_blue")).toBeUndefined();
  expect(accessProgramChange(automatic, "gpt-daybreak-blue-latest")).toBeUndefined();
});

test("a persisted unsupported request remains visible and can only be explicitly cleared", () => {
  const unsupported = { requested: "daybreak_blue" as const, options: [], unavailableReason: "Unsupported connection" };
  expect(accessProgramOptions(unsupported)).toEqual([{ value: "automatic", label: "Automatic" }, { value: "daybreak_blue", label: "Daybreak Blue", disabled: true }]);
  expect(accessProgramChange(unsupported, "daybreak_blue")).toBeUndefined();
  expect(accessProgramChange(unsupported, "automatic")).toBeNull();
});


test("requesting Daybreak never fabricates provider confirmation", () => {
  expect(accessProgramStatus(automatic)).toBe("");
  expect(accessProgramStatus({ ...automatic, requested: "daybreak_blue" })).toBe("Requested");
  expect(accessProgramStatus({ ...automatic, requested: "daybreak_blue", confirmed: "standard" })).toBe("Requested · Last provider response: Standard");
  expect(accessProgramStatus({ ...automatic, requested: "daybreak_blue", confirmed: "daybreak_blue" })).toBe("Requested · Last provider response: Daybreak Blue");
});
