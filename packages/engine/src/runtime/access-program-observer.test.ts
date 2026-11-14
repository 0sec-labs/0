import { expect, it } from "vitest";
import { accessProgramObserver } from "./access-program-observer.js";

it("keeps missing, invalid and mismatched provider observations unknown", () => {
  const access = accessProgramObserver("daybreak_blue");
  expect(access.metadata()).toEqual({ requested: "daybreak_blue" });
  access.observe({ requested: "daybreak_blue", confirmed: "standard" });
  expect(access.metadata()).toEqual({ requested: "daybreak_blue", confirmed: "standard" });
  access.observe({ requested: "daybreak_blue" });
  expect(access.metadata()).toEqual({ requested: "daybreak_blue" });
  access.observe({ requested: "daybreak_red", confirmed: "daybreak_red" });
  expect(access.metadata()).toEqual({ requested: "daybreak_blue" });
  access.observe({ requested: "daybreak_blue", confirmed: "entitled" as never });
  expect(access.metadata()).toEqual({ requested: "daybreak_blue" });
});
