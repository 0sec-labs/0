import { describe, expect, it } from "vitest";
import { evaluateBeforeCommand, type BeforeCommandInput, type BeforeCommandPolicy } from "./before-command.js";

const input: BeforeCommandInput = { kind: "bash", command: "echo hi", argv: ["echo", "hi"], cwd: "/w", hosts: [], paths: [], thread: {} };
const fake = (id: string, run: BeforeCommandPolicy["evaluate"]): BeforeCommandPolicy => ({ id, evaluate: run });
const allow = (id: string) => fake(id, () => ({ decision: "allow" }));
const ask = (id: string) => fake(id, () => ({ decision: "ask", reason: `${id} asks` }));
const deny = (id: string) => fake(id, () => ({ decision: "deny", reason: `${id} denies` }));

describe("beforeCommand decision pipeline", () => {
  it("allows when there are no deciders or all allow", async () => {
    expect((await evaluateBeforeCommand(input, [])).decision).toBe("allow");
    expect((await evaluateBeforeCommand(input, [allow("a"), allow("b")])).decision).toBe("allow");
  });

  it("ask beats allow, and deny beats ask regardless of order", async () => {
    expect((await evaluateBeforeCommand(input, [allow("a"), ask("b")])).decision).toBe("ask");
    for (const order of [[ask("a"), deny("b")], [deny("b"), ask("a")]]) {
      const outcome = await evaluateBeforeCommand(input, order);
      expect(outcome.decision).toBe("deny");
      expect(outcome.reason).toBe("b denies");
      expect(outcome.asks.map(item => item.policyId)).toEqual(["a"]);
    }
  });

  it("denies when a decider throws, rejects, times out or answers nonsense", async () => {
    const throwing = fake("throws", () => { throw new Error("boom"); });
    const rejecting = fake("rejects", async () => { throw new Error("nope"); });
    const hanging = fake("hangs", () => new Promise(() => {}));
    const invalid = fake("invalid", () => ({ decision: "maybe" }) as never);
    for (const policy of [throwing, rejecting, invalid]) {
      const outcome = await evaluateBeforeCommand(input, [allow("ok"), policy]);
      expect(outcome.decision).toBe("deny");
      expect(outcome.denies[0].policyId).toBe(policy.id);
    }
    const timedOut = await evaluateBeforeCommand(input, [allow("ok"), hanging], 20);
    expect(timedOut.decision).toBe("deny");
    expect(timedOut.reason).toContain("timed out");
  });
});
