#!/usr/bin/env node
// Entry point. `--version` and root `--help` are answered here from `@0/engine/shared`
// and the static command manifest, before the engine, settings, telemetry and every
// command module are loaded. Everything else continues in main.ts.
import "./apply-env-aliases.js";
import { VERSION } from "@0/engine/shared";

const args = process.argv.slice(2);
const only = args.length === 1 ? args[0] : undefined;
if (only === "--version" || only === "-V") {
  process.stdout.write(`${VERSION}\n`);
} else if (only === "--help" || only === "-h" || only === "help") {
  const { createRootProgram, addCommandStubs } = await import("./program.js");
  const program = createRootProgram();
  addCommandStubs(program);
  program.outputHelp();
} else {
  await import("./main.js");
}
