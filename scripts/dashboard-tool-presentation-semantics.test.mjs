import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
test("tool receipts present actual commands/source/output with separate transport diagnostics", async () => {
  const directory = await mkdtemp(resolve(root, "packages/dashboard/.tool-presentation-semantics-"));
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ entryPoints: [resolve(root, "packages/dashboard/src/console/tool-presentation.ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const { presentToolCall, toolPresentationText } = await import(pathToFileURL(output).href);
    const call = (name, args, result) => ({ id: "a", name, arguments: args, result, isRunning: false });
    const bash = presentToolCall(call("bash", { command: "rg auth src", cwd: "/fixture" }, { success: true, output: "src/auth.ts:7: validate()", meta: { kind: "command", command: "rg auth src", stdout: "src/auth.ts:7: validate()", exitCode: 0, durationMs: 12 } }));
    assert.equal(bash.title, "rg auth src"); assert.equal(bash.command, "rg auth src");
    assert.equal(bash.output, "src/auth.ts:7: validate()"); assert.equal(bash.outputKind, "terminal");
    assert.deepEqual(bash.metadata, [{ label: "Exit code", value: "0" }, { label: "Duration", value: "12 ms" }, { label: "Working directory", value: "/fixture" }]);
    assert.doesNotMatch(bash.output, /success|stdout|durationMs/); assert.match(bash.rawResult, /durationMs/);
    const timedOut = presentToolCall(call("bash", { command: "long-task" }, { success: false, output: null, error: "Timed out", meta: { kind: "command", stdout: "Partial output", exitCode: null, timedOut: true } }));
    assert.equal(timedOut.output, "Partial output\nTimed out"); assert.equal(timedOut.status, "Error");
    assert.deepEqual(timedOut.metadata, [{ label: "Timed out", value: "true" }]);
    const code = presentToolCall(call("python_eval", { code: "print(2)" }, { success: true, output: "2\n", meta: { kind: "code", language: "python", code: "print(2)", output: "2\n", exitCode: 0 } }));
    assert.equal(code.source, "print(2)"); assert.equal(code.language, "python"); assert.equal(code.output, "2\n");
    const python = presentToolCall(call("python_exec", { code: "compute()" }, { success: false, output: { stdout: "Started", stderr: "Traceback" }, error: "ValueError" }));
    assert.equal(python.output, "Started\nTraceback\nValueError");
    const read = presentToolCall(call("read_file", { path: "src/auth.ts", offset: 7 }, { success: true, output: { content: "validate()", startLine: 7, endLine: 7, totalLines: 20, truncated: true, nextOffset: 8 } }));
    assert.equal(read.title, "Read src/auth.ts"); assert.equal(read.output, "validate()"); assert.equal(read.outputKind, "text");
    assert.ok(read.metadata.some(item => item.label === "Lines" && item.value === "7–7"));
    const search = presentToolCall(call("search_files", { query: "auth", path: "src" }, { success: true, output: { matches: [{ path: "auth.ts", line: 7, content: "validate()" }], scannedFiles: 4 } }));
    assert.equal(search.output, "auth.ts:7: validate()"); assert.equal(search.source, "auth");
    const encoded = presentToolCall(call("bash", { command: "false" }, JSON.stringify({ success: true, output: { success: false, output: { stdout: "", stderr: "No match", exitCode: 1 } } })));
    assert.equal(encoded.output, "No match"); assert.equal(encoded.status, "Error");
    const unknown = { schema: "custom", result: { keep: true } };
    assert.deepEqual(JSON.parse(presentToolCall(call("custom_tool", {}, unknown)).output), unknown, "unknown structures stay intact");
    assert.equal(presentToolCall(call("bash", { command: "printf error" }, "error")).status, "Done", "arbitrary output never fabricates an execution error");
    assert.doesNotMatch(toolPresentationText({ imageBase64: "secretbytes", content: [{ type: "image", data: "otherbytes" }], url: "data:image/png;base64,morebytes" }), /secretbytes|otherbytes|morebytes/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
