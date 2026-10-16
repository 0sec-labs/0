import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertSmolvmAdmissionAvailable } from "./smolvm-admission-preflight.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const state = await mkdtemp("/tmp/0-admission-test-");
  const run = await mkdtemp("/tmp/0w-");
  roots.push(state, run);
  const lease = JSON.stringify({ root: run, token: "a".repeat(64) });
  return { state, run, lease };
}
it("allows an unreserved workspace", async () => {
  const { state } = await fixture();
  await expect(assertSmolvmAdmissionAvailable(state)).resolves.toBeUndefined();
});
it("rejects a busy workspace early without deleting its lease or run", async () => {
  const { state, run, lease } = await fixture();
  await writeFile(join(state, "active-run.json"), lease);
  await writeFile(join(run, "marker"), "owned");
  await expect(assertSmolvmAdmissionAvailable(state)).rejects.toThrow("Another chat");
  expect(await readFile(join(state, "active-run.json"), "utf8")).toBe(lease);
  expect(await readFile(join(run, "marker"), "utf8")).toBe("owned");
});
it("leaves completed reservations for recovery under the native lock", async () => {
  const { state, run, lease } = await fixture();
  await writeFile(join(state, "active-run.json"), lease);
  await writeFile(join(run, "complete.json"), JSON.stringify({ schemaVersion: 1, cleanupFailed: false }));
  await expect(assertSmolvmAdmissionAvailable(state)).resolves.toBeUndefined();
  expect(await readFile(join(state, "active-run.json"), "utf8")).toBe(lease);
});
it("refuses retained teardown failures and malformed admission records", async () => {
  const { state, run, lease } = await fixture();
  await writeFile(join(state, "active-run.json"), lease);
  await writeFile(join(run, "complete.json"), JSON.stringify({ schemaVersion: 1, cleanupFailed: true }));
  await expect(assertSmolvmAdmissionAvailable(state)).rejects.toThrow("unconfirmed");
  await writeFile(join(state, "active-run.json"), JSON.stringify({ root: "/etc", token: "a".repeat(64) }));
  await expect(assertSmolvmAdmissionAvailable(state)).rejects.toThrow("Invalid retained");
});
