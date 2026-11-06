import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const dashboard = fileURLToPath(new URL("../packages/dashboard/", import.meta.url));
test("external-agent setup discovers the CLI before optional MCP and preserves authorization boundaries", async () => {
  const directory = await mkdtemp(resolve(dashboard, ".agent-onboarding-test-"));
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ entryPoints: [resolve(dashboard, "src/console/agent-onboarding.tsx")], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", alias: { "@": resolve(dashboard, "src") }, loader: { ".svg": "dataurl" }, logLevel: "silent" });
    const { setupPrompt } = await import(pathToFileURL(output).href);
    assert.match(setupPrompt, /^Help me use 0\.security for my task/);
    const cli = setupPrompt.indexOf("0 --help");
    const mcp = setupPrompt.indexOf("0 mcp-server --help");
    assert.ok(cli >= 0 && mcp > cli, "CLI discovery precedes any MCP configuration");
    for (const command of ["0 --version", "0 doctor", "0 workbench status --json", "0 web --help", "0 api --help", "0 workflow list --help", "0 workflow show --help", "0 workflow run --help"]) assert.ok(setupPrompt.includes(command), command);
    for (const page of ["/onboarding", "/connections", "/models"]) assert.ok(setupPrompt.includes(page));
    assert.match(setupPrompt, /I complete OAuth\/browser or device approval myself/);
    assert.match(setupPrompt, /Never request or expose keys, tokens, or credential files in chat/);
    assert.match(setupPrompt, /Preserve client integrations, model connections, workspace grants, and execution profiles/);
    assert.match(setupPrompt, /never disable the workbench or switch SmolVM to host execution automatically/);
    assert.match(setupPrompt, /Setup and discovery do not authorize assessments, workflow runs, live-target requests, or patch application/);
    assert.match(setupPrompt, /Remote workspace, scope, model, and apply permissions belong to that engine/);
    assert.match(setupPrompt, /omit local workspace\/scope\/db-path flags/);
    assert.match(setupPrompt, /verify discovery without launching work/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
