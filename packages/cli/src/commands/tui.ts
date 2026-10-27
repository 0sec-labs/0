import type { Command } from "commander";

/** Compatibility entrypoint; interactive terminal rendering has been retired. */
export function registerTuiCommand(program: Command): void {
  program.command("tui", { hidden: true }).alias("watch")
    .description("Retired terminal UI; use 0 web for interactive work")
    .action(() => {
      console.error("The terminal UI has been removed. Run 0 web to open the browser console at http://127.0.0.1:48123, or use 0 chat --prompt for scripts.");
      process.exitCode = 2;
    });
}
