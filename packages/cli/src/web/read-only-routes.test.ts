import { describe, expect, it } from "vitest";
import { ENGINE_ALLOWED_MUTATIONS, READ_ONLY_CONSOLE_ROUTES, privilegedRouteDenial } from "./privileged-routes.js";

describe("read-only console routes", () => {
  it("are justified, readable by engines and not mutable", () => {
    for (const route of READ_ONLY_CONSOLE_ROUTES) {
      expect(route.why.length).toBeGreaterThan(20);
      expect(privilegedRouteDenial(`/api/console/${route.path}`, "GET", { engineRequest: true, teamEnabled: false })).toBeNull();
      expect(privilegedRouteDenial(`/api/console/${route.path}`, "POST", { engineRequest: true, teamEnabled: false })).toMatchObject({ status: 403 });
      expect(ENGINE_ALLOWED_MUTATIONS.some(entry => entry.pattern.test(route.path))).toBe(false);
    }
    expect(READ_ONLY_CONSOLE_ROUTES.map(route => route.path)).toEqual(expect.arrayContaining(["repositories", "audit-log"]));
  });
});
