import { describe, expect, it } from "vitest";

import {
  POPUP_STACK_BASE,
  POPUP_STACK_STEP,
  popupStackReducer,
  type PopupStackAction,
} from "./popup-stack.js";

/**
 * The popup stack is a pure reducer plus a thin `useReducer` provider; the
 * interactive "only the top layer responds to Esc" proof lives in the TUI
 * self-test (`test/tui-driver/scenarios/nested-popups.tui.test.ts`), which
 * drives a real render. These guard the transition logic: push appends, pop
 * peels one level (or a level and its children by id), and replace swaps in
 * place — the operations the settings confirm and PanePalette rely on.
 */

const render = () => null;

function run(actions: PopupStackAction[]) {
  return actions.reduce((stack, action) => popupStackReducer(stack, action), [] as ReturnType<typeof popupStackReducer>);
}

describe("popupStackReducer", () => {
  it("push appends a top entry and preserves order (depth = length)", () => {
    const stack = run([
      { type: "push", id: "a", render },
      { type: "push", id: "b", render },
    ]);
    expect(stack.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("pop with no id removes only the top entry", () => {
    const stack = run([
      { type: "push", id: "a", render },
      { type: "push", id: "b", render },
      { type: "pop" },
    ]);
    expect(stack.map((e) => e.id)).toEqual(["a"]);
  });

  it("pop by id removes that entry AND everything above it", () => {
    const stack = run([
      { type: "push", id: "a", render },
      { type: "push", id: "b", render },
      { type: "push", id: "c", render },
      { type: "pop", id: "b" },
    ]);
    expect(stack.map((e) => e.id)).toEqual(["a"]);
  });

  it("pop of a missing id, or of an empty stack, is a no-op", () => {
    expect(popupStackReducer([], { type: "pop" })).toEqual([]);
    const stack = run([
      { type: "push", id: "a", render },
      { type: "pop", id: "missing" },
    ]);
    expect(stack.map((e) => e.id)).toEqual(["a"]);
  });

  it("replace swaps a render in place without moving it", () => {
    const first = () => null;
    const second = () => null;
    const stack = run([
      { type: "push", id: "a", render: first },
      { type: "push", id: "b", render: first },
      { type: "replace", id: "a", render: second },
    ]);
    expect(stack.map((e) => e.id)).toEqual(["a", "b"]);
    expect(stack[0].render).toBe(second);
    expect(stack[1].render).toBe(first);
  });

  it("replace of a missing id is a no-op", () => {
    const stack = run([
      { type: "push", id: "a", render },
      { type: "replace", id: "missing", render: () => null },
    ]);
    expect(stack.map((e) => e.id)).toEqual(["a"]);
  });

  it("does not mutate the input stack", () => {
    const initial = run([{ type: "push", id: "a", render }]);
    const snapshot = [...initial];
    popupStackReducer(initial, { type: "push", id: "b", render });
    popupStackReducer(initial, { type: "pop" });
    expect(initial).toEqual(snapshot);
  });

  it("keeps the z-index bands above the level-0 overlays", () => {
    // The bottom stacked popup floats over the DialogSurface/onboarding (100)
    // and the shutdown dialog (200); each level adds a fixed step.
    expect(POPUP_STACK_BASE).toBeGreaterThan(200);
    expect(POPUP_STACK_BASE + POPUP_STACK_STEP).toBeGreaterThan(POPUP_STACK_BASE);
  });
});
