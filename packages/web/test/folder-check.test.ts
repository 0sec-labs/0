import { describe, expect, it } from "vitest";
import { folderCheckView, runFolderCheck, type FolderCheckReply } from "@/console/folder-check";
import { isPrivacyMessage } from "@/console/workspace-path";

const reply = (state: FolderCheckReply["state"], extra: Partial<FolderCheckReply> = {}): FolderCheckReply => ({ state, path: "/Users/a/Documents/x", folder: "Documents", ...extra });

function run(replies: FolderCheckReply[]) {
  const seen: FolderCheckReply[] = [];
  const requests: Array<{ path: string; retry: boolean }> = [];
  const controller = new AbortController();
  const promise = runFolderCheck("/Users/a/Documents/x", {
    signal: controller.signal,
    sleep: async () => undefined,
    request: async (input) => { requests.push(input); return replies.shift() ?? reply("error"); },
    onState: (value) => seen.push(value),
  });
  return { promise, seen, requests, controller };
}

describe("folder check polling", () => {
  it("shows checking, then waiting for macOS, then accepts", async () => {
    const { promise, seen, requests } = run([reply("checking"), reply("waiting"), reply("waiting"), reply("allowed")]);
    expect((await promise)?.state).toBe("allowed");
    expect(seen.map((value) => value.state)).toEqual(["checking", "waiting", "waiting", "allowed"]);
    expect(requests.map((value) => value.retry)).toEqual([true, false, false, false]);
  });

  it("stops on a refusal and on the 60 s timeout, both retryable", async () => {
    expect((await run([reply("waiting"), reply("blocked", { message: "macOS is blocking access to Documents." })]).promise)?.state).toBe("blocked");
    const timeout = await run([reply("waiting"), reply("timeout", { message: "macOS is still waiting for your answer" })]).promise;
    expect(timeout?.state).toBe("timeout");
    expect(folderCheckView(timeout!).retry).toBe(true);
  });

  it("returns null when cancelled, and treats a missing endpoint as allowed", async () => {
    const cancelled = run([reply("waiting")]);
    cancelled.controller.abort();
    expect(await cancelled.promise).toBeNull();
    const failing = await runFolderCheck("/x", { signal: new AbortController().signal, request: async () => { throw new Error("404"); }, onState: () => undefined });
    expect(failing?.state).toBe("allowed");
  });

  it("a second attempt starts fresh with retry", async () => {
    const first = run([reply("timeout")]);
    await first.promise;
    const second = run([reply("allowed")]);
    expect((await second.promise)?.state).toBe("allowed");
    expect(second.requests[0]).toEqual({ path: "/Users/a/Documents/x", retry: true });
  });
});

describe("folder check view", () => {
  it("keeps the picker pending only while checking or waiting", () => {
    expect(folderCheckView(reply("checking"))).toMatchObject({ pending: true, text: "Checking the folder…" });
    expect(folderCheckView(reply("waiting"))).toMatchObject({ pending: true, text: expect.stringContaining("Waiting for macOS") });
    expect(folderCheckView(reply("allowed"))).toMatchObject({ pending: false, text: null });
    expect(folderCheckView(reply("blocked", { message: "macOS is blocking access to Documents." }))).toMatchObject({ pending: false, tone: "error", retry: false });
    expect(folderCheckView(reply("timeout"))).toMatchObject({ pending: false, tone: "error", retry: true });
  });

  it("recognises every server wording that deserves the Privacy settings button", () => {
    expect(isPrivacyMessage("macOS blocked access to app. Allow Terminal under ...")).toBe(true);
    expect(isPrivacyMessage("macOS can only ask on the Mac's screen, ...")).toBe(true);
    expect(isPrivacyMessage("Waiting for macOS: click Allow")).toBe(false);
  });
});
