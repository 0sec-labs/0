import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const dashboard = fileURLToPath(new URL("../packages/dashboard/", import.meta.url));
test("task progress opens a dedicated checklist and reflects live checkoffs", async () => {
  const directory = await mkdtemp(resolve(dashboard, ".task-progress-test-"));
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ stdin: { contents: `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {TaskProgress,TaskProgressList} from './src/console/task-progress';export const render=(todos,active=true)=>renderToStaticMarkup(React.createElement(TaskProgress,{todos,active}));export const list=(todos,active=true)=>renderToStaticMarkup(React.createElement(TaskProgressList,{todos,active}));`, resolveDir: dashboard, loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", alias: { "@": resolve(dashboard, "src") }, loader: { ".css": "empty" }, logLevel: "silent" });
    const { render, list } = await import(pathToFileURL(output).href);
    const todos = { done: 1, total: 3, todos: [{ id: "a", content: "Map repository", status: "completed" }, { id: "b", content: "Read auth helper", status: "in_progress", group: "Auth boundaries" }, { id: "c", content: "Write report", status: "pending" }] };
    const trigger = render(todos);
    assert.match(trigger, /Open tasks: 1 of 3 complete\. Current task: Read auth helper/);
    assert.doesNotMatch(trigger, /Chat information|Context used|usage and tools/);
    const html = list(todos);
    for (const text of ["Map repository", "Read auth helper", "Write report", "Completed", "In progress", "Pending", "Auth boundaries"]) assert.ok(html.includes(text));
    assert.match(html, /data-task-status="completed"[\s\S]*?line-through/);
    const idle = list(todos, false);
    assert.match(idle, /Not running/);
    assert.doesNotMatch(idle, /In progress|data-active="true"/, "a stale checklist never animates as running after a response ends");
    assert.doesNotMatch(render(todos, false), /Current task:/, "idle chats do not advertise a current task");
    assert.equal(todos.todos[1].status, "in_progress", "display reconciliation preserves the saved checklist instead of inventing completion");
    const updated = { ...todos, done: 2, todos: todos.todos.map(task => task.id === "b" ? { ...task, status: "completed" } : task.id === "c" ? { ...task, status: "in_progress" } : task) };
    assert.match(render(updated), /Open tasks: 2 of 3 complete\. Current task: Write report/);
    assert.equal((list(updated).match(/data-task-status="completed"/g) || []).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
