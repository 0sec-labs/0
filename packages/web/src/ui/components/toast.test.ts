import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, dismiss, MAX_VISIBLE_TOASTS, pauseToast, resumeToast, toast, TOAST_EXIT_MS } from "./toast";
import { noticeToToast } from "@/components/app-notice";

import * as mod from "./toast";

beforeEach(() => { vi.useFakeTimers(); clearToasts(); });
afterEach(() => { clearToasts(); vi.useRealTimers(); });

function state() {
  return mod.getToasts().filter(item => !item.leaving);
}

describe("toast store", () => {
  it("dedupes by id and updates in place", () => {
    toast({ id: "a", title: "one" }); toast({ id: "a", title: "two" });
    expect(state().map(item => item.title)).toEqual(["two"]);
  });
  it("keeps at most three, dropping the oldest silently", () => {
    const onDismiss = vi.fn();
    toast({ id: "1", title: "1", onDismiss }); toast({ id: "2", title: "2" }); toast({ id: "3", title: "3" }); toast({ id: "4", title: "4" });
    expect(state().map(item => item.id)).toEqual(["2", "3", "4"]);
    expect(state().length).toBeLessThanOrEqual(MAX_VISIBLE_TOASTS);
    expect(onDismiss).not.toHaveBeenCalled();
  });
  it("auto-dismisses after 5s, errors after 8s, persistent at 0", () => {
    toast({ id: "i", title: "i" }); toast({ id: "e", title: "e", kind: "error" }); toast({ id: "p", title: "p", durationMs: 0 });
    vi.advanceTimersByTime(5000 + TOAST_EXIT_MS);
    expect(state().map(item => item.id)).toEqual(["e", "p"]);
    vi.advanceTimersByTime(3000 + TOAST_EXIT_MS);
    expect(state().map(item => item.id)).toEqual(["p"]);
  });
  it("pauses on hover and resumes with the remaining time", () => {
    toast({ id: "a", title: "a" });
    vi.advanceTimersByTime(3000); pauseToast("a");
    vi.advanceTimersByTime(60_000);
    expect(state()).toHaveLength(1);
    resumeToast("a"); vi.advanceTimersByTime(1999); expect(state()).toHaveLength(1);
    vi.advanceTimersByTime(1 + TOAST_EXIT_MS); expect(state()).toHaveLength(0);
  });
  it("runs onDismiss for user dismissal but not silent dismissal", () => {
    const user = vi.fn(), silent = vi.fn();
    toast({ id: "u", title: "u", onDismiss: user }); toast({ id: "s", title: "s", onDismiss: silent });
    dismiss("u"); dismiss("s", { silent: true });
    expect(user).toHaveBeenCalledTimes(1); expect(silent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TOAST_EXIT_MS); expect(state()).toHaveLength(0);
  });
});

describe("AppNotice mapping", () => {
  it("maps errors and status notices", () => {
    const onDismiss = () => {};
    expect(noticeToToast({ id: "x", message: "boom", onDismiss })).toMatchObject({ id: "notice:x", title: "boom", kind: "error", onDismiss });
    expect(noticeToToast({ id: "y", message: "ok", kind: "status", action: { label: "Go", href: "/a" } })).toMatchObject({ kind: "info", action: { label: "Go", href: "/a" } });
  });
});
