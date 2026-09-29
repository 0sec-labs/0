import React, { useEffect } from "react";
import type * as CoreTesting from "@opentui/core/testing";
import { createRoot, flushSync, useKeyboard } from "@opentui/react";
import { expect, test, vi } from "vitest";

// The dedicated TUI config runs files in isolated, serial forks. Import this
// opt-in module after setting its launcher environment to exercise the actual
// cross-generation ABI rather than a second implementation in the test.
test("frontend remount retains transcript/draft, rebinds old gate callbacks and removes old input handlers", async () => {
  const priorWatch = process.env["ZERO_DEV_UI_WATCH"];
  const priorRoot = process.env["ZERO_DEV_SOURCE_ROOT"];
  process.env["ZERO_DEV_UI_WATCH"] = "1";
  process.env["ZERO_DEV_SOURCE_ROOT"] = process.cwd();
  const { bindDevUiDiagnostics, DevUiHost, DevUiRenderBoundary, isDevUiRemount, remountDevUi, useDevUiBoundary, useDevUiState } = await import("../src/dev-ui-reload.js");
  // Vitest's SSR resolver otherwise chooses node testing.js while the external
  // React renderer running under Bun uses bun core, duplicating native classes.
  const testingEntry = new URL(process.versions.bun ? "./testing.bun.js" : "./testing.js", import.meta.resolve("@opentui/core"));
  const { createTestRenderer } = await import(testingEntry.href) as typeof CoreTesting;
  const setup = await createTestRenderer({ width: 120, height: 5 });
  const root = createRoot(setup.renderer);
  let retired = false;
  let requestGate: ((question: string) => void) | undefined;
  let updateView: ((node: React.ReactNode) => void) | undefined;
  const diagnostics: string[] = [];
  const originalError = vi.spyOn(console, "error").mockImplementation((...details: unknown[]) => { diagnostics.push(details.map(String).join(" ")); });
  const originalWarn = vi.spyOn(console, "warn").mockImplementation((...details: unknown[]) => { diagnostics.push(details.map(String).join(" ")); });
  function Screen({ generation }: { generation: string }) {
    const boundary = useDevUiBoundary("regression-audit");
    const [transcript, setTranscript] = useDevUiState<string[]>(boundary, "transcript", []);
    const [draft, setDraft] = useDevUiState(boundary, "draft", "");
    const [gate, setGate] = useDevUiState(boundary, "gate", "");
    requestGate ??= question => setGate(question);
    useKeyboard(key => {
      if (key.name === "return") {
        setTranscript(previous => [...previous, draft]);
        setDraft("");
      } else if (key.sequence) setDraft(previous => previous + key.sequence);
    });
    useEffect(() => () => { if (!isDevUiRemount()) retired = true; }, []);
    return React.createElement("text", null, `${generation} transcript=${transcript.join("|")} draft=${draft} gate=${gate}`);
  }
  // Integration exception: OpenTUI's native/React scheduler commits input
  // subscriptions on real macrotasks; fake timers cannot drive that scheduler.
  const settle = async () => {
    for (let round = 0; round < 2; round++) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      await setup.flush();
    }
  };
  try {
    bindDevUiDiagnostics(() => root.render(React.createElement(DevUiHost, {
      initial: React.createElement(Screen, { generation: "old", key: "old" }),
      onReady: update => { updateView = update; },
    })));
    await settle();
    setup.mockInput.typeText("history");
    await settle();
    setup.mockInput.pressEnter();
    await settle();
    setup.mockInput.typeText("draft");
    await settle();
    const oldGateCallback = requestGate!;
    await remountDevUi(async () => {
      flushSync(() => updateView!(React.createElement(Screen, { generation: "new", key: "new" })));
      await settle();
    });
    expect(setup.captureCharFrame()).toContain("new transcript=history draft=draft");
    expect(retired).toBe(false);
    // A native engine retains this old closure; it must target the new view.
    oldGateCallback("review tool");
    await settle();
    expect(setup.captureCharFrame()).toContain("gate=review tool");
    setup.mockInput.typeText("x");
    await settle();
    expect(setup.captureCharFrame()).toContain("draft=draftx gate=review tool");
    const credential = "synthetic-api-key-do-not-log";
    function Rejected() { throw new Error(`provider credential=${credential}`); }
    const rejected = remountDevUi(async () => {
      let failure: unknown;
      try {
        flushSync(() => updateView!(React.createElement(DevUiRenderBoundary, {
          key: "rejected", onFailure: error => { failure = error; },
          children: React.createElement(Rejected),
        })));
        await settle();
        if (failure) throw failure;
      } catch (error) {
        flushSync(() => updateView!(React.createElement(Screen, { generation: "new", key: "rollback" })));
        await settle();
        throw error;
      }
    });
    await expect(rejected).rejects.toBeInstanceOf(Error);
    expect(setup.captureCharFrame()).toContain("new transcript=history draft=draftx gate=review tool");
    expect(diagnostics.join("\n")).not.toContain(credential);
    expect(diagnostics.some(line => line.includes("UI render diagnostic"))).toBe(true);
    expect(console.error).toBe(originalError);
    expect(console.warn).toBe(originalWarn);
    setup.mockInput.typeText("y");
    await settle();
    expect(setup.captureCharFrame()).toContain("draft=draftxy gate=review tool");
    expect(retired).toBe(false);
  } finally {
    root.unmount();
    await settle();
    setup.renderer.destroy();
    originalError.mockRestore();
    originalWarn.mockRestore();
    if (priorWatch === undefined) delete process.env["ZERO_DEV_UI_WATCH"];
    else process.env["ZERO_DEV_UI_WATCH"] = priorWatch;
    if (priorRoot === undefined) delete process.env["ZERO_DEV_SOURCE_ROOT"];
    else process.env["ZERO_DEV_SOURCE_ROOT"] = priorRoot;
  }
  expect(retired).toBe(true);
});
